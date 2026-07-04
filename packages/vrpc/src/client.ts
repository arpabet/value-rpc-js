/*
 * Copyright (c) 2026 Karagatan LLC.
 * SPDX-License-Identifier: Apache-2.0
 */

import { codecByName, type CodecName, type WireCodec } from "./codec.js";
import { Code, VrpcError, codeOf, errClientClosed, errConnectionLost } from "./errors.js";
import { HashChain } from "./hashchain.js";
import { MessageType, Protocol, newDialect, type Dialect, type Metadata } from "./protocol.js";
import { webSocketDialer, type DialOptions, type Dialer, type Transport } from "./transport.js";
import type { Value, ValueMap } from "./value.js";
import {
  AsyncValueQueue,
  CreditGate,
  backoffDelay,
  deferred,
  randomClientId,
  sleep,
  type Deferred,
} from "./internal/async.js";

export type Status = "idle" | "connecting" | "open" | "resuming" | "closed";

export interface ReconnectOptions {
  /** Re-establish dropped connections automatically. Default true. */
  enabled?: boolean;
  /** First backoff delay. Default 300 ms. */
  initialDelayMs?: number;
  /** Backoff cap. Default 10 000 ms. */
  maxDelayMs?: number;
  /** Give up after this many consecutive failed attempts. Default Infinity. */
  maxAttempts?: number;
  /** Equal jitter (half fixed, half random), like the Go client. Default true. */
  jitter?: boolean;
}

export interface ClientOptions {
  /** WebSocket endpoint, e.g. "wss://example.com/rpc". */
  url: string;
  /**
   * Wire codec. "msgpack" (default) speaks to every value-rpc server —
   * binary frames, no subprotocol. "json" offers the "vrpc.json" subprotocol
   * and requires a server with JSON codec support (WEB.md phase 1).
   */
  codec?: CodecName | WireCodec;
  /**
   * Credential for the handshake `auth` field, validated by the server's
   * Authenticator. A function is re-evaluated on every (re)connect, so
   * refreshed tokens are picked up automatically.
   */
  auth?: Value | (() => Value | Promise<Value>);
  /** Default unary timeout / request SLA in ms. Default 5000. */
  timeoutMs?: number;
  /** Dial + handshake timeout in ms. Default 10 000. */
  connectTimeoutMs?: number;
  /** Metadata attached to every request (static or per-request factory). */
  metadata?: Metadata | ((name: string) => Metadata | undefined);
  reconnect?: boolean | ReconnectOptions;
  /**
   * Hash-chain session resumption (default true): reconnects present a
   * one-time token proving continuity, so the server reattaches the session.
   * When disabled, every connection is a fresh session with a fresh clientId.
   */
  resume?: boolean;
  /** Resumption chain length = max reconnects per session. Default 1024. */
  chainLength?: number;
  /** Per-stream receive window (flow-control credit). Default 4096. */
  maxPending?: number;
  /** Wire dialect overrides; must match the server's Dialect. */
  dialect?: Partial<Dialect>;
  /** WebSocket constructor override (tests, custom agents). */
  webSocket?: typeof WebSocket;
  /** Transport override (in-memory tests, future WebTransport). */
  dialer?: Dialer;
}

export interface CallOptions {
  /** Per-call timeout in ms; also sent to the server as the request SLA. */
  timeoutMs?: number;
  /** Abort maps to a vRPC CancelRequest toward the server. */
  signal?: AbortSignal;
  metadata?: Metadata;
}

/** A server->client stream (getStream): pull-based, credit-backed. */
export interface VrpcStream extends AsyncIterableIterator<Value> {
  readonly requestId: number;
  /** Resolves when the server acks the stream (StreamReady). */
  readonly ready: Promise<void>;
  /** Cancels the stream (sends CancelRequest); the iterator ends. */
  cancel(): void;
}

/** A bidirectional stream (chat). */
export interface VrpcChat extends AsyncIterable<Value> {
  readonly requestId: number;
  readonly ready: Promise<void>;
  readonly incoming: AsyncIterableIterator<Value>;
  /** Sends one value; awaits flow-control credit from the peer. */
  send(v: Value): Promise<void>;
  /** Half-closes our sending side (StreamEnd); receiving continues. */
  end(): void;
  /** Tears the whole chat down (CancelRequest). */
  cancel(): void;
}

export interface HandlerContext {
  readonly requestId: number;
  readonly metadata: Metadata | undefined;
  /** Aborted when the peer cancels the request or the connection drops. */
  readonly signal: AbortSignal;
}

export type UnaryHandler = (args: Value, ctx: HandlerContext) => Value | Promise<Value>;
export type OutgoingStreamHandler = (
  args: Value,
  ctx: HandlerContext,
) => Iterable<Value> | AsyncIterable<Value> | Promise<Iterable<Value> | AsyncIterable<Value>>;
export type IncomingStreamHandler = (
  args: Value,
  incoming: AsyncIterableIterator<Value>,
  ctx: HandlerContext,
) => void | Promise<void>;
export type ChatHandler = (
  args: Value,
  incoming: AsyncIterableIterator<Value>,
  ctx: HandlerContext,
) => Iterable<Value> | AsyncIterable<Value> | Promise<Iterable<Value> | AsyncIterable<Value>>;

