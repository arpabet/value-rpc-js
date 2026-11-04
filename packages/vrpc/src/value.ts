/*
 * Copyright (c) 2026 Karagatan LLC.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The TypeScript projection of the `go.arpabet.com/value` model.
 *
 * | value kind      | TypeScript                          |
 * |-----------------|-------------------------------------|
 * | NULL            | null (undefined encodes as null)    |
 * | BOOL            | boolean                             |
 * | NUMBER/LONG     | number (safe integers) or bigint    |
 * | NUMBER/DOUBLE   | number (or VrpcDouble to force)     |
 * | NUMBER/BIGINT   | bigint beyond int64 (or VrpcBigInt) |
 * | NUMBER/DECIMAL  | VrpcDecimal                         |
 * | STRING/UTF8     | string                              |
 * | STRING/RAW      | Uint8Array                          |
 * | TIMESTAMP       | VrpcTimestamp (Date encodes as one) |
 * | LIST            | Array                               |
 * | MAP             | plain object (string keys)          |
 * | UNKNOWN (ext)   | VrpcExt                             |
 */
export type Value =
  | null
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | Date
  | VrpcDouble
  | VrpcBigInt
  | VrpcDecimal
  | VrpcTimestamp
  | VrpcExt
  | Value[]
  | { [key: string]: Value };

/** A string-keyed map value (the envelope shape). */
export type ValueMap = { [key: string]: Value };

export const INT64_MIN = -9223372036854775808n;
export const INT64_MAX = 9223372036854775807n;

/**
 * Forces a JS number to encode as a value DOUBLE (float64) even when it is
 * integer-valued. Bare integer-valued numbers encode as LONG; use
 * `double(42)` when the peer's handler verifies a DOUBLE argument.
 */
export class VrpcDouble {
  constructor(readonly value: number) {}
  valueOf(): number {
    return this.value;
  }
  toString(): string {
    return String(this.value);
  }
}

/** Convenience constructor for {@link VrpcDouble}. */
export function double(value: number): VrpcDouble {
  return new VrpcDouble(value);
}

/**
 * Forces an integer to encode as value's NUMBER/BIGINT kind (ext type 1) even
 * when it fits int64. A bare `bigint` within int64 encodes as LONG, which is
 * what a peer usually wants; use `bigInt(5n)` when the peer's handler verifies
 * a BIGINT argument or when the bytes must match a value built with
 * `value.BigInt` in Go. Decoding never produces it: a BIGINT comes back as a
 * `bigint`.
 */
export class VrpcBigInt {
  constructor(readonly value: bigint) {}
  valueOf(): bigint {
    return this.value;
  }
  toString(): string {
    return this.value.toString();
  }
}

/** Convenience constructor for {@link VrpcBigInt}. */
export function bigInt(value: bigint | number | string): VrpcBigInt {
  return new VrpcBigInt(BigInt(value));
}

/**
 * An arbitrary-precision decimal: `coefficient * 10^exponent`, mirroring the
 * shopspring/decimal representation used by value's NUMBER/DECIMAL kind. On
 * the wire (ext type 2) it is a 4-byte scale, the negated exponent, followed
 * by the two's-complement coefficient. Round-trips through the msgpack codec.
 * The JSON codec cannot represent it (matching the Go-side asymmetry) and
 * rejects it on encode.
 */
export class VrpcDecimal {
  constructor(
    readonly coefficient: bigint,
    readonly exponent: number,
  ) {
    if (!Number.isInteger(exponent) || exponent < -2147483648 || exponent > 2147483647) {
      throw new RangeError(`vrpc: decimal exponent out of int32 range: ${exponent}`);
    }
  }

  /** Parses "123", "-1.045", "1.2e-5" style decimal strings. */
  static fromString(s: string): VrpcDecimal {
    const m = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(s.trim());
    if (!m) throw new SyntaxError(`vrpc: invalid decimal string: ${JSON.stringify(s)}`);
    const [, sign, int, frac = "", expStr] = m;
    let exponent = (expStr ? parseInt(expStr, 10) : 0) - frac.length;
    let digits = (int ?? "") + frac;
    digits = digits.replace(/^0+(?=\d)/, "");
    let coefficient = BigInt(digits);
    if (sign === "-") coefficient = -coefficient;
    return new VrpcDecimal(coefficient, exponent);
  }

  toString(): string {
    const neg = this.coefficient < 0n;
    let digits = (neg ? -this.coefficient : this.coefficient).toString();
    let out: string;
    if (this.exponent >= 0) {
      out = digits + "0".repeat(this.exponent);
    } else {
      const point = digits.length + this.exponent;
      if (point > 0) {
        out = digits.slice(0, point) + "." + digits.slice(point);
      } else {
        out = "0." + "0".repeat(-point) + digits;
      }
    }
    return (neg ? "-" : "") + out;
  }

