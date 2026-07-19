/*
 * Copyright (c) 2026 Karagatan LLC.
 * SPDX-License-Identifier: Apache-2.0
 */

import { Code, VrpcError } from "./errors.js";

/**
 * One established message connection. Deliberately tiny (WEB.md §7): a future
 * WebTransport implementation slots in without touching the protocol layer.
 */
export interface Transport {
  send(data: Uint8Array | string): void;
  close(): void;
  onMessage: ((data: Uint8Array | string) => void) | null;
  /** Fired exactly once, for both clean and failed closes. */
  onClose: ((err?: Error) => void) | null;
}

export interface DialOptions {
  url: string;
  subprotocols: string[];
  timeoutMs: number;
  /** Override the WebSocket constructor (tests, custom agents). */
  webSocket?: typeof WebSocket;
}

export type Dialer = (opts: DialOptions) => Promise<Transport>;

/** Dials a WebSocket and resolves once the connection is open. */
export const webSocketDialer: Dialer = (opts) => {
  return new Promise<Transport>((resolve, reject) => {
    const WS = opts.webSocket ?? globalThis.WebSocket;
    if (typeof WS !== "function") {
      reject(
        new VrpcError(
          Code.Internal,
          "no WebSocket implementation available; pass one via the webSocket option",
        ),
      );
      return;
    }
    let ws: WebSocket;
    try {
      ws = opts.subprotocols.length > 0 ? new WS(opts.url, opts.subprotocols) : new WS(opts.url);
    } catch (err) {
      reject(new VrpcError(Code.Unavailable, `websocket dial failed: ${String(err)}`, { cause: err }));
      return;
    }
    ws.binaryType = "arraybuffer";

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.close();
      reject(new VrpcError(Code.DeadlineExceeded, `websocket dial timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);

    ws.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (opts.subprotocols.length > 0 && !opts.subprotocols.includes(ws.protocol)) {
        ws.close();
        reject(
          new VrpcError(
            Code.Unavailable,
            `server did not accept subprotocol ${opts.subprotocols.join("/")} (got ${JSON.stringify(
              ws.protocol,
            )}); it likely predates JSON codec support — use codec: "msgpack"`,
          ),
        );
        return;
      }
      resolve(wrap(ws));
    };
    ws.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new VrpcError(Code.Unavailable, `websocket dial failed: ${opts.url}`));
    };
    ws.onclose = (ev) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new VrpcError(
          Code.Unavailable,
          `websocket closed during dial (code ${ev.code}${ev.reason ? `, ${ev.reason}` : ""})`,
        ),
      );
    };
  });
};

function wrap(ws: WebSocket): Transport {
  // Frames can arrive before the consumer assigns onMessage (the server's
  // handshake response can land in the same task the dial resolves in, before
  // the client's connect() continuation runs). Buffer any such early frames
  // and flush them the moment onMessage is wired, so none are dropped.
  let onMessageCb: ((data: Uint8Array | string) => void) | null = null;
  const early: (Uint8Array | string)[] = [];
  const deliver = (d: Uint8Array | string): void => {
    if (onMessageCb) onMessageCb(d);
    else early.push(d);
  };
  const t: Transport = {
    send(data) {
      // Uint8Array and string are both valid WebSocket payloads.
      ws.send(data as never);
    },
    close() {
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      try {
        ws.close(1000);
      } catch {
        // already closing
      }
    },
    get onMessage() {
      return onMessageCb;
    },
    set onMessage(cb: ((data: Uint8Array | string) => void) | null) {
      onMessageCb = cb;
      if (cb && early.length > 0) {
        const queued = early.splice(0, early.length);
        for (const d of queued) cb(d);
      }
    },
    onClose: null,
  };
  let closed = false;
  const fireClose = (err?: Error): void => {
    if (closed) return;
    closed = true;
    t.onClose?.(err);
  };
  ws.onmessage = (ev: MessageEvent) => {
    const data = ev.data as unknown;
    if (typeof data === "string") deliver(data);
    else if (data instanceof ArrayBuffer) deliver(new Uint8Array(data));
    else if (ArrayBuffer.isView(data)) {
      const view = data as ArrayBufferView;
      deliver(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    }
  };
  ws.onclose = (ev) => {
    fireClose(
      ev.wasClean && ev.code === 1000
        ? undefined
        : new VrpcError(Code.Unavailable, `websocket closed (code ${ev.code}${ev.reason ? `, ${ev.reason}` : ""})`),
    );
  };
  ws.onerror = () => {
    // An error event is always followed by close in browsers, but not
    // necessarily in every server runtime; normalize to one close signal.
    fireClose(new VrpcError(Code.Unavailable, "websocket error"));
  };
  return t;
}
