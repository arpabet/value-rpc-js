/*
 * Copyright (c) 2026 Karagatan LLC.
 * SPDX-License-Identifier: Apache-2.0
 */

import { addImports, addPlugin, createResolver, defineNuxtModule } from "@nuxt/kit";
import { defu } from "defu";

export interface VrpcModuleOptions {
  /**
   * WebSocket endpoint. Overridable at runtime via
   * NUXT_PUBLIC_VRPC_URL (runtimeConfig.public.vrpc.url). In dev, prefer a
   * relative "/rpc" together with the devProxy option.
   */
  url: string;
  /** "msgpack" (default, works with every server) or "json". */
  codec?: "msgpack" | "json";
  /** Default unary timeout / request SLA in ms. */
  timeoutMs?: number;
  /** Open the connection at app start instead of on first call. */
  eager?: boolean;
  /**
   * Dev-server proxy target for the WebSocket endpoint, e.g.
   * "http://localhost:9000". Adds a Nitro devProxy for `url` (same-origin in
   * dev: no CORS, no origin patterns, no mixed content).
   */
  devProxy?: string;
}

export default defineNuxtModule<VrpcModuleOptions>({
  meta: {
    name: "@arpabet/vrpc-nuxt",
    configKey: "vrpc",
    compatibility: { nuxt: ">=3.13.0" },
  },
  defaults: {
    url: "/rpc",
    codec: "msgpack",
    timeoutMs: 5000,
    eager: false,
  },
  setup(options, nuxt) {
    const resolver = createResolver(import.meta.url);

    // Expose the client options via runtime config so NUXT_PUBLIC_VRPC_* env
    // vars can override them per deployment.
    const existing = (nuxt.options.runtimeConfig.public.vrpc ?? {}) as Partial<VrpcModuleOptions>;
    nuxt.options.runtimeConfig.public.vrpc = {
      url: existing.url ?? options.url,
      codec: existing.codec ?? options.codec ?? "msgpack",
      timeoutMs: existing.timeoutMs ?? options.timeoutMs ?? 5000,
      eager: existing.eager ?? options.eager ?? false,
    };

    // SSR policy (WEB.md §6.6): the plugin is client-only. Server-side
    // rendering shows the pending state; the browser connects and fills.
    addPlugin(resolver.resolve("./runtime/plugin.client"));

    // Auto-import the composables.
    for (const name of ["useVrpc", "useVrpcCall", "useVrpcStream", "useVrpcConnection"]) {
      addImports({ name, from: "@arpabet/vrpc-vue" });
    }

    // Same-origin dev proxy for the WS endpoint. (Typed loosely: NuxtOptions
    // only carries the nitro key when nitropack's types are installed.)
    if (options.devProxy && nuxt.options.dev) {
      const opts = nuxt.options as unknown as {
        nitro?: { devProxy?: Record<string, unknown> };
      };
      opts.nitro = opts.nitro ?? {};
      opts.nitro.devProxy = defu(opts.nitro.devProxy, {
        [options.url]: { target: options.devProxy + options.url, ws: true },
      });
    }

    // The runtime plugin imports these; make sure Vite pre-bundles them.
    nuxt.options.build.transpile.push("@arpabet/vrpc", "@arpabet/vrpc-vue");
  },
});

declare module "@nuxt/schema" {
  interface PublicRuntimeConfig {
    vrpc: {
      url: string;
      codec?: "msgpack" | "json" | undefined;
      timeoutMs?: number | undefined;
      eager?: boolean | undefined;
    };
  }
}