  toNumber(): number {
    return Number(this.toString());
  }

  equals(other: VrpcDecimal): boolean {
    return this.coefficient === other.coefficient && this.exponent === other.exponent;
  }
}

/** Convenience constructor for {@link VrpcDecimal} from a decimal string. */
export function decimal(s: string): VrpcDecimal {
  return VrpcDecimal.fromString(s);
}

const NANOS_PER_SECOND = 1_000_000_000;
const NANOS_PER_MILLI = 1_000_000;
/** The largest magnitude a Date holds, in seconds (8.64e15 ms). */
const MAX_DATE_SECONDS = 8_640_000_000_000n;

/**
 * An instant with nanosecond precision: value's TIMESTAMP kind, MessagePack's
 * timestamp extension (type -1). `seconds` counts from the Unix epoch and
 * `nanos` lies within that second, 0 ≤ nanos < 1e9. It has no zone.
 *
 * A `Date` encodes as a timestamp too (whole milliseconds). The decoder always
 * yields a VrpcTimestamp, which keeps every nanosecond; `toDate()` converts
 * when millisecond precision is enough, and `exactAsDate()` tells whether
 * that conversion loses anything.
 */
export class VrpcTimestamp {
  constructor(
    readonly seconds: bigint,
    readonly nanos: number,
  ) {
    if (!Number.isInteger(nanos) || nanos < 0 || nanos >= NANOS_PER_SECOND) {
      throw new RangeError(`vrpc: timestamp nanoseconds out of range: ${nanos}`);
    }
    if (seconds < INT64_MIN || seconds > INT64_MAX) {
      throw new RangeError(`vrpc: timestamp seconds out of int64 range: ${seconds}`);
    }
  }

  /** The instant a Date denotes, at millisecond precision. */
  static fromDate(d: Date): VrpcTimestamp {
    const ms = d.getTime();
    if (!Number.isFinite(ms)) throw new RangeError("vrpc: invalid Date");
    const sec = Math.floor(ms / 1000);
    return new VrpcTimestamp(BigInt(sec), (ms - sec * 1000) * NANOS_PER_MILLI);
  }

  /**
   * Parses RFC 3339 text such as "2026-10-30T07:28:39.075Z" or
   * "2026-10-30T09:28:39+02:00", with up to nine fraction digits.
   */
  static fromString(s: string): VrpcTimestamp {
    const m =
      /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?([Zz]|[+-]\d{2}:\d{2})$/.exec(
        s.trim(),
      );
    if (!m) throw new SyntaxError(`vrpc: invalid RFC 3339 timestamp: ${JSON.stringify(s)}`);
    const [, y, mo, d, h, mi, sec, frac = "", zone] = m as unknown as [
      string, string, string, string, string, string, string, string | undefined, string,
    ];
    const dt = new Date(0);
    dt.setUTCFullYear(Number(y), Number(mo) - 1, Number(d));
    dt.setUTCHours(Number(h), Number(mi), Number(sec), 0);
    const same =
      dt.getUTCFullYear() === Number(y) &&
      dt.getUTCMonth() === Number(mo) - 1 &&
      dt.getUTCDate() === Number(d) &&
      dt.getUTCHours() === Number(h) &&
      dt.getUTCMinutes() === Number(mi) &&
      dt.getUTCSeconds() === Number(sec);
    if (!same) throw new SyntaxError(`vrpc: invalid RFC 3339 timestamp: ${JSON.stringify(s)}`);
    let seconds = BigInt(dt.getTime() / 1000);
    if (zone !== "Z" && zone !== "z") {
      const sign = zone[0] === "-" ? -1n : 1n;
      seconds -= sign * (BigInt(zone.slice(1, 3)) * 3600n + BigInt(zone.slice(4, 6)) * 60n);
    }
    return new VrpcTimestamp(seconds, Number((frac + "000000000").slice(0, 9)));
  }

  /** True when a Date holds this instant exactly: whole milliseconds within Date's range. */
  exactAsDate(): boolean {
    return (
      this.nanos % NANOS_PER_MILLI === 0 &&
      this.seconds >= -MAX_DATE_SECONDS &&
      this.seconds <= MAX_DATE_SECONDS
    );
  }

