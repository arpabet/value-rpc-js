/*
 * Copyright (c) 2026 Karagatan LLC.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * An in-memory value-rpc server faithful to valueserver's choreography:
 * handshake ack, StreamReady timing, initial-credit-before-ready for
 * put/chat, credit-gated sends, negative ids for server-initiated requests,
 * and hash-chain resumption bookkeeping. Speaks through the client's Dialer
 * seam so tests exercise the exact frames a Go server would exchange.
 */

import { msgpackCodec, type WireCodec } from "../src/codec.js";
import { MessageType, Protocol, newDialect } from "../src/protocol.js";
import type { Dialer, Transport } from "../src/transport.js";
import type { Value, ValueMap } from "../src/value.js";

const proto = new Protocol(newDialect());

export interface MockConn {
  /** Frames received from the client (decoded), in order. */
  readonly frames: ValueMap[];
  readonly handshake: ValueMap;
  push(env: ValueMap): void;
  drop(): void; // simulate an unclean network drop
  closed: boolean;
}

type UnaryFn = (args: Value) => Value | Promise<Value>;

interface ServerStream {
  credit: number;
  waiters: (() => void)[];
  canceled: boolean;
  received: Value[];
  endReceived: boolean;
  onEnd?: () => void;
}

export class MockServer {
  readonly conns: MockConnImpl[] = [];
  readonly functions = new Map<string, UnaryFn>();
  readonly getStreams = new Map<string, (args: Value) => Value[]>();
  readonly putWindow: number = 8;
  readonly handshakes: ValueMap[] = [];
  putReceived: Value[] = [];
  authRejects = false;
  /** When set, get-stream requests flood N values ignoring credit. */
  floodOnGet: number | null = null;
  private nextServerRid = 0;

  constructor(readonly codec: WireCodec = msgpackCodec()) {}

  get conn(): MockConnImpl {
    const c = this.conns[this.conns.length - 1];
    if (!c) throw new Error("mock: no connection");
    return c;
  }

  dialer(): Dialer {
    return async () => {
      const conn = new MockConnImpl(this);
      this.conns.push(conn);
      return conn.clientTransport;
    };
  }

  addFunction(name: string, fn: UnaryFn): void {
    this.functions.set(name, fn);
  }

  addGetStream(name: string, fn: (args: Value) => Value[]): void {
    this.getStreams.set(name, fn);
  }

  /** Server->client reverse unary call. */
  callClient(name: string, args: Value): Promise<{ result?: Value; error?: ValueMap }> {
    const rid = --this.nextServerRid;
    const conn = this.conn;
    return new Promise((resolve) => {
      conn.pendingCalls.set(rid, resolve);
      conn.push(proto.request(MessageType.FunctionRequest, rid, name, args, 0, undefined));
    });
  }

  /** Server->client reverse get-stream: collect until StreamEnd. */
  getStreamFromClient(name: string, args: Value, window = 4): Promise<Value[]> {
    const rid = --this.nextServerRid;
    const conn = this.conn;
    return new Promise((resolve, reject) => {
      conn.reverseGets.set(rid, { collected: [], window, granted: 0, resolve, reject });
      conn.push(proto.request(MessageType.GetStreamRequest, rid, name, args, 0, undefined));
    });
  }

  /** Server->client reverse put-stream: send all values, then StreamEnd. */
  async putStreamToClient(name: string, args: Value, values: Value[]): Promise<void> {
    const rid = --this.nextServerRid;
    const conn = this.conn;
    const st: ServerStream = { credit: 0, waiters: [], canceled: false, received: [], endReceived: false };
    conn.reversePuts.set(rid, st);
    const ready = new Promise<void>((resolve, reject) => {
      conn.reverseReady.set(rid, { resolve, reject });
    });
    conn.push(proto.request(MessageType.PutStreamRequest, rid, name, args, 0, undefined));
    await ready;
    for (const v of values) {
      await this.acquire(st);
      if (st.canceled) return;
      conn.push(proto.streamValue(rid, v));
    }
    conn.push(proto.streamEnd(rid));
  }

