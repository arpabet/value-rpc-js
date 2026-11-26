/*
 * Copyright (c) 2026 Karagatan LLC.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Conformance suite: runs the TS client against a real value-rpc server over
 * WebSocket, once for EACH wire codec — msgpack (binary frames) and JSON
 * (text frames, negotiated by the vrpc.json subprotocol). Every pattern, both
 * call directions, auth, cancellation, and reconnect-with-resumption.
 *
 * The server is the Go one of this repository (conformance/server), and the
 * suite is skipped when the Go toolchain is unavailable. With
 * VRPC_CONFORMANCE_SERVER set, it is another implementation's instead: the
 * variable is the command that starts it (run by the shell), and the server
 * must serve the same functions and say where it listens as the Go one does
 * (see startServer). The Java implementation, from a checkout beside this
 * repository:
 *
 *   VRPC_CONFORMANCE_SERVER='cd ../../../value-rpc-java && ./gradlew -q :value-rpc:conformanceServer' \
 *     npx vitest run test/conformance.test.ts
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VrpcTimestamp, createClient, timestamp, type CodecName, type VrpcClient } from "../src/index.js";
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

/** The command that starts another implementation's conformance server, in place of the Go one. */
const serverCommand = process.env.VRPC_CONFORMANCE_SERVER;

/**
 * Starts a server of its own for the caller, and gives its WebSocket URL once
 * the server has said where it listens, on a line of its standard output:
 *
 *   LISTENING <host:port>            WebSocket under /rpc (the Go server here)
 *   LISTENING ws <host:port/path>    WebSocket at that address (the Java one,
 *                                    which says `LISTENING tcp ...` as well)
 *
 * The server exits when its standard input ends.
 */
async function startServer(): Promise<Server> {
  const proc = serverCommand
    ? // Its own process group: the command may start the server through a build tool, and all of it has to go.
      spawn(serverCommand, { shell: true, detached: true, stdio: ["pipe", "pipe", "inherit"] })
    : spawn("go", ["run", "."], { cwd: serverDir, stdio: ["pipe", "pipe", "inherit"] });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("conformance server did not start in time")), 120_000);
    let buffer = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const ws = /^LISTENING ws (\S+)\r?\n/m.exec(buffer);
      const plain = /^LISTENING (\S+)\r?\n/m.exec(buffer);
      if (ws || plain) {
        clearTimeout(timer);
        resolve(ws ? `ws://${ws[1]}` : `ws://${plain![1]}/rpc`);
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
  if (!server) return;
  server.proc.stdin?.end();
  setTimeout(() => {
    try {
      if (serverCommand && server.proc.pid !== undefined) process.kill(-server.proc.pid, "SIGKILL");
      else server.proc.kill("SIGKILL");
    } catch {
      // gone already
    }
  }, 1000).unref?.();
}

const CODECS: CodecName[] = ["msgpack", "json"];

const SERVER_NAME = serverCommand ? "the server of VRPC_CONFORMANCE_SERVER" : "the Go server";

describe.skipIf(!hasGo && !serverCommand).each(CODECS)(`conformance against ${SERVER_NAME} (%s)`, (codec) => {
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

  it("unary: echo round-trips a timestamp over msgpack", async () => {
    // A value >= 1.5.0 server decodes the timestamp and re-encodes it
    // canonically; an older one passes the extension through unchanged. The
    // bytes are the same either way, and they decode to the same instant.
    if (codec !== "msgpack") return;
    const when = new Date("2026-10-30T07:28:39.075Z");
    const echoed = (await client.call("echo", { when })) as { when: VrpcTimestamp };
    expect(echoed.when).toBeInstanceOf(VrpcTimestamp);
    expect(echoed.when.toDate().getTime()).toBe(when.getTime());
    const nanos = timestamp(1793345319n, 123_456_789);
    const back = (await client.call("echo", [nanos])) as VrpcTimestamp[];
    expect(back[0]?.equals(nanos)).toBe(true);
  });

  it("unary: echo round-trips text that JSON has to escape", async () => {
    // Control characters, quotes and backslashes, as a value and as a map
    // key. msgpack carries any text; over JSON the server's answer was not
    // JSON before value v1.6.2 (value-rpc v1.6.5), and the client could not
    // read it.
    const ch = (code: number): string => String.fromCharCode(code);
    const text = `bell ${ch(7)}, escape ${ch(27)}[0m, vertical tab ${ch(11)}, delete ${ch(127)}, quote " and backslash \\`;
    const payload: Value = {
      [text]: text,
      list: [text, "line\nbreak\ttab", `nul ${ch(0)} inside`],
      nested: { 'key "quoted"': 1 },
    };
    expect(await client.call("echo", payload)).toEqual(payload);
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
