/*
 * Copyright (c) 2026 Karagatan LLC.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Conformance suite: runs the TS client against the real Go value-rpc server
 * (conformance/server) over WebSocket, once for EACH wire codec — msgpack
 * (binary frames) and JSON (text frames, negotiated by the vrpc.json
 * subprotocol). Every pattern, both call directions, auth, cancellation, and
 * reconnect-with-resumption. Skipped when the Go toolchain is unavailable.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type CodecName, type VrpcClient } from "../src/index.js";
import { Code, VrpcError } from "../src/errors.js";
import type { Value } from "../src/value.js";

const hasGo = (() => {
  try {
    return spawnSync("go", ["version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
})();

const serverDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../conformance/server",
);

interface Server {
  proc: ChildProcess;
  url: string;
}

async function startServer(): Promise<Server> {
  const proc = spawn("go", ["run", "."], { cwd: serverDir, stdio: ["pipe", "pipe", "inherit"] });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("conformance server did not start in time")), 60_000);
    let buffer = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const m = /LISTENING (\S+)/.exec(buffer);
      if (m) {
        clearTimeout(timer);
        resolve(`ws://${m[1]}/rpc`);
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`conformance server exited early (code ${code})`));
    });
  });
  return { proc, url };
}

function stopServer(server: Server | undefined): void {
  server?.proc.stdin?.end();
  setTimeout(() => server?.proc.kill("SIGKILL"), 1000).unref?.();
}

const CODECS: CodecName[] = ["msgpack", "json"];

describe.skipIf(!hasGo).each(CODECS)("conformance against the Go server (%s)", (codec) => {
  let server: Server;
  let client: VrpcClient;

  beforeAll(async () => {
    server = await startServer();
    client = createClient({
      url: server.url,
      codec,
      timeoutMs: 4000,
      reconnect: { initialDelayMs: 50, maxDelayMs: 200 },
      metadata: () => ({ traceparent: "00-t" }),
    });
    await client.connect();
    expect(client.codecName).toBe(codec);
  }, 90_000);

  afterAll(() => {
    client?.close();
    stopServer(server);
  });

  it("unary: greet", async () => {
    expect(await client.call("greet", ["world"])).toBe("Hello, world!");
  });

  it("unary: add over int64", async () => {
    expect(await client.call("add", [40, 2])).toBe(42);
  });

  it("unary: echo round-trips the value model", async () => {
    const payload: Value = {
      bytes: new Uint8Array([0, 1, 254, 255]),
      list: [1, "two", null, true, 1.5],
      nested: { deep: { key: "value" } },
    };
    // int64 beyond 2^53 travels exactly over msgpack (bigint); the JSON codec
    // cannot carry it, so only assert it on the binary path.
    if (codec === "msgpack") (payload as Record<string, Value>).big = 2n ** 60n;
    const echoed = await client.call("echo", payload);
    expect(echoed).toEqual(payload);
  });

  it("unary: coded errors arrive with their code", async () => {
    const err = (await client.call("fail").catch((e) => e)) as VrpcError;
    expect(err).toBeInstanceOf(VrpcError);
    expect(err.code).toBe(Code.ResourceExhausted);
    expect(err.message).toContain("deliberate failure");
  });

  it("unary: unknown function is NotFound", async () => {
    const err = (await client.call("no.such.fn").catch((e) => e)) as VrpcError;
    expect(err.code).toBe(Code.NotFound);
  });

  it("unary: client-side timeout cancels the server call", async () => {
    const err = (await client.call("slow", [], { timeoutMs: 150 }).catch((e) => e)) as VrpcError;
    expect(err.code).toBe(Code.DeadlineExceeded);
  });

  it("unary: AbortSignal cancels", async () => {
    const ctrl = new AbortController();
    const p = client.call("slow", [], { timeoutMs: 8000, signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 50);
    const err = (await p.catch((e) => e)) as VrpcError;
    expect(err.code).toBe(Code.Canceled);
  });

  it("metadata flows to the handler context", async () => {
    const md = await client.call("md.echo", [], { metadata: { extra: "x" } });
    expect(md).toEqual({ traceparent: "00-t", extra: "x" });
  });

  it("get-stream: consumes with backpressure", async () => {
    const got: Value[] = [];
    for await (const v of client.getStream("count", [25])) got.push(v);
    expect(got).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it("get-stream: break sends cancel and the loop exits", async () => {
    const got: Value[] = [];
    for await (const v of client.getStream("count", [1000])) {
      got.push(v);
      if (got.length === 3) break;
    }
    expect(got).toEqual([1, 2, 3]);
  });

  it("put-stream: uploads values the server sums", async () => {
    await client.putStream("upload", ["batch"], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (let i = 0; i < 50; i++) {
      const stats = (await client.call("upload.stats")) as { sum: number; count: number };
      if (stats.count >= 10) {
        expect(stats.sum).toBe(55);
        return;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("server never observed the uploaded values");
  });

  it("chat: bidirectional echo", async () => {
    const chat = client.chat("chat.echo", ["room-1"]);
    await chat.send("one");
    await chat.send("two");
    await chat.send("three");
    chat.end();
    const got: Value[] = [];
    for await (const v of chat) got.push(v);
    expect(got).toEqual(["echo:one", "echo:two", "echo:three"]);
  });

  it("reverse unary: server calls the browser-side function", async () => {
    client.addFunction("notify", (args) => `client-saw:${(args as Value[])[0]}`);
    const res = await client.call("reverse.call", ["ping"]);
    expect(res).toBe("client-saw:ping");
  });

  it("reverse get-stream: server pulls a stream the client serves", async () => {
    client.addOutgoingStream("tail", function* (args) {
      const n = (args as Value[])[0] as number;
      for (let i = 0; i < n; i++) yield `t${i}`;
    });
    const res = await client.call("reverse.pull", [4]);
    expect(res).toEqual(["t0", "t1", "t2", "t3"]);
  });

  it("reverse put-stream: server pushes a stream the client consumes", async () => {
    const received: Value[] = [];
    let finish!: () => void;
    const done = new Promise<void>((r) => (finish = r));
    client.addIncomingStream("ingest", async (_args, incoming) => {
      for await (const v of incoming) received.push(v);
      finish();
    });
    expect(await client.call("reverse.push", ["go"])).toBe("pushed");
    await done;
    expect(received).toEqual([100, 200, 300]);
  });

  it("reconnects after a server-side drop and resumes the session", async () => {
    const cid = client.clientId;
    const reopened = new Promise<void>((resolve) => {
      const off = client.on("status", (s) => {
        if (s === "open") {
          off();
          resolve();
        }
      });
    });
    expect(await client.call("kick")).toBe("kicking");
    await reopened;
    expect(client.clientId).toBe(cid);
    expect(await client.call("greet", ["again"])).toBe("Hello, again!");
    expect(await client.call("reverse.call", ["after-resume"])).toBe("client-saw:after-resume");
  }, 15_000);

  it("authenticates via the handshake auth field", async () => {
    const authed = createClient({ url: server.url, codec, auth: "secret", reconnect: false });
    expect(await authed.call("greet", ["auth"])).toBe("Hello, auth!");
    authed.close();

    const rejected = createClient({ url: server.url, codec, auth: "wrong", reconnect: false, connectTimeoutMs: 3000 });
    await expect(rejected.connect()).rejects.toThrow();
    rejected.close();
  });
});
