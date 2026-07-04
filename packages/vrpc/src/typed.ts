/*
 * Copyright (c) 2026 Karagatan LLC.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Typed calls without codegen — the TS analogue of valuerpc.Codec[T] /
 * CallUnary. Describe your API as an interface and get compile-time checked
 * method names, argument tuples, and result types:
 *
 * ```ts
 * interface Api {
 *   "user.get":    { args: [id: number]; result: User };
 *   "events.tail": { args: [topic: string]; stream: OrderEvent };
 *   "logs.upload": { args: []; put: string };
 *   "support.chat": { args: [ticket: number]; in: Message; out: string };
 * }
 * const api = typedClient<Api>(client);
 * const user = await api.call("user.get", [42]);
 * for await (const ev of api.getStream("events.tail", ["orders"])) { ... }
 * ```
 */

import type { CallOptions, VrpcChat, VrpcClient, VrpcStream } from "./client.js";
import type { Value } from "./value.js";

export interface UnaryShape {
  args: Value[];
  result: unknown;
}
export interface GetStreamShape {
  args: Value[];
  stream: unknown;
}
export interface PutStreamShape {
  args: Value[];
  put: unknown;
}
export interface ChatShape {
  args: Value[];
  in: unknown;
  out: unknown;
}

export type ApiShape = Record<string, UnaryShape | GetStreamShape | PutStreamShape | ChatShape>;

type UnaryNames<A extends ApiShape> = { [K in keyof A]: A[K] extends UnaryShape ? K : never }[keyof A];
type GetNames<A extends ApiShape> = { [K in keyof A]: A[K] extends GetStreamShape ? K : never }[keyof A];
type PutNames<A extends ApiShape> = { [K in keyof A]: A[K] extends PutStreamShape ? K : never }[keyof A];
type ChatNames<A extends ApiShape> = { [K in keyof A]: A[K] extends ChatShape ? K : never }[keyof A];

export interface TypedStream<T> extends AsyncIterableIterator<T> {
  readonly requestId: number;
  readonly ready: Promise<void>;
  cancel(): void;
}

export interface TypedChat<TIn, TOut> extends AsyncIterable<TIn> {
  readonly requestId: number;
  readonly ready: Promise<void>;
  readonly incoming: AsyncIterableIterator<TIn>;
  send(v: TOut): Promise<void>;
  end(): void;
  cancel(): void;
}

export interface TypedClient<A extends ApiShape> {
  call<K extends UnaryNames<A>>(
    name: K,
    args: A[K] extends UnaryShape ? A[K]["args"] : never,
    opts?: CallOptions,
  ): Promise<A[K] extends UnaryShape ? A[K]["result"] : never>;

  getStream<K extends GetNames<A>>(
    name: K,
    args: A[K] extends GetStreamShape ? A[K]["args"] : never,
    opts?: CallOptions,
  ): TypedStream<A[K] extends GetStreamShape ? A[K]["stream"] : never>;

  putStream<K extends PutNames<A>>(
    name: K,
    args: A[K] extends PutStreamShape ? A[K]["args"] : never,
    source: A[K] extends PutStreamShape
      ? Iterable<A[K]["put"]> | AsyncIterable<A[K]["put"]>
      : never,
    opts?: CallOptions,
  ): Promise<void>;

  chat<K extends ChatNames<A>>(
    name: K,
    args: A[K] extends ChatShape ? A[K]["args"] : never,
    opts?: CallOptions,
  ): TypedChat<
    A[K] extends ChatShape ? A[K]["in"] : never,
    A[K] extends ChatShape ? A[K]["out"] : never
  >;

  readonly client: VrpcClient;
}

/** Wraps a client with a compile-time-typed API surface (zero runtime cost). */
export function typedClient<A extends ApiShape>(client: VrpcClient): TypedClient<A> {
  return {
    client,
    call: (name, args, opts) => client.call(name as string, args as Value, opts) as never,
    getStream: (name, args, opts) =>
      client.getStream(name as string, args as Value, opts) as VrpcStream as never,
    putStream: (name, args, source, opts) =>
      client.putStream(name as string, args as Value, source as Iterable<Value>, opts),
    chat: (name, args, opts) => client.chat(name as string, args as Value, opts) as VrpcChat as never,
  };
}
