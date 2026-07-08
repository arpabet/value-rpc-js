/*
 * Copyright (c) 2026 Karagatan LLC.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Example value-rpc server for the Vue and Nuxt example apps. It exposes the
 * three things those apps demonstrate:
 *
 *   - greet        unary call
 *   - count        server -> browser stream
 *   - reverse.call server -> browser reverse RPC (calls the browser's "notify")
 *
 * Run it on :9000 (the port the examples' dev proxy points at):
 *
 *   go run .            # listens on ws://127.0.0.1:9000/rpc
 *   VRPC_ADDR=:9001 go run .
 */

package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"go.arpabet.com/value"
	"go.arpabet.com/value-rpc/valuerpc"
	"go.arpabet.com/value-rpc/valueserver"
	"go.uber.org/zap"
)

func main() {
	addr := os.Getenv("VRPC_ADDR")
	if addr == "" {
		addr = "127.0.0.1:9000"
	}

	logger, _ := zap.NewDevelopment()

	// Both codecs are negotiated automatically: a browser offering the vrpc.json
	// subprotocol gets JSON (text frames); anything else gets msgpack. Allow any
	// Origin so the examples work whether served same-origin (via the dev proxy)
	// or cross-origin; tighten this in production with WithWebSocketOrigins.
	srv, err := valueserver.NewWebSocketServer(addr, "/rpc", logger,
		valueserver.WithWebSocketOrigins("*"))
	if err != nil {
		logger.Fatal("bind", zap.Error(err))
	}

	// --- unary ---
	srv.AddFunction("greet", valuerpc.Any, valuerpc.Any,
		func(_ context.Context, args value.Value) (value.Value, error) {
			name := "world"
			if l, ok := args.(value.List); ok && l.Len() > 0 {
				name = l.GetAt(0).String()
			}
			return value.Utf8("Hello, " + name + "!"), nil
		})

	// --- server -> browser stream ---
	srv.AddOutgoingStream("count", valuerpc.Any,
		func(ctx context.Context, args value.Value) (<-chan value.Value, error) {
			n := int64(10)
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

	// --- server -> browser reverse RPC ---
	// reverse.call asks the connected browser to run its own "notify" function,
	// demonstrating the peer-symmetric direction (the server calls the client).
	srv.AddFunction("reverse.call", valuerpc.Any, valuerpc.Any,
		func(ctx context.Context, args value.Value) (value.Value, error) {
			peer, ok := valueserver.PeerFromContext(ctx)
			if !ok {
				return nil, valuerpc.NewError(valuerpc.CodeInternal, "no connected peer")
			}
			return peer.CallFunction(ctx, "notify", args)
		})

	go func() {
		if err := srv.Run(); err != nil {
			logger.Error("run", zap.Error(err))
		}
	}()
	fmt.Printf("value-rpc example server listening on ws://%s/rpc\n", srv.Addr().String())

	// Serve until Ctrl-C.
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	srv.Close()
}
