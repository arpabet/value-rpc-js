import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The client tests assert real timer behavior and the conformance suite
    // drives a spawned Go server; running files sequentially keeps their
    // timing deterministic.
    fileParallelism: false,
  },
});
