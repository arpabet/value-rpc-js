import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vue()],
  server: {
    // Same-origin in dev: the browser talks to ws://localhost:5173/rpc and
    // Vite proxies to the Go value-rpc server — no CORS, no origin patterns.
    proxy: {
      "/rpc": { target: "http://localhost:9000", ws: true },
    },
  },
});
