/*
 * Copyright (c) 2026 Karagatan LLC.
 * SPDX-License-Identifier: Apache-2.0
 */

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (err: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * The sender side of credit-based stream flow control, mirroring
 * valuerpc.CreditGate: acquire() resolves once the peer has granted credit
 * (or resolves false when the gate closes on teardown).
 */
export class CreditGate {
  private credit = 0;
  private closed = false;
  private waiters: Deferred<boolean>[] = [];

  acquire(): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    if (this.credit > 0) {
      this.credit--;
      return Promise.resolve(true);
    }
    const d = deferred<boolean>();
    this.waiters.push(d);
    return d.promise;
  }

  grant(n: number): void {
    if (n <= 0 || this.closed) return;
    this.credit += n;
    while (this.credit > 0 && this.waiters.length > 0) {
      this.credit--;
      (this.waiters.shift() as Deferred<boolean>).resolve(true);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters) w.resolve(false);
    this.waiters = [];
  }
}

/**
 * A bounded push/async-pull queue: the receive side of a stream. push() never
 * blocks (it reports overflow past maxPending — the peer overran its credit);
 * next() pulls at the consumer's pace and fires onConsume per delivered value,
 * which is where receive credit gets replenished (pull-based backpressure).
 */
export class AsyncValueQueue<T> {
  private buf: T[] = [];
  private waiter: Deferred<IteratorResult<T>> | null = null;
  private ended = false;
  private failure: unknown = null;

  constructor(
    private readonly maxPending: number,
    private readonly onConsume?: () => void,
  ) {}

  /** Queues a value; false means the queue is finished or overflowed. */
  push(v: T): boolean {
    if (this.ended) return false;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w.resolve({ value: v, done: false });
      this.onConsume?.();
      return true;
    }
    if (this.buf.length >= this.maxPending) return false;
    this.buf.push(v);
    return true;
  }

  /** Graceful end-of-stream: buffered values still drain to the consumer. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.waiter && this.buf.length === 0) {
      const w = this.waiter;
      this.waiter = null;
      if (this.failure != null) w.reject(this.failure);
      else w.resolve({ value: undefined as never, done: true });
    }
  }

  /** Ends the stream with an error; buffered values still drain first. */
  fail(err: unknown): void {
    if (this.ended) return;
    this.failure = err;
    this.end();
  }

  /** Hard stop: discards buffered values and ends immediately. */
  abort(err?: unknown): void {
    this.buf = [];
    if (this.ended && !this.waiter) return;
    this.ended = true;
    if (err !== undefined) this.failure = err;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      if (this.failure != null) w.reject(this.failure);
      else w.resolve({ value: undefined as never, done: true });
    }
  }

  get isEnded(): boolean {
    return this.ended;
  }

  next(): Promise<IteratorResult<T>> {
    if (this.buf.length > 0) {
      const v = this.buf.shift() as T;
      this.onConsume?.();
      return Promise.resolve({ value: v, done: false });
    }
    if (this.ended) {
      return this.failure != null ? Promise.reject(this.failure) : Promise.resolve({ value: undefined as never, done: true });
    }
    if (this.waiter) {
      return Promise.reject(new Error("vrpc: concurrent reads from a single stream consumer"));
    }
    this.waiter = deferred<IteratorResult<T>>();
    return this.waiter.promise;
  }
}

export interface BackoffOptions {
  initialDelayMs: number;
  maxDelayMs: number;
  /** Equal jitter: half fixed, half random (mirrors the Go client). */
  jitter: boolean;
}

export function backoffDelay(attempt: number, opts: BackoffOptions): number {
  let delay = opts.initialDelayMs * 2 ** Math.max(0, attempt - 1);
  if (delay > opts.maxDelayMs) delay = opts.maxDelayMs;
  if (opts.jitter) delay = delay / 2 + Math.random() * (delay / 2);
  return Math.round(delay);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** A random positive integer within the 53-bit safe range (client ids). */
export function randomClientId(): number {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  // 21 high bits + 32 low bits = 53 bits; +1 keeps it strictly positive.
  const id = (a[0] as number) % 0x200000 * 0x100000000 + (a[1] as number);
  return id === 0 ? 1 : id;
}
