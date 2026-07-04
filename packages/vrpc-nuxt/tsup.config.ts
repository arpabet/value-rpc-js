import { defineConfig } from "tsup";

export default defineConfig({
  entry: { module: "src/module.ts" },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  external: ["@nuxt/kit", "@nuxt/schema", "@arpabet/vrpc", "@arpabet/vrpc-vue"],
});
