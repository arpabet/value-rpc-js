# value-rpc — Vue 3 + Vite example

A minimal Vue app using `@arpabet/vrpc-vue`. It demonstrates:

- **`useVrpcConnection`** — a live connection-status badge.
- **`useVrpcCall`** — a unary call (`greet`) with reactive args (edit the name → the call re-runs).
- **`useVrpcStream`** — a server→browser stream (`count`) with automatic cancel on unmount.
- **reverse RPC** — the server calls a function the *browser* registered (`notify`).

## Run it

From the monorepo root, build the packages once:

```sh
npm install
npm run build
```

Then, in three terminals:

```sh
# 1. the example value-rpc server (Go) on :9000
cd examples/server && VRPC_ADDR=127.0.0.1:9000 go run .

# 2. the Vue dev server (Vite proxies /rpc → :9000, so it's same-origin)
cd examples/vue-vite && npm run dev
```

Open the printed Vite URL (default http://localhost:5173). You should see the
badge go **open**, the greeting render, the stream fill, and the "ask the server
to call us" button append a notification (the reverse call).

The dev server proxies `/rpc` to the Go server (`vite.config.ts`), so the browser
connects same-origin — no CORS and no origin patterns needed in dev.

## Point at a different server

Set `VITE_VRPC_URL` (skips the proxy and connects directly):

```sh
VITE_VRPC_URL=wss://api.example.com/rpc npm run dev
```

## Use the JSON codec

The default is msgpack (binary frames). To watch human-readable frames in
devtools, pass `codec: "json"` in `src/main.ts`:

```ts
createApp(App).use(createVrpc({ url, codec: "json" })).mount("#app");
```

The Go server negotiates it automatically via the `vrpc.json` subprotocol.