  private acquire(st: ServerStream): Promise<void> {
    if (st.credit > 0) {
      st.credit--;
      return Promise.resolve();
    }
    return new Promise((resolve) => st.waiters.push(resolve));
  }

  grant(st: ServerStream, n: number): void {
    st.credit += n;
    while (st.credit > 0 && st.waiters.length > 0) {
      st.credit--;
      (st.waiters.shift() as () => void)();
    }
  }
}

interface ReverseGet {
  collected: Value[];
  window: number;
  granted: number;
  resolve: (values: Value[]) => void;
  reject: (err: Error) => void;
}

export class MockConnImpl implements MockConn {
  frames: ValueMap[] = [];
  handshake!: ValueMap;
  closed = false;
  clientTransport: Transport;
  pendingCalls = new Map<number, (r: { result?: Value; error?: ValueMap }) => void>();
  reverseGets = new Map<number, ReverseGet>();
  reversePuts = new Map<number, ServerStream>();
  reverseReady = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  private streams = new Map<number, ServerStream>();

  constructor(private readonly server: MockServer) {
    const self = this;
    this.clientTransport = {
      send(data) {
        // async hop like a real socket, so ordering bugs surface
        queueMicrotask(() => self.onClientFrame(self.server.codec.decode(data)));
      },
      close() {
        self.closed = true;
      },
      onMessage: null,
      onClose: null,
    };
  }

  push(env: ValueMap): void {
    if (this.closed) return;
    const data = this.server.codec.encode(env);
    queueMicrotask(() => this.clientTransport.onMessage?.(data));
  }

