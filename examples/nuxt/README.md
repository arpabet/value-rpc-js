# value-rpc — Nuxt example

A minimal Nuxt app using the `@arpabet/vrpc-nuxt` module. Composables are
auto-imported; the vrpc client is **client-only**, so SSR renders the pending
state and the browser connects after hydration (no WebSocket per SSR render).

It demonstrates `useVrpcConnection`, `useVrpcCall` (`greet`), and `useVrpcStream`
(`count`).

## Run it

From the monorepo root, build the packages once:

```sh
npm install
npm run build
```

Then, in two terminals:

```sh
# 1. the example value-rpc server (Go) on :9000
cd examples/server && VRPC_ADDR=127.0.0.1:9000 go run .

# 2. the Nuxt dev server
cd examples/nuxt && npm run dev
```

Open the printed URL (default http://localhost:3000). The page renders its
pending state on the server, then the browser connects and fills in the greeting
and the stream.

**Dev connectivity:** unlike Vite, Nitro's `devProxy` forwards HTTP but does not
upgrade WebSockets, so this example connects the browser **directly** to
`ws://127.0.0.1:9000/rpc` in dev (see `nuxt.config.ts`). The example server sets
`WithWebSocketOrigins("*")`, so the cross-origin dev connection is accepted. In
production, serve the app and a same-origin `/rpc` from one host and set
`vrpc.url` to `"/rpc"` (or an absolute `wss://…`).

## Configuration

See `nuxt.config.ts`. The module reads `runtimeConfig.public.vrpc`, so you can
override the endpoint per deployment without rebuilding:

```sh
NUXT_PUBLIC_VRPC_URL=wss://api.example.com/rpc node .output/server/index.mjs
```

In production, drop `devProxy` and set `vrpc.url` to your same-origin `/rpc`
(or an absolute `wss://…` URL).
