<script setup lang="ts">
import { ref } from "vue";
import { useVrpc, useVrpcCall, useVrpcConnection, useVrpcStream } from "@arpabet/vrpc-vue";

// Connection badge
const { status, connected } = useVrpcConnection();

// Unary call with reactive args: edit the name, the call re-runs.
const who = ref("world");
const { data: greeting, pending, error, refresh } = useVrpcCall<string>("greet", () => [who.value]);

// Live server stream with backpressure; cancelled automatically on unmount.
const streamCount = ref(10);
const { values, state, restart } = useVrpcStream<number>("count", () => [streamCount.value], {
  keepLast: 20,
});

// Peer symmetry: the SERVER can call the BROWSER.
const client = useVrpc();
const notifications = ref<string[]>([]);
client.addFunction("notify", (args) => {
  notifications.value.push(String((args as unknown[])[0]));
  return "ok";
});
// Ask the server to call us back (the round trip proves reverse RPC).
async function pokeServer(): Promise<void> {
  await client.call("reverse.call", [`poked at ${new Date().toLocaleTimeString()}`]);
}
</script>

<template>
  <main style="font-family: system-ui; max-width: 40rem; margin: 2rem auto; padding: 0 1rem">
    <h1>value-rpc: Vue + Vite</h1>

    <p>
      Connection:
      <strong :style="{ color: connected ? 'green' : 'orange' }">{{ status }}</strong>
    </p>

    <section>
      <h2>Unary call</h2>
      <input v-model="who" placeholder="name" />
      <button @click="refresh()">refresh</button>
      <p v-if="pending">calling…</p>
      <p v-else-if="error">error: {{ error.message }}</p>
      <p v-else>{{ greeting }}</p>
    </section>

    <section>
      <h2>Server stream</h2>
      <input v-model.number="streamCount" type="number" min="1" max="1000" />
      <button @click="restart()">restart</button>
      <p>state: {{ state }}</p>
      <p>values: {{ values.join(", ") }}</p>
    </section>

    <section>
      <h2>Server → browser (reverse call)</h2>
      <button @click="pokeServer()">ask the server to call us</button>
      <ul>
        <li v-for="(n, i) in notifications" :key="i">{{ n }}</li>
      </ul>
    </section>
  </main>
</template>