export interface ClientEvents {
  status: (status: Status) => void;
  /** Fired per successful handshake with the server's handshake response. */
  open: (handshake: ValueMap) => void;
  close: () => void;
  /** Non-fatal protocol anomalies (unroutable or malformed frames). */
  error: (err: Error) => void;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_PENDING = 4096;

type HandlerKind = "unary" | "out" | "in" | "chat";

interface RegisteredHandler {
  kind: HandlerKind;
  fn: UnaryHandler | OutgoingStreamHandler | IncomingStreamHandler | ChatHandler;
}

/** One in-flight client-initiated request (positive request id). */
class PendingRequest {
  ready: Deferred<void> = deferred<void>();
  queue: AsyncValueQueue<Value> | null = null;
  sendCredit: CreditGate | null = null;
  unary: Deferred<Value> | null = null;
  timer: ReturnType<typeof setTimeout> | null = null;
  error: VrpcError | null = null;
  getClosed = false;
  putClosed = false;
  delivered = 0;

  constructor(
    readonly requestId: number,
    readonly kind: "unary" | "get" | "put" | "chat",
    readonly name: string,
    readonly window: number,
  ) {
    if (kind === "unary") this.unary = deferred<Value>();
    if (kind === "get" || kind === "chat") this.queue = new AsyncValueQueue<Value>(window, () => this.onConsume?.());
    if (kind === "put" || kind === "chat") this.sendCredit = new CreditGate();
    // A pending request's promises may be settled by teardown paths nobody
    // awaits anymore (e.g. cancel after the consumer left); keep those from
    // surfacing as unhandled rejections.
    this.ready.promise.catch(() => {});
    this.unary?.promise.catch(() => {});
  }

  onConsume: (() => void) | null = null;

  fail(err: VrpcError): void {
    this.error = err;
    this.ready.reject(err);
    this.unary?.reject(err);
    this.queue?.fail(err);
    this.sendCredit?.close();
    this.getClosed = true;
    this.putClosed = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Graceful teardown without an error (server cancel / normal close). */
  finish(): void {
    this.ready.reject(this.error ?? new VrpcError(Code.Canceled, `request ${this.requestId} closed`));
    this.unary?.reject(this.error ?? new VrpcError(Code.Canceled, `request ${this.requestId} closed`));
    this.queue?.end();
    this.sendCredit?.close();
    this.getClosed = true;
    this.putClosed = true;
    if (this.timer) clearTimeout(this.timer);
  }
}

/** One stream/call this client serves for the peer (negative request id). */
class ServingRequest {
  inQueue: AsyncValueQueue<Value> | null = null;
  sendCredit: CreditGate | null = null;
  abort = new AbortController();
  delivered = 0;
  closed = false;

  constructor(
    readonly requestId: number,
    readonly kind: HandlerKind,
    readonly window: number,
  ) {
    if (kind === "in" || kind === "chat") {
      this.inQueue = new AsyncValueQueue<Value>(window, () => this.onConsume?.());
    }
    if (kind === "out" || kind === "chat") this.sendCredit = new CreditGate();
  }

  onConsume: (() => void) | null = null;

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    this.sendCredit?.close();
    this.inQueue?.abort();
  }
}

interface ResolvedReconnect {
  enabled: boolean;
  initialDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
  jitter: boolean;
}

/**
 * A value-rpc client over WebSocket. Symmetric peer: it calls the server
 * (call / getStream / putStream / chat) and serves the server's reverse
 * calls (addFunction / addOutgoingStream / addIncomingStream / addChat).
 */
export class VrpcClient {
  readonly protocol: Protocol;
  private readonly codec: WireCodec;
  private readonly opts: ClientOptions;
  private readonly reconnect: ResolvedReconnect;
  private readonly timeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly maxPending: number;
  private readonly dialer: Dialer;

  private _status: Status = "idle";
  private _clientId = randomClientId();
  private transport: Transport | null = null;
  private chain: HashChain | null = null;
  private established = false;
  private nextRequestId = 0;
  private reconnects = 0;

  private pending = new Map<number, PendingRequest>();
  private serving = new Map<number, ServingRequest>();
  private handlers = new Map<string, RegisteredHandler>();
  private listeners = new Map<keyof ClientEvents, Set<(...args: never[]) => void>>();

  private connectPromise: Promise<void> | null = null;
  private resumeAbort: AbortController | null = null;
  private openWaiters: Deferred<void>[] = [];
  private handshakeWaiter: Deferred<ValueMap> | null = null;
  private handshakeTransport: Transport | null = null;
  private hintsInstalled = false;

