/*
 * Copyright (c) 2026 Karagatan LLC.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import { createClient, type VrpcClient } from "../src/client.js";
import { Code, VrpcError } from "../src/errors.js";
import { MessageType } from "../src/protocol.js";
import type { Value } from "../src/value.js";
import { MockServer, sha256hex } from "./mock-server.js";

function newPair(overrides: Partial<Parameters<typeof createClient>[0]> = {}): {
  server: MockServer;
  client: VrpcClient;
} {
  const server = new MockServer();
  const client = createClient({
    url: "ws://mock/rpc",
    dialer: server.dialer(),
    timeoutMs: 1000,
    connectTimeoutMs: 1000,
    reconnect: { initialDelayMs: 5, maxDelayMs: 20 },
    ...overrides,
  });
  return { server, client };
}

describe("handshake", () => {
  it("sends magic, version, clientId, chain anchor and auth", async () => {
    const { server, client } = newPair({ auth: () => "bearer-token" });
    await client.connect();
    const hs = server.conn.handshake;
    expect(hs.m).toBe("vRPC");
    expect(hs.v).toBe(1);
    expect(hs.t).toBe(MessageType.HandshakeRequest);
    expect(hs.rid).toBe(0);
    expect(hs.cid).toBe(client.clientId);
    expect(hs.auth).toBe("bearer-token");
    expect(typeof hs.tok).toBe("string");
    expect((hs.tok as string).length).toBe(64); // hex sha-256 anchor
    expect(client.status).toBe("open");
    client.close();
    expect(client.status).toBe("closed");
  });

  it("omits the token when resumption is disabled", async () => {
    const { server, client } = newPair({ resume: false });
    await client.connect();
    expect(server.conn.handshake.tok).toBeUndefined();
    client.close();
  });

  it("fails connect when the server rejects (closes) the handshake", async () => {
    const { server, client } = newPair({ reconnect: false });
    server.authRejects = true;
    await expect(client.connect()).rejects.toThrow();
    client.close();
  });
});

describe("unary calls", () => {
  it("calls a function and gets the result", async () => {
    const { server, client } = newPair();
    server.addFunction("greet", (args) => `Hello, ${(args as Value[])[0]}!`);
    const res = await client.call("greet", ["world"]);
    expect(res).toBe("Hello, world!");
    client.close();
  });

  it("carries sla and metadata on the request envelope", async () => {
    const { server, client } = newPair({ metadata: () => ({ traceparent: "00-abc" }) });
    server.addFunction("noop", () => null);
    await client.call("noop", [1], { timeoutMs: 2500, metadata: { extra: "x" } });
    const frame = server.conn.frames.find((f) => f.t === MessageType.FunctionRequest);
    expect(frame?.sla).toBe(2500);
    expect(frame?.md).toEqual({ traceparent: "00-abc", extra: "x" });
    client.close();
  });

  it("maps ErrorResponse to VrpcError with the server code", async () => {
    const { client } = newPair();
    const err = (await client.call("missing").catch((e) => e)) as VrpcError;
    expect(err).toBeInstanceOf(VrpcError);
    expect(err.code).toBe(Code.NotFound);
    client.close();
  });

  it("returns null for a void result", async () => {
    const { server, client } = newPair();
    server.addFunction("void", () => null);
    expect(await client.call("void")).toBeNull();
    client.close();
  });

  it("times out and sends CancelRequest", async () => {
    const { server, client } = newPair();
    server.addFunction("slow", () => new Promise((r) => setTimeout(() => r("late"), 500)));
    const err = (await client.call("slow", [], { timeoutMs: 40 }).catch((e) => e)) as VrpcError;
    expect(err.code).toBe(Code.DeadlineExceeded);
    await new Promise((r) => setTimeout(r, 20));
    expect(server.conn.frames.some((f) => f.t === MessageType.CancelRequest)).toBe(true);
    client.close();
  });

  it("maps AbortSignal to CancelRequest", async () => {
    const { server, client } = newPair();
    server.addFunction("slow", () => new Promise((r) => setTimeout(() => r("late"), 500)));
    const ctrl = new AbortController();
    const promise = client.call("slow", [], { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 10);
    const err = (await promise.catch((e) => e)) as VrpcError;
    expect(err.code).toBe(Code.Canceled);
    await new Promise((r) => setTimeout(r, 20));
    expect(server.conn.frames.some((f) => f.t === MessageType.CancelRequest)).toBe(true);
    client.close();
  });
});

describe("get-stream", () => {
  it("consumes a stream with pull-based credit", async () => {
    const { server, client } = newPair({ maxPending: 4 });
    server.addGetStream("count", (args) => {
      const n = (args as Value[])[0] as number;
      return Array.from({ length: n }, (_, i) => i + 1);
    });
    const got: Value[] = [];
    for await (const v of client.getStream("count", [10])) got.push(v);
    expect(got).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    // Initial window grant, then batched replenishment (~half window).
    const credits = server.conn.frames
      .filter((f) => f.t === MessageType.StreamCredit)
      .map((f) => f.cr);
    expect(credits[0]).toBe(4);
    expect(credits.length).toBeGreaterThan(1);
    client.close();
  });

  it("ends the iterator on StreamEnd with a final value", async () => {
    const { server, client } = newPair();
    server.addGetStream("three", () => [10, 20, 30]);
    const stream = client.getStream("three", []);
    await stream.ready;
    const got: Value[] = [];
    for await (const v of stream) got.push(v);
    expect(got).toEqual([10, 20, 30]);
    client.close();
  });

  it("cancels on break", async () => {
    const { server, client } = newPair({ maxPending: 2 });
    server.addGetStream("inf", () => Array.from({ length: 100 }, (_, i) => i));
    for await (const v of client.getStream("inf", [])) {
      if ((v as number) >= 1) break;
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(server.conn.frames.some((f) => f.t === MessageType.CancelRequest)).toBe(true);
    client.close();
  });

  it("surfaces stream errors as VrpcError", async () => {
    const { client } = newPair();
    const stream = client.getStream("nope", []);
    const err = await stream.next().catch((e) => e as VrpcError);
    expect(err).toBeInstanceOf(VrpcError);
    expect((err as VrpcError).code).toBe(Code.NotFound);
    client.close();
  });
});

describe("put-stream", () => {
  it("waits for ready + credit and sends StreamEnd", async () => {
    const { server, client } = newPair();
    await client.putStream("upload", ["batch-1"], [1, 2, 3, 4, 5]);
    expect(server.putReceived).toEqual([1, 2, 3, 4, 5]);
    const types = server.conn.frames.map((f) => f.t);
    expect(types).toContain(MessageType.StreamEnd);
    // Values must come after the server's ready/credit sequencing.
    const readyIdx = server.conn.frames.findIndex((f) => f.t === MessageType.PutStreamRequest);
    const firstValIdx = server.conn.frames.findIndex((f) => f.t === MessageType.StreamValue);
    expect(firstValIdx).toBeGreaterThan(readyIdx);
    client.close();
  });

  it("accepts async iterables", async () => {
    const { server, client } = newPair();
    async function* src(): AsyncGenerator<Value> {
      yield "a";
      await new Promise((r) => setTimeout(r, 5));
      yield "b";
    }
    await client.putStream("upload", null, src());
    expect(server.putReceived).toEqual(["a", "b"]);
    client.close();
  });
});

describe("chat", () => {
  it("sends and receives bidirectionally", async () => {
    const { client } = newPair();
    const chat = client.chat("chat.echo", ["room"]);
    await chat.send("one");
    await chat.send("two");
    chat.end();
    const got: Value[] = [];
    for await (const v of chat) got.push(v);
    expect(got).toEqual(["one", "two"]);
    client.close();
  });
});

describe("reverse calls (server -> client)", () => {
  it("serves a registered unary function", async () => {
    const { server, client } = newPair();
    client.addFunction("notify", (args) => `got:${(args as Value[])[0]}`);
    await client.connect();
    const r = await server.callClient("notify", ["ping"]);
    expect(r.result).toBe("got:ping");
  });

  it("answers NotFound for unregistered functions", async () => {
    const { server, client } = newPair();
    await client.connect();
    const r = await server.callClient("nope", []);
    expect(r.error?.code).toBe(Code.NotFound);
    expect(r.error?.rid).toBeLessThan(0);
  });

  it("serves a reverse get-stream with credit", async () => {
    const { server, client } = newPair();
    client.addOutgoingStream("tail", function* (args) {
      const n = (args as Value[])[0] as number;
      for (let i = 0; i < n; i++) yield `v${i}`;
    });
    await client.connect();
    const got = await server.getStreamFromClient("tail", [5], 2);
    expect(got).toEqual(["v0", "v1", "v2", "v3", "v4"]);
  });

  it("serves a reverse put-stream", async () => {
    const { server, client } = newPair();
    const received: Value[] = [];
    let done: () => void;
    const finished = new Promise<void>((r) => (done = r));
    client.addIncomingStream("ingest", async (_args, incoming) => {
      for await (const v of incoming) received.push(v);
      done();
    });
    await client.connect();
    await server.putStreamToClient("ingest", ["x"], [7, 8, 9]);
    await finished;
    expect(received).toEqual([7, 8, 9]);
  });

  it("rejects a reverse stream with the wrong kind", async () => {
    const { server, client } = newPair();
    client.addFunction("unary-only", () => null);
    await client.connect();
    await expect(server.getStreamFromClient("unary-only", [])).rejects.toThrow(/not unary|wrong stream type/);
  });
});

describe("reconnect & resumption", () => {
  it("reconnects after a drop and presents the next chain link", async () => {
    const { server, client } = newPair();
    server.addFunction("ping", () => "pong");
    await client.connect();
    const anchor = server.handshakes[0]?.tok as string;

    const statuses: string[] = [];
    client.on("status", (s) => statuses.push(s));

    server.conn.drop();
    await new Promise<void>((resolve) => {
      const off = client.on("status", (s) => {
        if (s === "open") {
          off();
          resolve();
        }
      });
    });

    expect(server.handshakes.length).toBe(2);
    const second = server.handshakes[1];
    expect(second?.cid).toBe(client.clientId); // same session
    const preimage = second?.tok as string;
    expect(preimage).not.toBe(anchor);
    // The revealed pre-image must hash forward to the anchor (resync window 1).
    expect(await sha256hex(preimage)).toBe(anchor);
    expect(statuses).toContain("resuming");

    expect(await client.call("ping")).toBe("pong");
    client.close();
  });

  it("keeps reconnecting after a wake hint interrupts the backoff (network switch)", async () => {
    // Regression: the 'online'/visibility wake hint aborts the backoff sleep to
    // dial immediately. It used to terminate resumeLoop instead, stranding the
    // client in "resuming" forever — precisely when connectivity had RETURNED.
    const server = new MockServer();
    let down = false;
    const inner = server.dialer();
    const client = createClient({
      url: "ws://mock/rpc",
      dialer: async (opts) => {
        if (down) throw new VrpcError(Code.Unavailable, "network down");
        return inner(opts);
      },
      timeoutMs: 1000,
      connectTimeoutMs: 1000,
      reconnect: { initialDelayMs: 5, maxDelayMs: 20 },
    });
    await client.connect();
    down = true;
    server.conn.drop();
    await new Promise((r) => setTimeout(r, 15));
    expect(client.status).toBe("resuming");
    // A connectivity-announcement storm (WiFi switch): each hint aborts the
    // current backoff sleep. The loop must keep dialing through all of them.
    for (let i = 0; i < 3; i++) {
      (client as unknown as { resumeAbort: AbortController | null }).resumeAbort?.abort();
      await new Promise((r) => setTimeout(r, 10));
    }
    down = false; // the new network actually routes now
    await new Promise<void>((resolve) => {
      if (client.status === "open") return resolve();
      const off = client.on("status", (s) => {
        if (s === "open") {
          off();
          resolve();
        }
      });
    });
    expect(client.status).toBe("open");
    client.close();
  });

  it("fails in-flight calls on drop with Unavailable", async () => {
    const { server, client } = newPair();
    server.addFunction("hang", () => new Promise(() => {}));
    const p = client.call("hang", [], { timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 10));
    server.conn.drop();
    const err = (await p.catch((e) => e)) as VrpcError;
    expect(err.code).toBe(Code.Unavailable);
    client.close();
  });

  it("does not reconnect when disabled", async () => {
    const { server, client } = newPair({ reconnect: false });
    await client.connect();
    server.conn.drop();
    await new Promise((r) => setTimeout(r, 30));
    expect(client.status).toBe("closed");
  });

  it("uses a fresh clientId per connection when resume is off", async () => {
    const { server, client } = newPair({ resume: false });
    await client.connect();
    const cid1 = server.handshakes[0]?.cid;
    server.conn.drop();
    await new Promise<void>((resolve) => {
      const off = client.on("status", (s) => {
        if (s === "open") {
          off();
          resolve();
        }
      });
    });
    expect(server.handshakes[1]?.cid).not.toBe(cid1);
    client.close();
  });
});

describe("flow-control hardening", () => {
  it("cancels a stream when the server overruns its credit", async () => {
    const { server, client } = newPair({ maxPending: 2 });
    server.floodOnGet = 10; // misbehaving server: ignores its credit window
    const stream = client.getStream("flood", []);
    const err = await (async () => {
      try {
        const got: Value[] = [];
        // do not consume until the flood has arrived
        await new Promise((r) => setTimeout(r, 30));
        for await (const v of stream) got.push(v);
        return null;
      } catch (e) {
        return e as VrpcError;
      }
    })();
    expect(err).toBeInstanceOf(VrpcError);
    expect((err as VrpcError).code).toBe(Code.ResourceExhausted);
    expect(server.conn.frames.some((f) => f.t === MessageType.CancelRequest)).toBe(true);
    client.close();
  });
});
