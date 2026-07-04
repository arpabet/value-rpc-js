/*
 * Copyright (c) 2026 Karagatan LLC.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Conformance harness: a real value-rpc server exposing all four RPC patterns
 * plus reverse (server->client) calls, for the TS client's integration tests.
 * Prints "LISTENING <addr>" once ready; exits on stdin EOF.
 */

package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"go.arpabet.com/value"
	"go.arpabet.com/value-rpc/valuerpc"
	"go.arpabet.com/value-rpc/valueserver"
	"go.uber.org/zap"
)

func main() {
	logger := zap.NewNop()
	if os.Getenv("VRPC_CONFORMANCE_VERBOSE") != "" {
		logger, _ = zap.NewDevelopment()
	}

	addr := os.Getenv("VRPC_ADDR")
	if addr == "" {
		addr = "127.0.0.1:0"
	}
	srv, err := valueserver.NewWebSocketServer(addr, "/rpc", logger)
	if err != nil {
		fmt.Fprintln(os.Stderr, "bind:", err)
		os.Exit(1)
	}

	// Track the most recent connection so "kick" can sever it server-side
	// (exercises reconnect + hash-chain resumption from a real drop).
	var lastConn atomic.Value
	srv.SetConnectAuthorizer(func(conn valuerpc.MsgConn) error {
		lastConn.Store(conn)
		return nil
	})

	// Optional auth: reject any credential that is present and not "secret".
	srv.SetAuthenticator(func(conn valuerpc.MsgConn, credential value.Value) (string, error) {
		if credential == nil || credential.Kind() == value.NULL {
			return "", nil // anonymous ok
		}
		if s, ok := credential.(value.String); ok && s.String() == "secret" {
			return "tester", nil
		}
		return "", fmt.Errorf("bad credential")
	})

	// --- unary ---
	srv.AddFunction("greet", valuerpc.Any, valuerpc.Any, func(ctx context.Context, args value.Value) (value.Value, error) {
		name := "?"
		if l, ok := args.(value.List); ok && l.Len() > 0 {
			name = l.GetAt(0).String()
		}
		return value.Utf8("Hello, " + name + "!"), nil
	})

	srv.AddFunction("add", valuerpc.Any, valuerpc.Any, func(ctx context.Context, args value.Value) (value.Value, error) {
		l := args.(value.List)
		return value.Long(l.GetAt(0).(value.Number).Long() + l.GetAt(1).(value.Number).Long()), nil
	})

	srv.AddFunction("echo", valuerpc.Any, valuerpc.Any, func(ctx context.Context, args value.Value) (value.Value, error) {
		return args, nil
	})

	srv.AddFunction("fail", valuerpc.Any, valuerpc.Any, func(ctx context.Context, args value.Value) (value.Value, error) {
		return nil, valuerpc.NewError(valuerpc.CodeResourceExhausted, "deliberate failure")
	})

	srv.AddFunction("slow", valuerpc.Any, valuerpc.Any, func(ctx context.Context, args value.Value) (value.Value, error) {
		select {
		case <-time.After(5 * time.Second):
			return value.Utf8("late"), nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	})

	srv.AddFunction("md.echo", valuerpc.Any, valuerpc.Any, func(ctx context.Context, args value.Value) (value.Value, error) {
		md := valuerpc.MetadataFromContext(ctx)
		m := make(map[string]value.Value, len(md))
		for k, v := range md {
			m[k] = value.Utf8(v)
		}
		return value.ImmutableMapOf(m), nil
	})

	srv.AddFunction("kick", valuerpc.Any, valuerpc.Any, func(ctx context.Context, args value.Value) (value.Value, error) {
		go func() {
			time.Sleep(50 * time.Millisecond) // let the response flush first
			if c := lastConn.Load(); c != nil {
				c.(valuerpc.MsgConn).Close()
			}
		}()
		return value.Utf8("kicking"), nil
	})

	// --- server -> client stream (client getStream) ---
	srv.AddOutgoingStream("count", valuerpc.Any, func(ctx context.Context, args value.Value) (<-chan value.Value, error) {
		n := int64(0)
		if l, ok := args.(value.List); ok && l.Len() > 0 {
			n = l.GetAt(0).(value.Number).Long()
		}
		out := make(chan value.Value)
		go func() {
			defer close(out)
			for i := int64(1); i <= n; i++ {
				select {
				case out <- value.Long(i):
				case <-ctx.Done():
					return
				}
			}
		}()
		return out, nil
	})

	// --- client -> server stream (client putStream) ---
	var uploaded sync.Map // key "sum" -> *atomic.Int64
	sum := &atomic.Int64{}
	count := &atomic.Int64{}
	uploaded.Store("sum", sum)
	srv.AddIncomingStream("upload", valuerpc.Any, func(ctx context.Context, args value.Value, inC <-chan value.Value) error {
		go func() {
			for v := range inC {
				if n, ok := v.(value.Number); ok {
					sum.Add(n.Long())
					count.Add(1)
				}
			}
		}()
		return nil
	})

	srv.AddFunction("upload.stats", valuerpc.Any, valuerpc.Any, func(ctx context.Context, args value.Value) (value.Value, error) {
		return value.ImmutableMapOf(map[string]value.Value{
			"sum":   value.Long(sum.Load()),
			"count": value.Long(count.Load()),
		}), nil
	})

	// --- bidirectional (client chat): echoes each message prefixed ---
	srv.AddChat("chat.echo", valuerpc.Any, func(ctx context.Context, args value.Value, inC <-chan value.Value) (<-chan value.Value, error) {
		out := make(chan value.Value)
		go func() {
			defer close(out)
			for v := range inC {
				select {
				case out <- value.Utf8("echo:" + v.String()):
				case <-ctx.Done():
					return
				}
			}
		}()
		return out, nil
	})

	// --- reverse calls: exercise the browser-serving side over one hop ---
	srv.AddFunction("reverse.call", valuerpc.Any, valuerpc.Any, func(ctx context.Context, args value.Value) (value.Value, error) {
		peer, ok := valueserver.PeerFromContext(ctx)
		if !ok {
			return nil, valuerpc.NewError(valuerpc.CodeInternal, "no peer")
		}
		return peer.CallFunction(ctx, "notify", args)
	})

	srv.AddFunction("reverse.pull", valuerpc.Any, valuerpc.Any, func(ctx context.Context, args value.Value) (value.Value, error) {
		peer, ok := valueserver.PeerFromContext(ctx)
		if !ok {
			return nil, valuerpc.NewError(valuerpc.CodeInternal, "no peer")
		}
		ch, _, err := peer.GetStream(ctx, "tail", args, 16)
		if err != nil {
			return nil, err
		}
		list := value.EmptyList(true)
		for v := range ch {
			list = list.Append(v)
		}
		return list, nil
	})

	srv.AddFunction("reverse.push", valuerpc.Any, valuerpc.Any, func(ctx context.Context, args value.Value) (value.Value, error) {
		peer, ok := valueserver.PeerFromContext(ctx)
		if !ok {
			return nil, valuerpc.NewError(valuerpc.CodeInternal, "no peer")
		}
		putCh := make(chan value.Value)
		go func() {
			defer close(putCh)
			for i := int64(1); i <= 3; i++ {
				putCh <- value.Long(i * 100)
			}
		}()
		// The unary request context is cancelled the moment this handler
		// returns, and PutStream's background streamer is bound to its ctx —
		// detach it so the push outlives the reply.
		if err := peer.PutStream(context.WithoutCancel(ctx), "ingest", args, putCh); err != nil {
			return nil, err
		}
		return value.Utf8("pushed"), nil
	})

	go func() {
		if err := srv.Run(); err != nil {
			fmt.Fprintln(os.Stderr, "run:", err)
		}
	}()

	// Wait until the listener reports its address, then announce readiness.
	fmt.Printf("LISTENING %s\n", srv.Addr().String())
	os.Stdout.Sync()

	// Exit when the parent test runner closes stdin.
	io.Copy(io.Discard, os.Stdin)
	srv.Close()
}
