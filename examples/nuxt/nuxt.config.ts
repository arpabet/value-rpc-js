export default defineNuxtConfig({
  modules: ["@arpabet/vrpc-nuxt"],
  vrpc: {
    // Dev connects straight to the example Go server. Nitro's devProxy forwards
    // HTTP but does not upgrade WebSockets, so — unlike Vite — we don't proxy;
    // the example server sets WithWebSocketOrigins("*"), so a cross-origin dev
    // connection is accepted. In production serve the app and a same-origin
    // "/rpc" endpoint from one host and set url: "/rpc" (or an absolute wss://).
    // Override per environment with NUXT_PUBLIC_VRPC_URL.
    url: "ws://127.0.0.1:9000/rpc",
  },
  compatibilityDate: "2026-01-01",
});
