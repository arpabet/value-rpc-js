/*
 * Copyright (c) 2026 Karagatan LLC.
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  VrpcClient,
  createClient,
  type CallOptions,
  type ClientOptions,
  type Status,
  type Value,
  VrpcError,
  Code,
} from "@arpabet/vrpc";
import {
  computed,
  getCurrentScope,
  inject,
  onScopeDispose,
  ref,
  shallowRef,
  toValue,
  watch,
  type App,
  type ComputedRef,
  type InjectionKey,
  type MaybeRefOrGetter,
  type Plugin,
  type Ref,
  type ShallowRef,
} from "vue";

export const VRPC_KEY: InjectionKey<VrpcClient> = Symbol("vrpc");

const isClient = typeof window !== "undefined";

export interface VrpcPluginOptions extends ClientOptions {
  /** Open the connection at install time instead of on first call. */
  eager?: boolean;
}

/**
 * Vue plugin providing a shared {@link VrpcClient}:
 *
 * ```ts
 * app.use(createVrpc({ url: import.meta.env.VITE_VRPC_URL }));
 * ```
 *
 * Pass an existing client instead of options to share one across apps.
 */
export function createVrpc(options: VrpcPluginOptions | VrpcClient): Plugin {
  return {
    install(app: App) {
      const client = options instanceof VrpcClient ? options : createClient(options);
      if (!(options instanceof VrpcClient) && options.eager && isClient) {
        client.connect().catch(() => {
          // the client keeps resuming per its reconnect policy
        });
      }
      app.provide(VRPC_KEY, client);
      app.config.globalProperties.$vrpc = client;
    },
  };
}

/** The client installed by {@link createVrpc}. */
export function useVrpc(): VrpcClient {
  const client = inject(VRPC_KEY, null);
  if (!client) {
    throw new Error("vrpc: no client provided — install createVrpc() on the app first");
  }
  return client;
}

/**
 * The client, or null during SSR when the (client-only) plugin has not run —
 * the composables use this to degrade to their inert pending state on the
 * server instead of throwing (WEB.md §6.6 SSR policy).
 */
function useVrpcOptional(): VrpcClient | null {
  const client = inject(VRPC_KEY, null);
  if (!client && isClient) {
    throw new Error("vrpc: no client provided — install createVrpc() on the app first");
  }
  return client;
}

export interface UseVrpcConnection {
  status: Ref<Status>;
  connected: ComputedRef<boolean>;
}

/** Reactive connection state (for a status badge, offline banner, …). */
export function useVrpcConnection(client?: VrpcClient): UseVrpcConnection {
  const c = client ?? useVrpcOptional();
  const status = ref<Status>(c?.status ?? "idle");
  if (c) {
    const off = c.on("status", (s) => {
      status.value = s;
    });
    if (getCurrentScope()) onScopeDispose(off);
  }
  return { status, connected: computed(() => status.value === "open") };
}

export interface UseVrpcCallOptions extends CallOptions {
  /** Run the call on setup (client-side only). Default true. */
  immediate?: boolean;
  /** Re-run automatically when reactive args change. Default true. */
  watchArgs?: boolean;
}

export interface UseVrpcCall<T> {
  data: ShallowRef<T | null>;
  pending: Ref<boolean>;
  error: ShallowRef<VrpcError | null>;
  /** Re-executes the call (aborting any in-flight run). */
  refresh: () => Promise<void>;
}

/**
 * Reactive unary call: re-runs when reactive args change, exposes
 * data/pending/error, aborts in-flight calls on re-run and unmount.
 *
 * ```ts
 * const { data, pending, error, refresh } =
 *   useVrpcCall<User>("user.get", () => [route.params.id]);
 * ```
 *
 * SSR-safe: on the server it stays pending and never opens a connection
 * (the browser fills it after hydration).
 */
export function useVrpcCall<T = Value>(
  name: string,
  args?: MaybeRefOrGetter<Value | undefined>,
  opts: UseVrpcCallOptions = {},
): UseVrpcCall<T> {
  const client = useVrpcOptional();
  const data = shallowRef<T | null>(null);
  const error = shallowRef<VrpcError | null>(null);
  const pending = ref(opts.immediate !== false);

  let ctrl: AbortController | null = null;
  let runId = 0;

  async function refresh(): Promise<void> {
    if (!isClient || !client) return; // SSR renders the pending state
    ctrl?.abort();
    const mine = ++runId;
    const myCtrl = new AbortController();
    ctrl = myCtrl;
    if (opts.signal) {
      if (opts.signal.aborted) myCtrl.abort();
      else opts.signal.addEventListener("abort", () => myCtrl.abort(), { once: true });
    }
    pending.value = true;
    error.value = null;
    try {
      const callOpts: CallOptions = { signal: myCtrl.signal };
      if (opts.timeoutMs !== undefined) callOpts.timeoutMs = opts.timeoutMs;
      if (opts.metadata !== undefined) callOpts.metadata = opts.metadata;
      const res = await client.call(name, toValue(args) ?? undefined, callOpts);
      if (mine !== runId) return; // superseded
      data.value = res as T;
    } catch (err) {
      if (mine !== runId) return;
      error.value =
        err instanceof VrpcError ? err : new VrpcError(Code.Unknown, String(err), { cause: err });
    } finally {
      if (mine === runId) pending.value = false;
    }
  }

  if (opts.watchArgs !== false && (typeof args === "function" || (args !== null && typeof args === "object"))) {
    watch(
      () => toValue(args),
      () => void refresh(),
      { deep: true },
    );
  }
  if (opts.immediate !== false) void refresh();
  if (getCurrentScope()) {
    onScopeDispose(() => {
      runId++;
      ctrl?.abort();
    });
  }

  return { data, pending, error, refresh };
}

