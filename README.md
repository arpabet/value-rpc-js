# value-rpc-js

TypeScript/JavaScript client stack for [value-rpc](https://github.com/arpabet/value-rpc) —
the schemaless, peer-symmetric RPC framework. Talks to any value-rpc Go server over
WebSocket, from browsers (Vue/Nuxt/Vite or plain JS) and from Node ≥ 22 / Bun.

Design background: the Go repo's `WEB.md`.

| Package | What it is |
|---|---|
| [`@arpabet/vrpc`](packages/vrpc) | Protocol core: canonical msgpack + JSON codecs (decimals, big integers, timestamps), all four RPC patterns, credit-based flow control on async iterators, reconnect with hash-chain session resumption, reverse (server→browser) calls, typed no-codegen API surface. **Zero runtime dependencies.** |
| [`@arpabet/vrpc-vue`](packages/vrpc-vue) | Vue 3 plugin + composables: `useVrpcCall`, `useVrpcStream`, `useVrpcConnection`. |
| [`@arpabet/vrpc-nuxt`](packages/vrpc-nuxt) | Nuxt 3/4 module: client-only plugin, auto-imported composables, runtime config, dev proxy. |

## Quick start (plain TS / Vite)

```ts
import { createClient, Code, VrpcError } from "@arpabet/vrpc";

const client = createClient({
  url: "wss://example.com/rpc",
  auth: () => session.token,        // handshake `auth` field (re-read on reconnect)
  timeoutMs: 5000,                  // default unary SLA
  metadata: () => ({ traceparent: currentTrace() }),
});

// unary — AbortSignal maps to a vRPC CancelRequest
const user = await client.call("user.get", [42], { signal: ctrl.signal });

// server stream — pulling grants flow-control credit; `break` cancels
for await (const ev of client.getStream("events.tail", ["orders"])) {
  render(ev);
}

// client stream / bidirectional chat
await client.putStream("logs.upload", null, lines());
const chat = client.chat("support.chat", [ticketId]);
await chat.send("hello");
chat.end();
for await (const msg of chat) { /* … */ }

// peer symmetry: the SERVER can call the BROWSER
client.addFunction("notify", (args) => { toast(String(args)); return null; });

client.on("status", (s) => badge.textContent = s); // connecting|open|resuming|closed
```

Typed calls without codegen:

```ts
import { typedClient } from "@arpabet/vrpc";

interface Api {
  "user.get":    { args: [id: number]; result: User };
  "events.tail": { args: [topic: string]; stream: OrderEvent };
}
const api = typedClient<Api>(client);
const u = await api.call("user.get", [42]);        // typed User, args checked
```

## Vue

```ts
// main.ts
app.use(createVrpc({ url: import.meta.env.VITE_VRPC_URL }));
```

```vue
<script setup lang="ts">
const { data, pending, error, refresh } = useVrpcCall<User>("user.get", () => [route.params.id]);
const { latest, values, state, cancel } = useVrpcStream<OrderEvent>("events.tail", ["orders"]);
const { status, connected } = useVrpcConnection();
</script>
```

Dev-time same-origin (no CORS, no origin patterns) via the Vite proxy:

```ts
// vite.config.ts
export default defineConfig({
  server: { proxy: { "/rpc": { target: "http://localhost:9000", ws: true } } },
});
```

## Nuxt

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ["@arpabet/vrpc-nuxt"],
  vrpc: { url: "/rpc", devProxy: "http://localhost:9000" },
});
```

Composables are auto-imported. The plugin is **client-only**: SSR renders the
pending state and the browser fills after hydration (no WebSocket per SSR
render). Override per deployment with `NUXT_PUBLIC_VRPC_URL`.

## Codecs: msgpack by default, JSON on request

The client offers the WebSocket subprotocol of its codec and requires the
server to echo it, as the Go client (`valuerpc`'s WebSocket dialer) does.
Every value-rpc server from v1.5.3 on negotiates.

- **`codec: "msgpack"` (default)** — one MessagePack envelope per binary
  WebSocket frame, offered as `vrpc.msgpack`. The codec is implemented
  in-package (canonical `value` encoding), so the core stays dependency-free.
- **`codec: "json"`** — one JSON envelope per text frame, offered as
  `vrpc.json` (WEB.md §3.4). Text with control characters, and a quote in a
  map key, need a server built with value v1.6.2 or later (value-rpc v1.6.5):
  an older one answers them with a frame that is not JSON.

Against a server that does not echo the subprotocol the connect fails fast
with a clear error. To reach a server older than v1.5.3, which serves msgpack
and negotiates nothing, pass a codec that offers nothing:
`codec: { ...msgpackCodec(), subprotocols: [] }`.

Value model notes (both codecs):

- integers within ±2^53 are `number`; int64 beyond that is `bigint`
  (msgpack round-trips it exactly; JSON refuses it at encode time)
- `Uint8Array` ↔ value RAW (JSON uses the `"base64,…"` convention)
- `VrpcDecimal` / ext values round-trip through msgpack only
- maps encode with sorted keys — frames are canonical and byte-reproducible

## Reconnect & resumption

On an unexpected drop the client fails in-flight calls with
`VrpcError(Code.Unavailable)`, then reconnects with exponential backoff +
jitter (plus browser `online`/`visibilitychange` hints). Each session holds a
WebCrypto **reverse hash chain**; reconnects present one-time pre-image tokens
so the server re-attaches the same session replay-proof (`valuerpc.HashChain`
semantics, verified against the Go implementation in the conformance suite).

## Repo layout

```
packages/vrpc         core (zero deps)
packages/vrpc-vue     Vue composables
packages/vrpc-nuxt    Nuxt module
examples/server       small Go value-rpc server the demo apps connect to
examples/vue-vite     Vue 3 + Vite demo app
examples/nuxt         Nuxt demo app
conformance/server    Go harness the conformance tests run against
```

## Development

```sh
npm install
npm run build        # all packages
npm test             # unit + conformance (spawns the Go server if `go` exists)
```

## Running the examples

Both example apps proxy `/rpc` to a Go value-rpc server on `:9000`. Start it,
then the app (each example's README has the details):

```sh
# terminal 1 — the example server (needs the value-rpc checkout as a sibling
# directory, see examples/server/go.mod)
cd examples/server && VRPC_ADDR=127.0.0.1:9000 go run .

# terminal 2 — the app
cd examples/vue-vite && npm run dev     # or: cd examples/nuxt && npm run dev
```

## License

Apache-2.0 (matching the `value` library). Note: the value-rpc Go framework
itself is BUSL-1.1.
