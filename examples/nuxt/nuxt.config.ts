export default defineNuxtConfig({
  modules: ["@arpabet/vrpc-nuxt"],
  vrpc: {
    // Same-origin "/rpc" in production; in dev, proxy it to the Go server.
    url: "/rpc",
    devProxy: "http://localhost:9000",
    timeoutMs: 5000,
  },
  compatibilityDate: "2026-01-01",
});
