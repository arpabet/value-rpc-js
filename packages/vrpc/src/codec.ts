/*
 * Copyright (c) 2026 Karagatan LLC.
 * SPDX-License-Identifier: Apache-2.0
 */

import { jsonDecode, jsonEncode } from "./json.js";
import { DEFAULT_LIMITS, msgpackDecode, msgpackEncode, type DecodeLimits } from "./msgpack.js";
import type { ValueMap } from "./value.js";

export type CodecName = "msgpack" | "json";

/**
 * The wire codec seam (WEB.md §3.3): one envelope per WebSocket frame,
 * msgpack in binary frames, JSON in text frames.
 */
export interface WireCodec {
  readonly name: CodecName;
  /**
   * Subprotocol offered on dial. msgpack offers none: "no subprotocol" IS the
   * msgpack negotiation, and it keeps compatibility with servers that predate
   * codec negotiation. JSON offers "vrpc.json" and requires the server to echo
   * it (a server that does not support JSON fails the connect with a clear
   * error instead of choking on text frames).
   */
  readonly subprotocols: string[];
  readonly textFrames: boolean;
  encode(msg: ValueMap): Uint8Array | string;
  decode(data: Uint8Array | string): ValueMap;
}

function assertMap(v: unknown, codec: string): ValueMap {
  if (v === null || typeof v !== "object" || Array.isArray(v) || v instanceof Uint8Array) {
    throw new SyntaxError(`vrpc: expected a ${codec} map envelope`);
  }
  return v as ValueMap;
}

export function msgpackCodec(limits: DecodeLimits = DEFAULT_LIMITS): WireCodec {
  return {
    name: "msgpack",
    subprotocols: [],
    textFrames: false,
    encode: (msg) => msgpackEncode(msg),
    decode: (data) => {
      if (typeof data === "string") {
        throw new SyntaxError(
          "vrpc: received a text frame on a msgpack connection; JSON was not negotiated (offer subprotocol vrpc.json)",
        );
      }
      return assertMap(msgpackDecode(data, limits), "msgpack");
    },
  };
}

export function jsonCodec(limits: DecodeLimits = DEFAULT_LIMITS): WireCodec {
  return {
    name: "json",
    subprotocols: ["vrpc.json"],
    textFrames: true,
    encode: (msg) => jsonEncode(msg),
    decode: (data) => {
      if (typeof data !== "string") {
        throw new SyntaxError("vrpc: received a binary frame on a JSON connection");
      }
      return assertMap(jsonDecode(data, limits), "json");
    },
  };
}

export function codecByName(name: CodecName, limits?: DecodeLimits): WireCodec {
  return name === "json" ? jsonCodec(limits) : msgpackCodec(limits);
}