  drop(): void {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.clientTransport.onClose?.(new Error("connection reset")));
  }

  private onClientFrame(msg: ValueMap): void {
    if (this.closed) return;
    this.frames.push(msg);
    const mt = proto.messageType(msg);
    const rid = proto.requestId(msg) ?? 0;

    if (mt === MessageType.HandshakeRequest) {
      this.handshake = msg;
      this.server.handshakes.push(msg);
      if (this.server.authRejects) {
        this.drop(); // Go servers reject by closing the connection
        return;
      }
      this.push({ m: "vRPC", v: 1, t: MessageType.HandshakeResponse, rid: 0 });
      return;
    }

    // Replies to server-initiated (negative-rid) requests.
    if (rid < 0) {
      this.onReverseFrame(mt as MessageType, rid, msg);
      return;
    }

    switch (mt) {
      case MessageType.FunctionRequest: {
        const name = proto.functionName(msg) ?? "";
        const fn = this.server.functions.get(name);
        if (!fn) {
          this.push(proto.errorResponse(rid, 5, `function not found ${name}`));
          return;
        }
        void (async () => {
          try {
            const res = await fn(proto.args(msg));
            this.push(proto.functionResult(rid, res));
          } catch (err) {
            this.push(proto.errorResponse(rid, 9, String(err)));
          }
        })();
        return;
      }
      case MessageType.GetStreamRequest: {
        if (this.server.floodOnGet !== null) {
          // Misbehaving server: ack, then send values ignoring credit.
          this.push(proto.streamReady(rid));
          for (let i = 0; i < this.server.floodOnGet; i++) {
            this.push(proto.streamValue(rid, i));
          }
          return;
        }
        const name = proto.functionName(msg) ?? "";
        const gen = this.server.getStreams.get(name);
        if (!gen) {
          this.push(proto.errorResponse(rid, 5, `function not found ${name}`));
          return;
        }
        const st: ServerStream = { credit: 0, waiters: [], canceled: false, received: [], endReceived: false };
        this.streams.set(rid, st);
        this.push(proto.streamReady(rid));
        void (async () => {
          for (const v of gen(proto.args(msg))) {
            await new Promise<void>((resolve) => {
              if (st.credit > 0) {
                st.credit--;
                resolve();
              } else st.waiters.push(resolve);
            });
            if (st.canceled) return;
            this.push(proto.streamValue(rid, v));
          }
          if (!st.canceled) this.push(proto.streamEnd(rid));
        })();
        return;
      }
      case MessageType.PutStreamRequest:
      case MessageType.ChatRequest: {
        const st: ServerStream = { credit: 0, waiters: [], canceled: false, received: [], endReceived: false };
        this.streams.set(rid, st);
        // Mirrors the Go server: initial inbound credit BEFORE StreamReady.
        this.push(proto.streamCredit(rid, this.server.putWindow));
        this.push(proto.streamReady(rid));
        if (mt === MessageType.ChatRequest) {
          st.onEnd = () => {
            // chat.echo: echo everything back, then end our side
            void (async () => {
              for (const v of st.received) {
                this.push(proto.streamValue(rid, v));
              }
              this.push(proto.streamEnd(rid));
            })();
          };
        }
        return;
      }
      case MessageType.StreamValue: {
        const st = this.streams.get(rid);
        if (st) {
          st.received.push(proto.streamVal(msg));
          this.server.putReceived.push(proto.streamVal(msg));
          // replenish credit per consumed value (generous server)
          this.push(proto.streamCredit(rid, 1));
        }
        return;
      }
      case MessageType.StreamEnd: {
        const st = this.streams.get(rid);
        if (st) {
          st.endReceived = true;
          st.onEnd?.();
        }
        return;
      }
      case MessageType.StreamCredit: {
        const st = this.streams.get(rid);
        if (st) this.server.grant(st, proto.credit(msg) ?? 0);
        return;
      }
      case MessageType.CancelRequest: {
        const st = this.streams.get(rid);
        if (st) st.canceled = true;
        return;
      }
      default:
        return;
    }
  }

  private onReverseFrame(mt: MessageType, rid: number, msg: ValueMap): void {
    if (mt === MessageType.FunctionResponse || mt === MessageType.ErrorResponse) {
      // reverse get-streams can also fail via ErrorResponse
      const rg = this.reverseGets.get(rid);
      if (rg && mt === MessageType.ErrorResponse) {
        this.reverseGets.delete(rid);
        rg.reject(new Error(proto.errorOf(msg).message));
        return;
      }
      const waiter = this.pendingCalls.get(rid);
      if (waiter) {
        this.pendingCalls.delete(rid);
        if (mt === MessageType.ErrorResponse) waiter({ error: msg });
        else waiter({ result: proto.result(msg) });
      }
      const ready = this.reverseReady.get(rid);
      if (ready && mt === MessageType.ErrorResponse) {
        this.reverseReady.delete(rid);
        ready.reject(new Error(proto.errorOf(msg).message));
      }
      return;
    }
    if (mt === MessageType.StreamReady) {
      const rg = this.reverseGets.get(rid);
      if (rg) {
        // grant the initial window like servingClient.GetStream
        this.push(proto.streamCredit(rid, rg.window));
        rg.granted = rg.window;
      }
      this.reverseReady.get(rid)?.resolve();
      this.reverseReady.delete(rid);
      return;
    }
    if (mt === MessageType.StreamValue) {
      const rg = this.reverseGets.get(rid);
      if (rg) {
        rg.collected.push(proto.streamVal(msg));
        this.push(proto.streamCredit(rid, 1)); // consume + replenish
      }
      return;
    }
    if (mt === MessageType.StreamEnd) {
      const rg = this.reverseGets.get(rid);
      if (rg) {
        this.reverseGets.delete(rid);
        rg.resolve(rg.collected);
      }
      const st = this.reversePuts.get(rid);
      if (st) st.endReceived = true;
      return;
    }
    if (mt === MessageType.StreamCredit) {
      const st = this.reversePuts.get(rid);
      if (st) this.server.grant(st, proto.credit(msg) ?? 0);
      return;
    }
  }
}

export async function sha256hex(hexInput: string): Promise<string> {
  const bytes = new Uint8Array(hexInput.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hexInput.slice(i * 2, i * 2 + 2), 16);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  let out = "";
  for (const b of digest) out += b.toString(16).padStart(2, "0");
  return out;
}