  constructor(options: ClientOptions) {
    this.opts = options;
    this.codec =
      typeof options.codec === "object" ? options.codec : codecByName(options.codec ?? "msgpack");
    this.protocol = new Protocol({ ...newDialect(), ...options.dialect });
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
    this.dialer = options.dialer ?? webSocketDialer;
    const rc = options.reconnect;
    this.reconnect = {
      enabled: rc === false ? false : ((rc === true || rc === undefined ? undefined : rc.enabled) ?? true),
      initialDelayMs: (typeof rc === "object" && rc.initialDelayMs) || 300,
      maxDelayMs: (typeof rc === "object" && rc.maxDelayMs) || 10_000,
      maxAttempts: (typeof rc === "object" && rc.maxAttempts) || Infinity,
      jitter: typeof rc === "object" ? (rc.jitter ?? true) : true,
    };
  }

  get status(): Status {
    return this._status;
  }

  get connected(): boolean {
    return this._status === "open";
  }

  get clientId(): number {
    return this._clientId;
  }

  get codecName(): CodecName {
    return this.codec.name;
  }

  stats(): { requests: number; reconnects: number; pending: number; serving: number } {
    return {
      requests: this.nextRequestId,
      reconnects: this.reconnects,
      pending: this.pending.size,
      serving: this.serving.size,
    };
  }

  // ------------------------------------------------------------------ events

