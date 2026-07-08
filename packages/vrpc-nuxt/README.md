# @arpabet/vrpc-nuxt

Nuxt 3/4 module for [value-rpc](https://github.com/arpabet/value-rpc).

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ["@arpabet/vrpc-nuxt"],
  vrpc: {
    url: "/rpc",        // same-origin wss in production
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

### Dev connectivity

In production, serve the app and a same-origin `/rpc` endpoint from one host so
`url: "/rpc"` connects same-origin (no CORS, no origin patterns). In **dev**,
the browser and the Go server are on different ports, so either:

- **connect directly** to the server with an absolute dev URL and allow the
  origin server-side (`valueserver.WithWebSocketOrigins(...)`) — the reliable
  option, since Nitro's `devProxy` forwards HTTP but does **not** upgrade
  WebSockets; or
- use Vite/`@arpabet/vrpc-vue` (whose dev proxy does handle WS) for a same-origin
  dev experience.

The `devProxy` option still wires a Nitro `devProxy` entry (useful for any HTTP
routes), but do not rely on it for the WebSocket itself.

For SSR-critical data, query the same Go server from Nitro server routes and
pass results through `useAsyncData`; a shared Nitro-side vrpc client is the
phase-2 plan (WEB.md §6.6).
