/*
 * Copyright (c) 2026 Karagatan LLC.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Codec negotiation on the WebSocket dial: the client offers the subprotocol
 * of its codec and requires the echo, as valuerpc's WebSocket dialer does.
 */

import { describe, expect, it } from "vitest";
import { SUBPROTOCOL_JSON, SUBPROTOCOL_MSGPACK, jsonCodec, msgpackCodec } from "../src/codec.js";
import { Code, VrpcError } from "../src/errors.js";
import { webSocketDialer } from "../src/transport.js";

interface Dial {
  url: string;
  /** What the client offered; empty when it offered nothing. */
  offered: string[];
}

/**
 * A WebSocket constructor that records what it is offered and opens with the
 * subprotocol `server` selects from it, as a server's handshake would.
 */
function fakeWebSocket(server: (offered: string[]) => string): { ctor: typeof WebSocket; dials: Dial[] } {
  const dials: Dial[] = [];
  class Fake {
    binaryType = "blob";
    protocol: string;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: unknown) => void) | null = null;

    constructor(url: string, protocols?: string | string[]) {
      const offered = protocols === undefined ? [] : Array.isArray(protocols) ? protocols : [protocols];
      dials.push({ url, offered });
      this.protocol = server(offered);
      queueMicrotask(() => this.onopen?.());
    }

    send(): void {}
    close(): void {}
  }
  return { ctor: Fake as unknown as typeof WebSocket, dials };
}

/** A value-rpc server from v1.5.3 on: it echoes the codec it is offered. */
const negotiating = (offered: string[]): string =>
  offered.find((p) => p === SUBPROTOCOL_MSGPACK || p === SUBPROTOCOL_JSON) ?? "";

/** A server that predates codec negotiation: it echoes nothing. */
const predating = (): string => "";

describe("codec negotiation by WebSocket subprotocol", () => {
  it("each codec offers the token valuerpc gives it", () => {
    expect(SUBPROTOCOL_MSGPACK).toBe("vrpc.msgpack");
    expect(SUBPROTOCOL_JSON).toBe("vrpc.json");
    expect(msgpackCodec().subprotocols).toEqual(["vrpc.msgpack"]);
    expect(jsonCodec().subprotocols).toEqual(["vrpc.json"]);
  });

  it.each([
    ["msgpack", msgpackCodec()],
    ["json", jsonCodec()],
  ])("%s: the dial offers the codec and takes a server that echoes it", async (_name, codec) => {
    const ws = fakeWebSocket(negotiating);
    const transport = await webSocketDialer({
      url: "ws://example.test/rpc",
      subprotocols: codec.subprotocols,
      timeoutMs: 1000,
      webSocket: ws.ctor,
    });
    expect(ws.dials).toEqual([{ url: "ws://example.test/rpc", offered: codec.subprotocols }]);
    transport.close();
  });

  it.each([
    ["msgpack", msgpackCodec()],
    ["json", jsonCodec()],
  ])("%s: a server that echoes nothing is refused", async (_name, codec) => {
    const ws = fakeWebSocket(predating);
    const err = (await webSocketDialer({
      url: "ws://example.test/rpc",
      subprotocols: codec.subprotocols,
      timeoutMs: 1000,
      webSocket: ws.ctor,
    }).catch((e: unknown) => e)) as VrpcError;
    expect(err).toBeInstanceOf(VrpcError);
    expect(err.code).toBe(Code.Unavailable);
    expect(err.message).toContain(codec.subprotocols[0]);
    expect(err.message).toContain("predates codec negotiation");
  });

  it("a codec that offers nothing connects to a server that predates the negotiation", async () => {
    const ws = fakeWebSocket(predating);
    const codec = { ...msgpackCodec(), subprotocols: [] };
    const transport = await webSocketDialer({
      url: "ws://example.test/rpc",
      subprotocols: codec.subprotocols,
      timeoutMs: 1000,
      webSocket: ws.ctor,
    });
    expect(ws.dials).toEqual([{ url: "ws://example.test/rpc", offered: [] }]);
    transport.close();
  });
});
