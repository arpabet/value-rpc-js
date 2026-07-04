/*
 * Copyright (c) 2026 Karagatan LLC.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import { createClient, type VrpcClient } from "@arpabet/vrpc";
import {
  createVrpc,
  useVrpc,
  useVrpcCall,
  useVrpcConnection,
  useVrpcStream,
} from "../src/index.js";
import { MockServer } from "../../vrpc/test/mock-server.js";

function withSetup<T>(client: VrpcClient, setup: () => T): { result: T; unmount: () => void } {
  let result!: T;
  const app = createApp(
    defineComponent({
      setup() {
        result = setup();
        return () => h("div");
      },
    }),
  );
  app.use(createVrpc(client));
  const root = document.createElement("div");
  app.mount(root);
  return { result, unmount: () => app.unmount() };
}

function newPair(): { server: MockServer; client: VrpcClient } {
  const server = new MockServer();
  const client = createClient({
    url: "ws://mock/rpc",
    dialer: server.dialer(),
    timeoutMs: 1000,
    reconnect: { initialDelayMs: 5, maxDelayMs: 20 },
  });
  return { server, client };
}

async function until(cond: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("useVrpc / useVrpcConnection", () => {
  it("provides the client and tracks status", async () => {
    const { client } = newPair();
    const { result, unmount } = withSetup(client, () => ({
      injected: useVrpc(),
      conn: useVrpcConnection(),
    }));
    expect(result.injected).toBe(client);
    expect(result.conn.status.value).toBe("idle");
    await client.connect();
    expect(result.conn.status.value).toBe("open");
    expect(result.conn.connected.value).toBe(true);
    unmount();
    client.close();
  });
});

describe("useVrpcCall", () => {
  it("runs immediately and exposes data", async () => {
    const { server, client } = newPair();
    server.addFunction("greet", (args) => `Hello, ${(args as string[])[0]}!`);
    const { result, unmount } = withSetup(client, () =>
      useVrpcCall<string>("greet", () => ["vue"]),
    );
    expect(result.pending.value).toBe(true);
    await until(() => !result.pending.value);
    expect(result.data.value).toBe("Hello, vue!");
    expect(result.error.value).toBeNull();
    unmount();
    client.close();
  });

  it("re-runs when reactive args change", async () => {
    const { server, client } = newPair();
    server.addFunction("echo", (args) => (args as string[])[0] ?? null);
    const who = ref("a");
    const { result, unmount } = withSetup(client, () => useVrpcCall<string>("echo", () => [who.value]));
    await until(() => result.data.value === "a");
    who.value = "b";
    await nextTick();
    await until(() => result.data.value === "b");
    unmount();
    client.close();
  });

  it("surfaces coded errors", async () => {
    const { client } = newPair();
    const { result, unmount } = withSetup(client, () => useVrpcCall("missing.fn"));
    await until(() => result.error.value !== null);
    expect(result.error.value?.code).toBe(5); // NotFound
    unmount();
    client.close();
  });
});

describe("useVrpcStream", () => {
  it("streams values into refs and ends", async () => {
    const { server, client } = newPair();
    server.addGetStream("count", () => [1, 2, 3]);
    const { result, unmount } = withSetup(client, () => useVrpcStream<number>("count", []));
    await until(() => result.state.value === "ended");
    expect(result.values.value).toEqual([1, 2, 3]);
    expect(result.latest.value).toBe(3);
    unmount();
    client.close();
  });

  it("bounds the kept values window", async () => {
    const { server, client } = newPair();
    server.addGetStream("count", () => [1, 2, 3, 4, 5, 6]);
    const { result, unmount } = withSetup(client, () =>
      useVrpcStream<number>("count", [], { keepLast: 2 }),
    );
    await until(() => result.state.value === "ended");
    expect(result.values.value).toEqual([5, 6]);
    unmount();
    client.close();
  });

  it("cancels the stream on unmount", async () => {
    const { server, client } = newPair();
    server.addGetStream("inf", () => Array.from({ length: 1000 }, (_, i) => i));
    const { result, unmount } = withSetup(client, () => useVrpcStream<number>("inf", []));
    await until(() => result.latest.value !== null);
    unmount();
    await until(() => server.conn.frames.some((f) => f.t === 11 /* CancelRequest */));
    client.close();
  });
});
