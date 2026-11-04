/*
 * Copyright (c) 2026 Karagatan LLC.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The conformance vectors of go.arpabet.com/value (testdata/canonical.json
 * there, copied here): every implementation of the canonical form must
 * produce exactly these bytes and decode them to equal values.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { jsonEncode } from "../src/json.js";
import { msgpackDecode, msgpackEncode } from "../src/msgpack.js";
import {
  VrpcBigInt,
  VrpcDecimal,
  VrpcDouble,
  VrpcExt,
  VrpcTimestamp,
  bytesToHex,
  type Value,
} from "../src/value.js";

interface VectorValue {
  kind: string;
  value?: boolean;
  text?: string;
  hex?: string;
  seconds?: number;
  nanos?: number;
  tag?: number;
  items?: VectorValue[];
  entries?: Record<string, VectorValue>;
}

interface Vector {
  name: string;
  value: VectorValue;
  hex: string;
  text?: string;
  json?: string;
}

function fromHex(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** Builds the JS value a vector describes, in the form the encoder takes. */
function build(v: VectorValue): Value {
  switch (v.kind) {
    case "null":
      return null;
    case "bool":
      return v.value as boolean;
    case "long": {
      const n = BigInt(v.text as string);
      return n >= -9007199254740991n && n <= 9007199254740991n ? Number(n) : n;
    }
    case "double":
      return new VrpcDouble(Number(v.text));
    case "bigint":
      return new VrpcBigInt(BigInt(v.text as string));
    case "decimal":
      return VrpcDecimal.fromString(v.text as string);
    case "str":
      return v.text as string;
    case "bin":
      return fromHex(v.hex as string);
    case "timestamp":
      return new VrpcTimestamp(BigInt(v.seconds as number), v.nanos as number);
    case "ext":
      return new VrpcExt(v.tag as number, fromHex(v.hex as string));
    case "list":
      return (v.items as VectorValue[]).map(build);
    case "map": {
      const out: { [key: string]: Value } = {};
      for (const [k, e] of Object.entries(v.entries as Record<string, VectorValue>)) out[k] = build(e);
      return out;
    }
    default:
      throw new Error(`unknown vector kind ${v.kind}`);
  }
}

/** The form the decoder yields for a vector, for deep equality. */
function decoded(v: VectorValue): unknown {
  switch (v.kind) {
    case "double":
      return Number(v.text);
    case "bigint":
      return BigInt(v.text as string);
    case "list":
      return (v.items as VectorValue[]).map(decoded);
    case "map": {
      const out: Record<string, unknown> = {};
      for (const [k, e] of Object.entries(v.entries as Record<string, VectorValue>)) out[k] = decoded(e);
      return out;
    }
    default:
      return build(v);
  }
}

const file = JSON.parse(
  readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "canonical.json"), "utf8"),
) as { vectors: Vector[] };

describe("value conformance vectors (canonical.json)", () => {
  it("has vectors", () => {
    expect(file.vectors.length).toBeGreaterThan(50);
  });

  for (const vec of file.vectors) {
    it(vec.name, () => {
      const v = build(vec.value);
      const enc = msgpackEncode(v);
      expect(bytesToHex(enc)).toBe(vec.hex);
      const back = msgpackDecode(fromHex(vec.hex));
      expect(back).toEqual(decoded(vec.value));
      // Re-encoding the decoded value gives the same bytes, except where the
      // JS projection folds kinds together: an integer-valued double and a
      // BigInt within int64 both come back as integers, which encode as LONG.
      const folded =
        vec.value.kind === "double" ||
        (vec.value.kind === "bigint" && (back as bigint) >= -(2n ** 63n) && (back as bigint) < 2n ** 63n);
      if (!folded) expect(bytesToHex(msgpackEncode(back as Value))).toBe(vec.hex);
      if (vec.text !== undefined && back instanceof VrpcTimestamp) expect(back.toString()).toBe(vec.text);
      // JSON carries integers only up to 2^53 exactly.
      const exactInJson = !(
        typeof v === "bigint" ||
        v instanceof VrpcBigInt ||
        (typeof v === "number" && !Number.isSafeInteger(v))
      );
      if (vec.json !== undefined && vec.value.kind !== "double" && exactInJson) expect(jsonEncode(v)).toBe(vec.json);
    });
  }
});