  on<E extends keyof ClientEvents>(event: E, fn: ClientEvents[E]): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn as (...args: never[]) => void);
    return () => set.delete(fn as (...args: never[]) => void);
  }

  private emit<E extends keyof ClientEvents>(event: E, ...args: Parameters<ClientEvents[E]>): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        (fn as (...a: Parameters<ClientEvents[E]>) => void)(...args);
      } catch {
        // listener errors must not break the dispatch loop
      }
    }
  }

  private setStatus(s: Status): void {
    if (this._status === s) return;
    this._status = s;
    this.emit("status", s);
    if (s === "open") {
      const waiters = this.openWaiters;
      this.openWaiters = [];
      for (const w of waiters) w.resolve();
    }
    if (s === "closed") {
      const waiters = this.openWaiters;
      this.openWaiters = [];
      for (const w of waiters) w.reject(errClientClosed());
      this.emit("close");
    }
  }

  // -------------------------------------------------------------- connection

  /** Connects (idempotent). Calls also auto-connect on first use. */
  async connect(): Promise<void> {
    if (this._status === "open") return;
    if (this._status === "closed") throw errClientClosed();
    if (!this.connectPromise) {
      this.setStatus(this._status === "resuming" ? "resuming" : "connecting");
      this.connectPromise = this.doConnect().finally(() => {
        this.connectPromise = null;
      });
    }
    return this.connectPromise;
  }

  private async handshakeToken(): Promise<string> {
    if (this.opts.resume === false) {
      // Without resumption every connection must be a fresh session: a known
      // clientId with no valid chain link would be rejected by the server.
      if (this.established) this._clientId = randomClientId();
      return "";
    }
    if (!this.chain) {
      this.chain = await HashChain.create(this.opts.chainLength ?? HashChain.DEFAULT_LENGTH);
    }
    if (!this.established) return this.chain.anchor();
    const tok = this.chain.nextToken();
    if (tok !== "") return tok;
    // Chain exhausted: transparently start a fresh session (new identity).
    this._clientId = randomClientId();
    this.chain = await HashChain.create(this.opts.chainLength ?? HashChain.DEFAULT_LENGTH);
    this.established = false;
    return this.chain.anchor();
  }

  private async doConnect(): Promise<void> {
    const token = await this.handshakeToken();
    const authOpt = this.opts.auth;
    const auth = typeof authOpt === "function" ? await (authOpt as () => Value | Promise<Value>)() : authOpt;

    const dialOpts: DialOptions = {
      url: this.opts.url,
      subprotocols: this.codec.subprotocols,
      timeoutMs: this.connectTimeoutMs,
    };
    if (this.opts.webSocket) dialOpts.webSocket = this.opts.webSocket;
    const transport = await this.dialer(dialOpts);

    if (this._status === "closed") {
      transport.close();
      throw errClientClosed();
    }

    const hs = deferred<ValueMap>();
    this.handshakeWaiter = hs;
    this.handshakeTransport = transport;
    transport.onMessage = (data) => this.onFrame(transport, data);
    transport.onClose = (err) => this.onTransportClose(transport, err);
    try {
      transport.send(this.codec.encode(this.protocol.handshakeRequest(this._clientId, token, auth ?? null)));
      const timer = setTimeout(
        () => hs.reject(new VrpcError(Code.DeadlineExceeded, `handshake timed out after ${this.connectTimeoutMs}ms`)),
        this.connectTimeoutMs,
      );
      let resp: ValueMap;
      try {
        resp = await hs.promise;
      } finally {
        clearTimeout(timer);
        this.handshakeWaiter = null;
        this.handshakeTransport = null;
      }
      this.transport = transport;
      this.established = true;
      this.setStatus("open");
      this.installBrowserHints();
      this.emit("open", resp);
    } catch (err) {
      this.handshakeWaiter = null;
      this.handshakeTransport = null;
      transport.onClose = null;
      transport.close();
      throw err instanceof VrpcError
        ? err
        : new VrpcError(Code.Unavailable, `handshake failed: ${String(err)}`, { cause: err });
    }
  }

  /** Waits until the client is open, connecting if idle. */
  private async ensureOpen(signal?: AbortSignal): Promise<void> {
    if (this._status === "open") return;
    if (this._status === "closed") throw errClientClosed();
    if (this._status === "idle") {
      await this.connect();
      return;
    }
    // connecting / resuming: wait for the in-flight attempt (bounded by the
    // caller's timeout/signal, which the caller applies around the whole op).
    const d = deferred<void>();
    this.openWaiters.push(d);
    if (signal) {
      const onAbort = (): void => d.reject(new VrpcError(Code.Canceled, "aborted while waiting for connection"));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    await d.promise;
  }

  private onTransportClose(transport: Transport, err?: Error): void {
    if (transport !== this.transport) {
      // A handshake-in-progress connection failing, or a stale one closing.
      if (transport === this.handshakeTransport) {
        this.handshakeWaiter?.reject(err ?? errConnectionLost());
      }
      return;
    }
    this.transport = null;
    this.failAllInFlight(errConnectionLost());
    if (this._status === "closed") return;
    if (!this.reconnect.enabled) {
      this.setStatus("closed");
      return;
    }
    void this.resumeLoop();
  }

  private async resumeLoop(): Promise<void> {
    if (this.resumeAbort) return; // already resuming
    const abort = new AbortController();
    this.resumeAbort = abort;
    this.setStatus("resuming");
    try {
      for (let attempt = 1; attempt <= this.reconnect.maxAttempts; attempt++) {
        await sleep(backoffDelay(attempt, this.reconnect), abort.signal);
        if (abort.signal.aborted || this._status === "closed") return;
        this.reconnects++;
        try {
          await this.connect();
          return;
        } catch {
          // next attempt
        }
      }
      this.setStatus("closed");
    } finally {
      this.resumeAbort = null;
    }
  }

  /** Browser wake hints: retry immediately when connectivity likely returned. */
  private installBrowserHints(): void {
    if (this.hintsInstalled || typeof window === "undefined" || typeof window.addEventListener !== "function") {
      return;
    }
    this.hintsInstalled = true;
    const hint = (): void => {
      if (this._status === "resuming") this.resumeAbort?.abort();
    };
    window.addEventListener("online", hint);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") hint();
      });
    }
  }

  private failAllInFlight(err: VrpcError): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) p.fail(err);
    const serving = [...this.serving.values()];
    this.serving.clear();
    for (const s of serving) s.close();
  }

  /** Closes the client permanently. */
  close(): void {
    if (this._status === "closed") return;
    this.resumeAbort?.abort();
    this.handshakeWaiter?.reject(errClientClosed());
    const t = this.transport;
    this.transport = null;
    this.setStatus("closed");
    this.failAllInFlight(errClientClosed());
    t?.close();
  }

  // ---------------------------------------------------------------- sending

  private sendFrame(env: ValueMap): void {
    const t = this.transport;
    if (!t) throw errConnectionLost();
    t.send(this.codec.encode(env));
  }

  private trySendFrame(env: ValueMap): void {
    try {
      this.sendFrame(env);
    } catch {
      // best-effort system message on a dying connection
    }
  }

  cancelRequest(requestId: number): void {
    this.trySendFrame(this.protocol.cancelRequest(requestId));
  }

  private buildMetadata(name: string, callMd?: Metadata): Metadata | undefined {
    const base =
      typeof this.opts.metadata === "function" ? this.opts.metadata(name) : this.opts.metadata;
    if (!base && !callMd) return undefined;
    return { ...base, ...callMd };
  }

  // ------------------------------------------------------------------ unary

  /** Calls a unary function on the server. */
  async call(name: string, args?: Value, opts: CallOptions = {}): Promise<Value> {
    await this.ensureOpen(opts.signal);
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const rid = ++this.nextRequestId;
    const p = new PendingRequest(rid, "unary", name, 1);
    this.pending.set(rid, p);

    const settle = (): void => {
      if (p.timer) clearTimeout(p.timer);
      this.pending.delete(rid);
    };
    if (timeoutMs > 0) {
      p.timer = setTimeout(() => {
        this.cancelRequest(rid);
        p.fail(new VrpcError(Code.DeadlineExceeded, `call ${name} timed out after ${timeoutMs}ms`));
        settle();
      }, timeoutMs);
    }
    if (opts.signal) {
      const onAbort = (): void => {
        this.cancelRequest(rid);
        p.fail(new VrpcError(Code.Canceled, `call ${name} aborted`));
        settle();
      };
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      this.sendFrame(
        this.protocol.request(MessageType.FunctionRequest, rid, name, args, timeoutMs, this.buildMetadata(name, opts.metadata)),
      );
    } catch (err) {
      p.fail(err instanceof VrpcError ? err : errConnectionLost());
      settle();
    }

    try {
      return await (p.unary as Deferred<Value>).promise;
    } finally {
      settle();
    }
  }

  // ---------------------------------------------------------------- streams

  /**
   * Opens a server->client stream. Consume with `for await`; breaking out of
   * the loop cancels the stream. Credit is granted as values are consumed, so
   * a slow consumer applies real backpressure to the server.
   */
  getStream(name: string, args?: Value, opts: CallOptions = {}): VrpcStream {
    const rid = ++this.nextRequestId;
    const p = new PendingRequest(rid, "get", name, this.maxPending);
    return this.openConsumingStream(p, MessageType.GetStreamRequest, name, args, opts);
  }

  private openConsumingStream(
    p: PendingRequest,
    mt: MessageType.GetStreamRequest | MessageType.ChatRequest,
    name: string,
    args: Value | undefined,
    opts: CallOptions,
  ): VrpcStream {
    const rid = p.requestId;
    this.pending.set(rid, p);
    p.onConsume = () => {
      p.delivered++;
      const batch = Math.max(1, Math.floor(p.window / 2));
      if (p.delivered >= batch) {
        const n = p.delivered;
        p.delivered = 0;
        this.trySendFrame(this.protocol.streamCredit(rid, n));
      }
    };

    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    void this.establishStream(p, mt, name, args, timeoutMs, opts);

    const self = this;
    const iterator: VrpcStream = {
      requestId: rid,
      ready: p.ready.promise,
      async next(): Promise<IteratorResult<Value>> {
        const q = p.queue as AsyncValueQueue<Value>;
        const res = await q.next();
        if (res.done) self.retireGetSide(p);
        return res;
      },
      async return(value?: Value): Promise<IteratorResult<Value>> {
        iterator.cancel();
        return { value: value as Value, done: true };
      },
      async throw(err?: unknown): Promise<IteratorResult<Value>> {
        iterator.cancel();
        throw err;
      },
      cancel(): void {
        if (p.getClosed && p.putClosed) return;
        self.cancelRequest(rid);
        p.finish();
        self.pending.delete(rid);
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    return iterator;
  }

  private async establishStream(
    p: PendingRequest,
    mt: MessageType,
    name: string,
    args: Value | undefined,
    timeoutMs: number,
    opts: CallOptions,
  ): Promise<void> {
    const rid = p.requestId;
    try {
      await this.ensureOpen(opts.signal);
      const establishTimer = setTimeout(() => {
        if (!p.getClosed) {
          this.cancelRequest(rid);
          p.fail(new VrpcError(Code.DeadlineExceeded, `stream ${name} was not acked within ${timeoutMs}ms`));
          this.pending.delete(rid);
        }
      }, timeoutMs);
      p.ready.promise.then(
        () => clearTimeout(establishTimer),
        () => clearTimeout(establishTimer),
      );
      if (opts.signal) {
        const onAbort = (): void => {
          this.cancelRequest(rid);
          p.fail(new VrpcError(Code.Canceled, `stream ${name} aborted`));
          this.pending.delete(rid);
        };
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener("abort", onAbort, { once: true });
      }
      this.sendFrame(
        this.protocol.request(mt, rid, name, args, timeoutMs, this.buildMetadata(name, opts.metadata)),
      );
      // The initial receive window is granted once the peer acks the stream.
      if (p.queue) {
        p.ready.promise.then(
          () => this.trySendFrame(this.protocol.streamCredit(rid, p.window)),
          () => {},
        );
      }
    } catch (err) {
      p.fail(err instanceof VrpcError ? err : new VrpcError(Code.Unavailable, String(err), { cause: err }));
      this.pending.delete(rid);
    }
  }

  private retireGetSide(p: PendingRequest): void {
    p.getClosed = true;
    if (p.kind !== "chat" || p.putClosed) this.pending.delete(p.requestId);
  }

  /**
   * Opens a client->server stream and sends every value from source, honoring
   * the server's flow-control credit. Resolves once the stream ended cleanly.
   */
  async putStream(
    name: string,
    args: Value | undefined,
    source: Iterable<Value> | AsyncIterable<Value>,
    opts: CallOptions = {},
  ): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    await this.ensureOpen(opts.signal);
    const rid = ++this.nextRequestId;
    const p = new PendingRequest(rid, "put", name, 1);
    this.pending.set(rid, p);

    const abortErr = (): VrpcError => p.error ?? new VrpcError(Code.Canceled, `stream ${name} aborted`);
    if (opts.signal) {
      const onAbort = (): void => {
        this.cancelRequest(rid);
        p.fail(new VrpcError(Code.Canceled, `stream ${name} aborted`));
        this.pending.delete(rid);
      };
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      const establishTimer = setTimeout(() => {
        if (!p.putClosed) {
          this.cancelRequest(rid);
          p.fail(new VrpcError(Code.DeadlineExceeded, `stream ${name} was not acked within ${timeoutMs}ms`));
          this.pending.delete(rid);
        }
      }, timeoutMs);
      p.ready.promise.then(
        () => clearTimeout(establishTimer),
        () => clearTimeout(establishTimer),
      );
      this.sendFrame(
        this.protocol.request(MessageType.PutStreamRequest, rid, name, args, timeoutMs, this.buildMetadata(name, opts.metadata)),
      );
      await p.ready.promise;

      for await (const v of source) {
        const gate = p.sendCredit as CreditGate;
        const ok = await gate.acquire();
        if (!ok) throw abortErr();
        this.sendFrame(this.protocol.streamValue(rid, v));
      }
      this.sendFrame(this.protocol.streamEnd(rid));
      p.putClosed = true;
    } finally {
      p.finish();
      this.pending.delete(rid);
    }
  }

  /** Opens a bidirectional stream (chat). */
  chat(name: string, args?: Value, opts: CallOptions = {}): VrpcChat {
    const rid = ++this.nextRequestId;
    const p = new PendingRequest(rid, "chat", name, this.maxPending);
    const stream = this.openConsumingStream(p, MessageType.ChatRequest, name, args, opts);
    const self = this;
    let ended = false;

    return {
      requestId: rid,
      ready: p.ready.promise,
      incoming: stream,
      async send(v: Value): Promise<void> {
        if (ended) throw new VrpcError(Code.Internal, `chat ${name}: send after end`);
        await p.ready.promise;
        const ok = await (p.sendCredit as CreditGate).acquire();
        if (!ok) throw p.error ?? errConnectionLost();
        self.sendFrame(self.protocol.streamValue(rid, v));
      },
      end(): void {
        if (ended || p.putClosed) return;
        ended = true;
        p.ready.promise.then(
          () => {
            if (!p.putClosed) {
              p.putClosed = true;
              self.trySendFrame(self.protocol.streamEnd(rid));
              if (p.getClosed) self.pending.delete(rid);
            }
          },
          () => {},
        );
      },
      cancel(): void {
        ended = true;
        stream.cancel();
      },
      [Symbol.asyncIterator]() {
        return stream;
      },
    };
  }

  // ------------------------------------------------- reverse-call registrar

  /** Registers a unary function the server may call on this client. */
  addFunction(name: string, fn: UnaryHandler): void {
    this.handlers.set(name, { kind: "unary", fn });
  }

  /** Registers a stream the server can consume from this client (GetStream). */
  addOutgoingStream(name: string, fn: OutgoingStreamHandler): void {
    this.handlers.set(name, { kind: "out", fn });
  }

  /** Registers a stream the server can send to this client (PutStream). */
  addIncomingStream(name: string, fn: IncomingStreamHandler): void {
    this.handlers.set(name, { kind: "in", fn });
  }

  /** Registers a bidirectional stream the server can open (Chat). */
  addChat(name: string, fn: ChatHandler): void {
    this.handlers.set(name, { kind: "chat", fn });
  }

  removeHandler(name: string): void {
    this.handlers.delete(name);
  }

  // ------------------------------------------------------------- dispatch

  private onFrame(transport: Transport, data: Uint8Array | string): void {
    if (transport !== this.transport && transport !== this.handshakeTransport) return; // stale connection
    let msg: ValueMap;
    try {
      msg = this.codec.decode(data);
    } catch (err) {
      // A malformed frame is a broken peer or transport: mirror the Go
      // client, where a decode failure kills the connection.
      this.emit("error", new VrpcError(Code.Internal, `malformed frame: ${String(err)}`, { cause: err }));
      this.handshakeWaiter?.reject(new VrpcError(Code.Internal, `malformed handshake frame: ${String(err)}`));
      transport.onClose = null;
      transport.close();
      this.onTransportClose(transport, errConnectionLost());
      return;
    }

    const mt = this.protocol.messageType(msg);
    if (mt === undefined) {
      this.emit("error", new VrpcError(Code.Internal, "message type not found"));
      return;
    }

    if (mt === MessageType.HandshakeResponse) {
      this.handshakeWaiter?.resolve(msg);
      return;
    }
    if (mt === MessageType.FunctionRequest) {
      this.serveInboundCall(msg);
      return;
    }
    if (
      mt === MessageType.GetStreamRequest ||
      mt === MessageType.PutStreamRequest ||
      mt === MessageType.ChatRequest
    ) {
      this.serveInboundStream(mt, msg);
      return;
    }

    const rid = this.protocol.requestId(msg);
    if (rid === undefined) {
      this.emit("error", new VrpcError(Code.Internal, "request id not found"));
      return;
    }

    const sr = this.serving.get(rid);
    if (sr) {
      this.serveRunning(sr, mt, msg);
      return;
    }
    const p = this.pending.get(rid);
    if (p) {
      this.processResponse(p, mt, msg);
      return;
    }
    // A late frame for a finished request is routine (e.g. values in flight
    // after a cancel); everything else is worth surfacing.
    if (mt !== MessageType.StreamValue && mt !== MessageType.StreamEnd && mt !== MessageType.CancelRequest) {
      this.emit("error", new VrpcError(Code.Internal, `no request ${rid} for message type ${mt}`));
    }
  }

  private processResponse(p: PendingRequest, mt: MessageType, msg: ValueMap): void {
    switch (mt) {
      case MessageType.FunctionResponse: {
        p.unary?.resolve(this.protocol.result(msg));
        this.pending.delete(p.requestId);
        break;
      }
      case MessageType.ErrorResponse: {
        const { code, message } = this.protocol.errorOf(msg);
        p.fail(new VrpcError(code, message || "server error"));
        this.pending.delete(p.requestId);
        break;
      }
      case MessageType.StreamReady: {
        p.ready.resolve();
        break;
      }
      case MessageType.StreamValue: {
        const v = this.protocol.streamVal(msg);
        if (v === null || !p.queue) break;
        if (!p.queue.push(v)) {
          if (!p.queue.isEnded) {
            // The server ignored its credit and overran the window.
            const err = new VrpcError(
              Code.ResourceExhausted,
              `stream ${p.requestId} truncated: server exceeded flow-control credit`,
            );
            this.cancelRequest(p.requestId);
            p.fail(err);
            this.pending.delete(p.requestId);
          }
        }
        break;
      }
      case MessageType.StreamEnd: {
        const v = this.protocol.streamVal(msg);
        if (v !== null && p.queue) p.queue.push(v);
        p.queue?.end();
        p.getClosed = true;
        p.ready.resolve(); // a stream may legally end before delivering values
        if (p.kind !== "chat" || p.putClosed) this.pending.delete(p.requestId);
        break;
      }
      case MessageType.CancelRequest: {
        p.finish();
        this.pending.delete(p.requestId);
        break;
      }
      case MessageType.StreamCredit: {
        const cr = this.protocol.credit(msg);
        if (cr !== undefined) p.sendCredit?.grant(cr);
        break;
      }
      default:
        this.emit("error", new VrpcError(Code.Internal, `unsupported message type ${mt}`));
    }
  }

  // ------------------------------------------------------- reverse serving

  private handlerCtx(sr: ServingRequest, msg: ValueMap): HandlerContext {
    return {
      requestId: sr.requestId,
      metadata: this.protocol.metadata(msg),
      signal: sr.abort.signal,
    };
  }

  private serveInboundCall(msg: ValueMap): void {
    const rid = this.protocol.requestId(msg);
    if (rid === undefined) {
      this.emit("error", new VrpcError(Code.Internal, "reverse call without request id"));
      return;
    }
    const name = this.protocol.functionName(msg);
    if (name === undefined) {
      this.trySendFrame(this.protocol.errorResponse(rid, Code.InvalidArgument, "function name field not found"));
      return;
    }
    const h = this.handlers.get(name);
    if (!h) {
      this.trySendFrame(this.protocol.errorResponse(rid, Code.NotFound, `function not found ${name}`));
      return;
    }
    if (h.kind !== "unary") {
      this.trySendFrame(this.protocol.errorResponse(rid, Code.InvalidArgument, `function '${name}' is not unary`));
      return;
    }
    const sr = new ServingRequest(rid, "unary", 1);
    const args = this.protocol.args(msg);
    void (async () => {
      try {
        const res = await (h.fn as UnaryHandler)(args, this.handlerCtx(sr, msg));
        this.trySendFrame(this.protocol.functionResult(rid, res ?? null));
      } catch (err) {
        this.trySendFrame(
          this.protocol.errorResponse(rid, handlerCode(err), `function ${name}: ${errMessage(err)}`),
        );
      }
    })();
  }

  private serveInboundStream(mt: MessageType, msg: ValueMap): void {
    const rid = this.protocol.requestId(msg);
    if (rid === undefined) {
      this.emit("error", new VrpcError(Code.Internal, "reverse stream without request id"));
      return;
    }
    const name = this.protocol.functionName(msg);
    if (name === undefined) {
      this.trySendFrame(this.protocol.errorResponse(rid, Code.InvalidArgument, "function name field not found"));
      return;
    }
    const wanted: HandlerKind =
      mt === MessageType.GetStreamRequest ? "out" : mt === MessageType.PutStreamRequest ? "in" : "chat";
    const h = this.handlers.get(name);
    if (!h) {
      this.trySendFrame(this.protocol.errorResponse(rid, Code.NotFound, `function not found ${name}`));
      return;
    }
    if (h.kind !== wanted) {
      this.trySendFrame(this.protocol.errorResponse(rid, Code.InvalidArgument, `function '${name}' wrong stream type`));
      return;
    }

    const sr = new ServingRequest(rid, wanted, this.maxPending);
    this.serving.set(rid, sr);
    const args = this.protocol.args(msg);
    const ctx = this.handlerCtx(sr, msg);

    // Inbound side (in/chat): grant the initial window immediately — the
    // request is registered, so a racing first value cannot be lost.
    if (sr.inQueue) {
      sr.onConsume = () => {
        sr.delivered++;
        const batch = Math.max(1, Math.floor(sr.window / 2));
        if (sr.delivered >= batch) {
          const n = sr.delivered;
          sr.delivered = 0;
          this.trySendFrame(this.protocol.streamCredit(rid, n));
        }
      };
      this.trySendFrame(this.protocol.streamCredit(rid, sr.window));
    }

    const incoming = sr.inQueue ? queueIterator(sr.inQueue) : emptyIterator();

    void (async () => {
      try {
        if (wanted === "in") {
          this.trySendFrame(this.protocol.streamReady(rid));
          await (h.fn as IncomingStreamHandler)(args, incoming, ctx);
          return;
        }
        const iterable = await (h.fn as OutgoingStreamHandler | ChatHandler)(args, incoming as never, ctx);
        this.trySendFrame(this.protocol.streamReady(rid));
        for await (const v of iterable as AsyncIterable<Value>) {
          const gate = sr.sendCredit as CreditGate;
          const ok = await gate.acquire();
          if (!ok || sr.closed) return;
          this.trySendFrame(this.protocol.streamValue(rid, v));
        }
        this.trySendFrame(this.protocol.streamEnd(rid));
      } catch (err) {
        if (!sr.closed) {
          this.trySendFrame(
            this.protocol.errorResponse(rid, handlerCode(err), `${kindLabel(wanted)} ${name}: ${errMessage(err)}`),
          );
        }
      } finally {
        // For chat/out, our output finishing is the terminal event (mirrors
        // the Go responder). For "in" the terminal is the peer's StreamEnd,
        // handled in serveRunning; a handler that returns early just stops
        // consuming.
        if (wanted !== "in") {
          this.serving.delete(rid);
          sr.close();
        }
      }
    })();
  }

  private serveRunning(sr: ServingRequest, mt: MessageType, msg: ValueMap): void {
    switch (mt) {
      case MessageType.CancelRequest: {
        this.serving.delete(sr.requestId);
        sr.close();
        break;
      }
      case MessageType.StreamValue: {
        const v = this.protocol.streamVal(msg);
        if (v === null || !sr.inQueue) break;
        if (!sr.inQueue.push(v) && !sr.inQueue.isEnded) {
          this.trySendFrame(
            this.protocol.errorResponse(
              sr.requestId,
              Code.ResourceExhausted,
              `inbound stream ${sr.requestId} truncated: peer exceeded flow-control credit`,
            ),
          );
          this.serving.delete(sr.requestId);
          sr.close();
        }
        break;
      }
      case MessageType.StreamEnd: {
        const v = this.protocol.streamVal(msg);
        if (v !== null && sr.inQueue) sr.inQueue.push(v);
        sr.inQueue?.end();
        // For chat the peer ending its input must not tear down our output.
        if (sr.kind !== "chat") this.serving.delete(sr.requestId);
        break;
      }
      case MessageType.StreamCredit: {
        const cr = this.protocol.credit(msg);
        if (cr !== undefined) sr.sendCredit?.grant(cr);
        break;
      }
      case MessageType.ErrorResponse: {
        const { code, message } = this.protocol.errorOf(msg);
        this.emit("error", new VrpcError(code, `reverse stream ${sr.requestId}: ${message}`));
        this.serving.delete(sr.requestId);
        sr.close();
        break;
      }
      default:
        this.emit("error", new VrpcError(Code.Internal, `unsupported message type ${mt} for serving request`));
    }
  }
}

function handlerCode(err: unknown): Code {
  const c = codeOf(err);
  return c === Code.Unknown ? Code.Internal : c;
}

function errMessage(err: unknown): string {
  if (err instanceof VrpcError) return err.detail;
  if (err instanceof Error) return err.message;
  return String(err);
}

function kindLabel(kind: HandlerKind): string {
  switch (kind) {
    case "out":
      return "out stream";
    case "in":
      return "in stream";
    case "chat":
      return "chat";
    default:
      return "function";
  }
}

function queueIterator(q: AsyncValueQueue<Value>): AsyncIterableIterator<Value> {
  return {
    next: () => q.next(),
    async return(value?: Value): Promise<IteratorResult<Value>> {
      q.abort();
      return { value: value as Value, done: true };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

function emptyIterator(): AsyncIterableIterator<Value> {
  return {
    next: () => Promise.resolve({ value: undefined as never, done: true }),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

/** Creates a {@link VrpcClient}. The client connects lazily on first call. */
export function createClient(options: ClientOptions): VrpcClient {
  return new VrpcClient(options);
}
