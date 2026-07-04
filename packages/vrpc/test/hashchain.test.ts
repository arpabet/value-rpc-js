/*
 * Copyright (c) 2026 Karagatan LLC.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import { HashChain } from "../src/hashchain.js";
import { sha256hex } from "./mock-server.js";

describe("HashChain", () => {
  it("reveals pre-images that hash forward to the anchor", async () => {
    const chain = await HashChain.create(8);
    const anchor = chain.anchor();
    expect(anchor).toMatch(/^[0-9a-f]{64}$/);
    expect(chain.remaining()).toBe(8);

    // h[N-1] hashes to the anchor in one step; each next token hashes to the
    // previous token (the server's VerifyHashStep with window >= 1).
    let last = anchor;
    for (let i = 0; i < 8; i++) {
      const tok = chain.nextToken();
      expect(tok).toMatch(/^[0-9a-f]{64}$/);
      expect(await sha256hex(tok)).toBe(last);
      last = tok;
    }
    expect(chain.nextToken()).toBe(""); // exhausted
    expect(chain.remaining()).toBe(0);
  });

  it("self-heals across skipped links (server resync window)", async () => {
    const chain = await HashChain.create(8);
    const anchor = chain.anchor();
    chain.nextToken(); // lost handshake: link revealed but never seen
    chain.nextToken(); // lost again
    const tok = chain.nextToken();
    // Hashing forward three steps reproduces the anchor.
    expect(await sha256hex(await sha256hex(await sha256hex(tok)))).toBe(anchor);
  });

  it("anchor() is stable and consumes nothing", async () => {
    const chain = await HashChain.create(4);
    expect(chain.anchor()).toBe(chain.anchor());
    expect(chain.remaining()).toBe(4);
  });
});
