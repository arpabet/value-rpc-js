# @arpabet/vrpc-vue

Vue 3 plugin + composables for [value-rpc](https://github.com/arpabet/value-rpc).

```ts
// main.ts
import { createVrpc } from "@arpabet/vrpc-vue";
app.use(createVrpc({ url: import.meta.env.VITE_VRPC_URL }));
```

```vue
<script setup lang="ts">
const { data, pending, error, refresh } = useVrpcCall<User>("user.get", () => [id.value]);
const { latest, values, state, cancel } = useVrpcStream<Event>("events.tail", ["orders"]);
const { status, connected } = useVrpcConnection();
const client = useVrpc(); // full @arpabet/vrpc client (chat, putStream, reverse calls)
</script>
```

- `useVrpcCall` re-runs when reactive args change and aborts superseded runs.
- `useVrpcStream` grants flow-control credit as values are consumed and
  cancels the stream on unmount. `keepLast` bounds the retained window.
- SSR-safe: on the server the composables render their pending state and
  never open a socket.
- For caching/dedup/SWR, feed `client.call` into `@tanstack/vue-query`'s
  `queryFn` — this package deliberately ships no cache.
