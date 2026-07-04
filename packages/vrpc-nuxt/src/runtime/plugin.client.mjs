/*
 * Copyright (c) 2026 Karagatan LLC.
 * SPDX-License-Identifier: Apache-2.0
 */

// Client-only plugin: creates the shared vrpc client from runtime config.
// SSR never opens a WebSocket (WEB.md §6.6); pages render their pending
// state on the server and the browser fills after hydration.

import { defineNuxtPlugin, useRuntimeConfig } from "#app";
import { createVrpc } from "@arpabet/vrpc-vue";

export default defineNuxtPlugin((nuxtApp) => {
  const cfg = useRuntimeConfig().public.vrpc ?? {};
  const url = resolveUrl(cfg.url || "/rpc");
  nuxtApp.vueApp.use(
    createVrpc({
      url,
      codec: cfg.codec || "msgpack",
      timeoutMs: cfg.timeoutMs ?? 5000,
      eager: cfg.eager ?? false,
    }),
  );
});

// Accepts absolute ws(s):// URLs, or a path like "/rpc" resolved against the
// page origin with the matching ws/wss scheme.
function resolveUrl(url) {
  if (/^wss?:\/\//.test(url)) return url;
  if (/^https?:\/\//.test(url)) return url.replace(/^http/, "ws");
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}${url.startsWith("/") ? url : `/${url}`}`;
}
