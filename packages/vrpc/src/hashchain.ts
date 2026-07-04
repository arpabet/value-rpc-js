/*
 * Copyright (c) 2026 Karagatan LLC.
 * SPDX-License-Identifier: Apache-2.0
 */

import { bytesToHex } from "./value.js";

/**
 * Client-held reverse hash chain (S/KEY style) for replay-resistant session
 * resumption, mirroring valuerpc.HashChain:
 *
 *   seed = h[0],  h[i] = SHA-256(h[i-1]),  anchor = h[N]
 *
 * The anchor is presented (hex) in the first handshake's `tok` field; each
 * reconnect reveals the next pre-image in reverse order. The chain always
 * advances — even when a handshake is lost — and the server self-heals by
 * hashing forward (its resync window), so a link is never revealed twice.
 *
 * Browser-sized default: 1024 links (~1024 awaited SHA-256 digests at build
 * time, milliseconds) bounds reconnects per session; an exhausted chain makes
 * the client start a fresh session (new clientId + new chain).
 */
export class HashChain {
  private constructor(
    private readonly links: Uint8Array[],
    private next: number,
  ) {}

  static readonly DEFAULT_LENGTH = 1024;

  static async create(n: number = HashChain.DEFAULT_LENGTH): Promise<HashChain> {
    if (n <= 0) n = HashChain.DEFAULT_LENGTH;
    const links: Uint8Array[] = new Array(n + 1);
    const seed = new Uint8Array(32);
    crypto.getRandomValues(seed);
    links[0] = seed;
    for (let i = 1; i <= n; i++) {
      const digest = await crypto.subtle.digest("SHA-256", links[i - 1] as Uint8Array<ArrayBuffer>);
      links[i] = new Uint8Array(digest);
    }
    return new HashChain(links, n - 1);
  }

  /** The public commitment h[N], hex-encoded. Resending it consumes nothing. */
  anchor(): string {
    return bytesToHex(this.links[this.links.length - 1] as Uint8Array);
  }

  /**
   * Reveals the next one-time resumption token and advances. Returns "" when
   * the chain is exhausted and a fresh session is required.
   */
  nextToken(): string {
    if (this.next < 0) return "";
    const tok = bytesToHex(this.links[this.next] as Uint8Array);
    this.next--;
    return tok;
  }

  remaining(): number {
    return this.next + 1;
  }
}
