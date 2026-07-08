import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vue()],
  server: {
    // Same-origin in dev: the browser talks to ws://localhost:5173/rpc and
    // Vite proxies to the Go value-rpc server — no CORS, no origin patterns.
    // Use 127.0.0.1 (not "localhost") so the proxy can't resolve to IPv6 ::1
    // while the server listens on IPv4 — a common dev-proxy ECONNREFUSED.
    proxy: {
      "/rpc": { target: "http://127.0.0.1:9000", ws: true },
    },
  },
});
