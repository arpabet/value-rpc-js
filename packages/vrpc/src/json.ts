/*
 * Copyright (c) 2026 Karagatan LLC.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * JSON codec per WEB.md §3.1 — the value library's existing JSON conventions:
 *
 * - raw bytes      <-> "base64,<standard base64, no padding>"
 * - msgpack ext    <-> "data:application/x-msgpack-ext;base64,<tag+data>"
 * - NaN / ±Inf     ->  null (decode never produces them)
 * - map keys       ->  sorted by UTF-8 byte order (canonical, deterministic)
 * - integers       ->  plain JSON numbers; throws beyond ±2^53 on encode
 * - bigint         ->  encoded as a number when within ±2^53, else rejected
 *                      (the wire cannot carry it exactly; use msgpack)
 * - VrpcDecimal    ->  rejected on encode (does not round-trip through JSON)
 *
 * Known hazard inherited from the convention: a *string* that genuinely starts
 * with "base64," or "data:application/x-msgpack-ext;" is indistinguishable
 * from encoded bytes/ext and will decode as such.
 */

import {
  VrpcDecimal,
  VrpcDouble,
  VrpcExt,
  base64RawStdDecode,
  base64RawStdEncode,
  compareUtf8,
  isPlainObject,
  type Value,
  type ValueMap,
} from "./value.js";
import { DEFAULT_LIMITS, type DecodeLimits } from "./msgpack.js";

export const BASE64_PREFIX = "base64,";
export const EXT_PREFIX = "data:application/x-msgpack-ext;";
const MAX_SAFE = 9007199254740991; // 2^53 - 1

function writeValue(out: string[], v: Value | undefined, depth: number): void {
  if (depth > 512) throw new RangeError("vrpc: json nesting too deep");
  if (v === null || v === undefined) {
    out.push("null");
    return;
  }
  switch (typeof v) {
    case "boolean":
      out.push(v ? "true" : "false");
      return;
    case "number":
      writeNumber(out, v);
      return;
    case "bigint":
      if (v > BigInt(MAX_SAFE) || v < -BigInt(MAX_SAFE)) {
        throw new RangeError(
          `vrpc: bigint ${v} exceeds ±2^53 and cannot travel exactly in JSON; use the msgpack codec or model it as a string`,
        );
      }
      out.push(v.toString());
      return;
    case "string":
      out.push(JSON.stringify(v));
      return;
    case "object":
      break;
    default:
      throw new TypeError(`vrpc: cannot encode ${typeof v} as a value`);
  }
  if (v instanceof Uint8Array) {
    out.push(JSON.stringify(BASE64_PREFIX + base64RawStdEncode(v)));
  } else if (v instanceof VrpcDouble) {
    writeNumber(out, v.value, true);
  } else if (v instanceof VrpcExt) {
    const payload = new Uint8Array(1 + v.data.length);
    payload[0] = v.tag;
    payload.set(v.data, 1);
    out.push(JSON.stringify(EXT_PREFIX + BASE64_PREFIX + base64RawStdEncode(payload)));
  } else if (v instanceof VrpcDecimal) {
    throw new TypeError(
      "vrpc: VrpcDecimal does not round-trip through the JSON codec; use msgpack or model it as a string",
    );
  } else if (Array.isArray(v)) {
    out.push("[");
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out.push(",");
      writeValue(out, v[i], depth + 1);
    }
    out.push("]");
  } else if (v instanceof Map || isPlainObject(v)) {
    const get: (k: string) => Value | undefined =
      v instanceof Map ? (k) => v.get(k) as Value : (k) => (v as ValueMap)[k];
    const keys = (v instanceof Map ? [...v.keys()].map(String) : Object.keys(v))
      .filter((k) => get(k) !== undefined)
      .sort(compareUtf8);
    out.push("{");
    for (let i = 0; i < keys.length; i++) {
      if (i > 0) out.push(",");
      out.push(JSON.stringify(keys[i]), ":");
      writeValue(out, get(keys[i] as string), depth + 1);
    }
    out.push("}");
  } else {
    throw new TypeError(`vrpc: cannot encode ${(v as object).constructor?.name ?? "object"} as a value`);
  }
}

function writeNumber(out: string[], v: number, forceDouble = false): void {
  if (!Number.isFinite(v)) {
    // Matches the value library's NaN policy (and the WEB.md ±Inf decision).
    out.push("null");
    return;
  }
  if (Number.isInteger(v) && !forceDouble && Math.abs(v) > MAX_SAFE) {
    throw new RangeError(`vrpc: integer ${v} exceeds ±2^53; use the msgpack codec with a bigint`);
  }
  out.push(Object.is(v, -0) ? "0" : String(v));
}

/** Serializes a value to canonical JSON text (sorted keys). */
export function jsonEncode(v: Value): string {
  const out: string[] = [];
  writeValue(out, v, 0);
  return out.join("");
}

function reviveString(s: string): Value {
  if (s.startsWith(EXT_PREFIX)) {
    const rest = s.slice(EXT_PREFIX.length);
    if (rest.startsWith(BASE64_PREFIX)) {
      const payload = base64RawStdDecode(rest.slice(BASE64_PREFIX.length));
      if (payload.length >= 1) {
        return new VrpcExt(payload[0] as number, payload.slice(1));
      }
    }
    return s;
  }
  if (s.startsWith(BASE64_PREFIX)) {
    try {
      return base64RawStdDecode(s.slice(BASE64_PREFIX.length));
    } catch {
      return s; // not valid base64 after the prefix: keep the string
    }
  }
  return s;
}

function reviveValue(v: unknown, depth: number, limits: DecodeLimits): Value {
  if (depth > limits.maxDepth) throw new RangeError("vrpc: json nesting too deep");
  if (v === null) return null;
  switch (typeof v) {
    case "boolean":
    case "number":
      return v;
    case "string":
      return reviveString(v);
    case "object":
      break;
    default:
      throw new SyntaxError(`vrpc: unsupported json value of type ${typeof v}`);
  }
  if (Array.isArray(v)) {
    if (v.length > limits.maxCollectionLen) throw new RangeError("vrpc: json list too long");
    return v.map((item) => reviveValue(item, depth + 1, limits));
  }
  const out: ValueMap = {};
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > limits.maxCollectionLen) throw new RangeError("vrpc: json map too large");
  for (const [k, val] of entries) out[k] = reviveValue(val, depth + 1, limits);
  return out;
}

/** Parses JSON text into a value, applying the string-prefix conventions. */
export function jsonDecode(text: string, limits: DecodeLimits = DEFAULT_LIMITS): Value {
  return reviveValue(JSON.parse(text), 0, limits);
}