export type StreamState = "idle" | "connecting" | "streaming" | "ended" | "error";

export interface UseVrpcStreamOptions extends CallOptions {
  /** Start streaming on setup (client-side only). Default true. */
  immediate?: boolean;
  /** Restart the stream when reactive args change. Default true. */
  watchArgs?: boolean;
  /** How many received values to keep in `values`. Default 100; 0 keeps none. */
  keepLast?: number;
}

export interface UseVrpcStream<T> {
  /** The most recent value. */
  latest: ShallowRef<T | null>;
  /** A bounded window of received values (see keepLast). */
  values: Ref<T[]>;
  state: Ref<StreamState>;
  error: ShallowRef<VrpcError | null>;
  /** Stops the stream (sends CancelRequest). */
  cancel: () => void;
  /** Cancels and re-opens the stream. */
  restart: () => void;
}

/**
 * Reactive server->client stream: values flow into refs, the stream is
 * cancelled automatically when the component unmounts, and backpressure is
 * real — the server is granted credit only as values are consumed.
 *
 * ```ts
 * const { latest, values, state, cancel } =
 *   useVrpcStream<OrderEvent>("events.tail", ["orders"]);
 * ```
 */
export function useVrpcStream<T = Value>(
  name: string,
  args?: MaybeRefOrGetter<Value | undefined>,
  opts: UseVrpcStreamOptions = {},
): UseVrpcStream<T> {
  const client = useVrpcOptional();
  const latest = shallowRef<T | null>(null);
  const values = ref<T[]>([]) as Ref<T[]>;
  const state = ref<StreamState>("idle");
  const error = shallowRef<VrpcError | null>(null);
  const keepLast = opts.keepLast ?? 100;

  let current: { cancel(): void } | null = null;
  let runId = 0;

  function cancel(): void {
    runId++;
    current?.cancel();
    current = null;
    if (state.value === "streaming" || state.value === "connecting") state.value = "idle";
  }

  function start(): void {
    if (!isClient || !client) return; // SSR: never open sockets during render
    cancel();
    const mine = ++runId;
    state.value = "connecting";
    error.value = null;
    const callOpts: CallOptions = {};
    if (opts.timeoutMs !== undefined) callOpts.timeoutMs = opts.timeoutMs;
    if (opts.metadata !== undefined) callOpts.metadata = opts.metadata;
    if (opts.signal !== undefined) callOpts.signal = opts.signal;
    const stream = client.getStream(name, toValue(args) ?? undefined, callOpts);
    current = stream;
    stream.ready.then(
      () => {
        if (mine === runId) state.value = "streaming";
      },
      () => {
        // surfaced through iteration below
      },
    );
    void (async () => {
      try {
        for await (const v of stream) {
          if (mine !== runId) return;
          latest.value = v as T;
          if (keepLast > 0) {
            values.value.push(v as T);
            if (values.value.length > keepLast) values.value.splice(0, values.value.length - keepLast);
          }
        }
        if (mine === runId) state.value = "ended";
      } catch (err) {
        if (mine !== runId) return;
        error.value =
          err instanceof VrpcError ? err : new VrpcError(Code.Unknown, String(err), { cause: err });
        state.value = "error";
      }
    })();
  }

  if (opts.watchArgs !== false && (typeof args === "function" || (args !== null && typeof args === "object"))) {
    watch(
      () => toValue(args),
      () => start(),
      { deep: true },
    );
  }
  if (opts.immediate !== false) start();
  if (getCurrentScope()) onScopeDispose(cancel);

  return { latest, values, state, error, cancel, restart: start };
}

// Re-export the pieces apps typically need alongside the composables.
export { VrpcClient, VrpcError, Code, createClient } from "@arpabet/vrpc";
export type {
  CallOptions,
  ClientOptions,
  Status,
  Value,
  ValueMap,
  VrpcChat,
  VrpcStream,
} from "@arpabet/vrpc";

declare module "vue" {
  interface ComponentCustomProperties {
    $vrpc: VrpcClient;
  }
}
