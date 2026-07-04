<script setup lang="ts">
// Composables are auto-imported by @arpabet/vrpc-nuxt. The vrpc plugin is
// client-only: SSR renders the pending state, the browser connects and fills.
const { status, connected } = useVrpcConnection();
const { data: greeting, pending } = useVrpcCall<string>("greet", ["nuxt"]);
const { values, state } = useVrpcStream<number>("count", [5]);
</script>

<template>
  <main style="font-family: system-ui; max-width: 40rem; margin: 2rem auto">
    <h1>value-rpc + Nuxt</h1>
    <p>
      connection: <strong :style="{ color: connected ? 'green' : 'orange' }">{{ status }}</strong>
    </p>
    <p>greet: {{ pending ? "…" : greeting }}</p>
    <p>stream ({{ state }}): {{ values.join(", ") }}</p>
  </main>
</template>