  /** The instant as a Date, truncated to whole milliseconds. */
  toDate(): Date {
    if (this.seconds < -MAX_DATE_SECONDS || this.seconds > MAX_DATE_SECONDS) {
      throw new RangeError(`vrpc: timestamp ${this.toString()} is outside the range of Date`);
    }
    return new Date(Number(this.seconds) * 1000 + Math.floor(this.nanos / NANOS_PER_MILLI));
  }

  /**
   * RFC 3339 in UTC with the fraction trimmed of trailing zeros, the text Go's
   * value renders: "2026-10-30T07:28:39.075Z", "2026-10-30T07:28:39Z".
   */
  toString(): string {
    if (this.seconds < -MAX_DATE_SECONDS || this.seconds > MAX_DATE_SECONDS) {
      return `${this.seconds}s${this.nanos}ns`;
    }
    const iso = new Date(Number(this.seconds) * 1000).toISOString(); // …T07:28:39.000Z
    let out = iso.slice(0, -5);
    if (this.nanos !== 0) out += "." + String(this.nanos).padStart(9, "0").replace(/0+$/, "");
    return out + "Z";
  }

  equals(other: VrpcTimestamp): boolean {
    return this.seconds === other.seconds && this.nanos === other.nanos;
  }
}

/** Convenience constructor for {@link VrpcTimestamp}. */
export function timestamp(seconds: bigint | number, nanos = 0): VrpcTimestamp {
  return new VrpcTimestamp(BigInt(seconds), nanos);
}

/**
 * An opaque msgpack extension value (value kind UNKNOWN): the ext tag plus its
 * payload bytes. Preserved through both codecs so unrecognized extensions
 * round-trip unchanged. The JSON form is the value-library convention
 * `"data:application/x-msgpack-ext;base64,<tag byte + data, base64>"`.
 */
export class VrpcExt {
  constructor(
    readonly tag: number,
    readonly data: Uint8Array,
  ) {
    if (!Number.isInteger(tag) || tag < 0 || tag > 255) {
      throw new RangeError(`vrpc: ext tag out of byte range: ${tag}`);
    }
  }

  equals(other: VrpcExt): boolean {
    return this.tag === other.tag && bytesEqual(this.data, other.data);
  }
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** True for objects that should encode as MAP (plain objects only). */
export function isPlainObject(v: unknown): v is { [key: string]: Value } {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: false });

export function utf8Encode(s: string): Uint8Array {
  return textEncoder.encode(s);
}

export function utf8Decode(b: Uint8Array): string {
  return textDecoder.decode(b);
}

/**
 * Compares two strings by their UTF-8 byte order — the ordering value uses for
 * canonical (sorted) map keys. This differs from JS default string comparison
 * for keys mixing astral-plane characters with U+E000..U+FFFF.
 */
export function compareUtf8(a: string, b: string): number {
  if (a === b) return 0;
  const ab = utf8Encode(a);
  const bb = utf8Encode(b);
  const n = Math.min(ab.length, bb.length);
  for (let i = 0; i < n; i++) {
    const d = (ab[i] as number) - (bb[i] as number);
    if (d !== 0) return d;
  }
  return ab.length - bb.length;
}

/** Sorted own enumerable string keys of a map source, canonical order. */
export function sortedMapKeys(obj: { [key: string]: Value } | Map<string, Value>): string[] {
  const keys = obj instanceof Map ? [...obj.keys()] : Object.keys(obj);
  return keys.sort(compareUtf8);
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64REV = new Int8Array(128).fill(-1);
for (let i = 0; i < B64.length; i++) B64REV[B64.charCodeAt(i)] = i;

/** Standard-alphabet base64 without padding (Go base64.RawStdEncoding). */
export function base64RawStdEncode(data: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < data.length; i += 3) {
    const n = ((data[i] as number) << 16) | ((data[i + 1] as number) << 8) | (data[i + 2] as number);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rest = data.length - i;
  if (rest === 1) {
    const n = (data[i] as number) << 16;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = ((data[i] as number) << 16) | ((data[i + 1] as number) << 8);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]!;
  }
  return out;
}

/** Decodes standard-alphabet base64; accepts both padded and unpadded input. */
export function base64RawStdDecode(s: string): Uint8Array {
  let end = s.length;
  while (end > 0 && s[end - 1] === "=") end--;
  const outLen = Math.floor((end * 3) / 4);
  const out = new Uint8Array(outLen);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < end; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? B64REV[c]! : -1;
    if (v < 0) throw new SyntaxError(`vrpc: invalid base64 character at ${i}`);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  if (o !== outLen) throw new SyntaxError("vrpc: truncated base64 input");
  return out;
}

export function bytesToHex(data: Uint8Array): string {
  let out = "";
  for (const b of data) out += b.toString(16).padStart(2, "0");
  return out;
}
