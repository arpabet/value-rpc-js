# @arpabet/vrpc-nuxt

Nuxt 3/4 module for [value-rpc](https://github.com/arpabet/value-rpc).

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ["@arpabet/vrpc-nuxt"],
  vrpc: {
    url: "/rpc",                        // same-origin wss in production
    devProxy: "http://localhost:9000",  // nitro dev proxy (ws) for `url`
    timeoutMs: 5000,
  },
});
```

- Registers a **client-only** plugin: SSR renders the pending state; the
  browser connects after hydration (no WebSocket per SSR render).
- Auto-imports `useVrpc`, `useVrpcCall`, `useVrpcStream`, `useVrpcConnection`.
- Runtime-config driven: override per deployment with `NUXT_PUBLIC_VRPC_URL`
  (and `NUXT_PUBLIC_VRPC_TIMEOUT_MS`, …).
- A relative `url` like `/rpc` is resolved against the page origin with the
  matching `ws:`/`wss:` scheme.

For SSR-critical data, query the same Go server from Nitro server routes and
pass results through `useAsyncData`; a shared Nitro-side vrpc client is the
phase-2 plan (WEB.md §6.6).
