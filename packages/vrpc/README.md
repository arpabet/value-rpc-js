# @arpabet/vrpc

value-rpc protocol core for browsers, Node ≥ 22, and Bun. Zero runtime
dependencies. See the [repo README](../../README.md) for the full tour.

```ts
import { createClient } from "@arpabet/vrpc";

const client = createClient({ url: "wss://example.com/rpc" });

await client.call("greet", ["world"]);                    // unary
for await (const v of client.getStream("count", [10])) {} // server stream
await client.putStream("upload", null, values);           // client stream
const chat = client.chat("chat.echo");                    // bidirectional

client.addFunction("notify", (args) => null);             // server calls YOU
```

## Options (`createClient`)

| Option | Default | Meaning |
|---|---|---|
| `url` | — | `ws://` / `wss://` endpoint |
| `codec` | `"msgpack"` | `"msgpack"` works with every server; `"json"` needs a JSON-codec server (negotiated via the `vrpc.json` subprotocol) |
| `auth` | — | credential (or async factory) for the handshake `auth` field |
| `timeoutMs` | `5000` | default unary timeout, sent as the request SLA |
| `connectTimeoutMs` | `10000` | dial + handshake bound |
| `metadata` | — | `Metadata` or per-request factory (`traceparent`, …) |
| `reconnect` | enabled | backoff options or `false` |
| `resume` | `true` | hash-chain session resumption across reconnects |
| `maxPending` | `4096` | per-stream receive window (flow-control credit) |
| `dialect` | standard | wire field names; must match the server's `Dialect` |
| `webSocket` / `dialer` | global / WS | overrides for tests and custom transports |

## Error model

Every failure is a `VrpcError` with a `code` mirroring `valuerpc.Code`:

```ts
try {
  await client.call("user.get", [42]);
} catch (err) {
  if (err instanceof VrpcError && err.code === Code.Unavailable) retryLater();
}
```

Timeouts map to `Code.DeadlineExceeded`, aborts to `Code.Canceled`,
connection loss to `Code.Unavailable` — the same branches a Go caller writes
with `valuerpc.CodeOf`.

## Value model

`null | boolean | number | bigint | string | Uint8Array | Value[] | {…} |
VrpcDouble | VrpcDecimal | VrpcExt`

- Integer `number`s encode as value LONG; beyond ±2^53 pass a `bigint`
  (exact int64 over msgpack). `double(x)` forces a DOUBLE encoding.
- `Uint8Array` is value RAW bytes.
- Maps are plain objects; keys encode sorted (canonical frames).
- `VrpcDecimal` (`decimal("1.045")`) and `VrpcExt` round-trip over msgpack.

## Streams & flow control

`getStream` returns an async iterator; **credit is granted to the server as
you consume**, so a slow consumer backpressures the producer losslessly.
`break`/`return` sends a `CancelRequest`. `putStream`/`chat.send` honor the
credit the server grants — a misbehaving peer is cut off with
`Code.ResourceExhausted`, exactly like the Go client.

## Reverse calls

The server can invoke functions and open streams on this client
(`addFunction`, `addOutgoingStream`, `addIncomingStream`, `addChat`) — the
same registrar surface `valueserver.Server` has. Handlers receive
`(args, ctx)` where `ctx.signal` aborts on cancellation/disconnect.
