/*
 * Copyright (c) 2026 Karagatan LLC.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MessagePack codec producing the canonical byte form of go.arpabet.com/value
 * (see its CANONICAL.md): minimal integer family, doubles always float64,
 * str/bin distinct, map keys sorted by UTF-8 byte order, BIGINT as ext tag 1
 * (big.Int gob framing), DECIMAL as ext tag 2 (shopspring framing). Equal
 * values therefore produce byte-identical frames on both sides of the wire.
 */

import {
  INT64_MAX,
  INT64_MIN,
  VrpcDecimal,
  VrpcDouble,
  VrpcExt,
  compareUtf8,
  isPlainObject,
  utf8Decode,
  utf8Encode,
  type Value,
  type ValueMap,
} from "./value.js";

export const BIGINT_EXT_TAG = 1;
export const DECIMAL_EXT_TAG = 2;

/** Decode limits mirroring value's limits.go defaults. */
export interface DecodeLimits {
  maxDepth: number;
  maxCollectionLen: number;
  maxByteLen: number;
}

export const DEFAULT_LIMITS: DecodeLimits = {
  maxDepth: 1000,
  maxCollectionLen: 16_777_216,
  maxByteLen: 1_073_741_824,
};

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

class Writer {
  buf = new Uint8Array(256);
  len = 0;

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  byte(b: number): void {
    this.ensure(1);
    this.buf[this.len++] = b;
  }

  bytes(data: Uint8Array): void {
    this.ensure(data.length);
    this.buf.set(data, this.len);
    this.len += data.length;
  }

  u16(v: number): void {
    this.ensure(2);
    this.buf[this.len++] = (v >> 8) & 0xff;
    this.buf[this.len++] = v & 0xff;
  }

  u32(v: number): void {
    this.ensure(4);
    this.buf[this.len++] = (v >>> 24) & 0xff;
    this.buf[this.len++] = (v >>> 16) & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = v & 0xff;
  }

  u64(v: bigint): void {
    this.ensure(8);
    const dv = new DataView(this.buf.buffer, this.buf.byteOffset + this.len, 8);
    dv.setBigUint64(0, BigInt.asUintN(64, v));
    this.len += 8;
  }

  f64(v: number): void {
    this.ensure(8);
    const dv = new DataView(this.buf.buffer, this.buf.byteOffset + this.len, 8);
    dv.setFloat64(0, v);
    this.len += 8;
  }

  result(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

function packLongNumber(w: Writer, v: number): void {
  // Safe-range integer; mirrors value's WriteLong (positives use the unsigned
  // family, negatives the signed family, both minimal).
  if (v >= 0) {
    if (v <= 0x7f) w.byte(v);
    else if (v <= 0xff) {
      w.byte(0xcc);
      w.byte(v);
    } else if (v <= 0xffff) {
      w.byte(0xcd);
      w.u16(v);
    } else if (v <= 0xffffffff) {
      w.byte(0xce);
      w.u32(v);
    } else {
      w.byte(0xcf);
      w.u64(BigInt(v));
    }
  } else {
    if (v >= -32) w.byte(0x100 + v);
    else if (v >= -128) {
      w.byte(0xd0);
      w.byte(v & 0xff);
    } else if (v >= -32768) {
      w.byte(0xd1);
      w.u16(v & 0xffff);
    } else if (v >= -2147483648) {
      w.byte(0xd2);
      w.u32(v >>> 0);
    } else {
      w.byte(0xd3);
      w.u64(BigInt.asUintN(64, BigInt(v)));
    }
  }
}

function packLongBig(w: Writer, v: bigint): void {
  if (v >= 0n) {
    if (v <= 0xffffffffn) {
      packLongNumber(w, Number(v));
    } else {
      w.byte(0xcf);
      w.u64(v);
    }
  } else if (v >= -2147483648n) {
    packLongNumber(w, Number(v));
  } else {
    w.byte(0xd3);
    w.u64(BigInt.asUintN(64, v));
  }
}

function packDouble(w: Writer, v: number): void {
  w.byte(0xcb);
  w.f64(v);
}

function packStr(w: Writer, s: string): void {
  const b = utf8Encode(s);
  if (b.length < 32) w.byte(0xa0 | b.length);
  else if (b.length <= 0xff) {
    w.byte(0xd9);
    w.byte(b.length);
  } else if (b.length <= 0xffff) {
    w.byte(0xda);
    w.u16(b.length);
  } else {
    w.byte(0xdb);
    w.u32(b.length);
  }
  w.bytes(b);
}

function packBin(w: Writer, b: Uint8Array): void {
  if (b.length <= 0xff) {
    w.byte(0xc4);
    w.byte(b.length);
  } else if (b.length <= 0xffff) {
    w.byte(0xc5);
    w.u16(b.length);
  } else {
    w.byte(0xc6);
    w.u32(b.length);
  }
  w.bytes(b);
}

function packExt(w: Writer, tag: number, data: Uint8Array): void {
  const n = data.length;
  if (n === 1) w.byte(0xd4);
  else if (n === 2) w.byte(0xd5);
  else if (n === 4) w.byte(0xd6);
  else if (n === 8) w.byte(0xd7);
  else if (n === 16) w.byte(0xd8);
  else if (n <= 0xff) {
    w.byte(0xc7);
    w.byte(n);
  } else if (n <= 0xffff) {
    w.byte(0xc8);
    w.u16(n);
  } else {
    w.byte(0xc9);
    w.u32(n);
  }
  w.byte(tag);
  w.bytes(data);
}

/** big.Int gob framing: [version<<1 | signBit, ...big-endian magnitude]. */
export function bigIntGobEncode(v: bigint): Uint8Array {
  const neg = v < 0n;
  let abs = neg ? -v : v;
  const mag: number[] = [];
  while (abs > 0n) {
    mag.unshift(Number(abs & 0xffn));
    abs >>= 8n;
  }
  const out = new Uint8Array(1 + mag.length);
  out[0] = (1 << 1) | (neg ? 1 : 0);
  out.set(mag, 1);
  return out;
}

export function bigIntGobDecode(data: Uint8Array): bigint {
  if (data.length === 0) throw new SyntaxError("vrpc: empty bigint payload");
  const first = data[0] as number;
  if (first >> 1 !== 1) throw new SyntaxError(`vrpc: unsupported bigint gob version ${first >> 1}`);
  const neg = (first & 1) === 1;
  let v = 0n;
  for (let i = 1; i < data.length; i++) v = (v << 8n) | BigInt(data[i] as number);
  return neg ? -v : v;
}

function packBigInt(w: Writer, v: bigint): void {
  packExt(w, BIGINT_EXT_TAG, bigIntGobEncode(v));
}

function packDecimal(w: Writer, v: VrpcDecimal): void {
  const coef = bigIntGobEncode(v.coefficient);
  const payload = new Uint8Array(4 + coef.length);
  const dv = new DataView(payload.buffer);
  dv.setInt32(0, v.exponent);
  payload.set(coef, 4);
  packExt(w, DECIMAL_EXT_TAG, payload);
}

function packValue(w: Writer, v: Value | undefined): void {
  if (v === null || v === undefined) {
    w.byte(0xc0);
    return;
  }
  switch (typeof v) {
    case "boolean":
      w.byte(v ? 0xc3 : 0xc2);
      return;
    case "number":
      if (Number.isSafeInteger(v)) packLongNumber(w, v === 0 ? 0 : v); // -0 -> Long 0
      else if (Number.isInteger(v)) {
        throw new RangeError(
          `vrpc: integer ${v} exceeds ±2^53; pass a bigint for exact int64 encoding`,
        );
      } else packDouble(w, v);
      return;
    case "string":
      packStr(w, v);
      return;
    case "bigint":
      if (v >= INT64_MIN && v <= INT64_MAX) packLongBig(w, v);
      else packBigInt(w, v);
      return;
    case "object":
      break;
    default:
      throw new TypeError(`vrpc: cannot encode ${typeof v} as a value`);
  }
  if (v instanceof Uint8Array) {
    packBin(w, v);
  } else if (v instanceof VrpcDouble) {
    packDouble(w, v.value);
  } else if (v instanceof VrpcDecimal) {
    packDecimal(w, v);
  } else if (v instanceof VrpcExt) {
    packExt(w, v.tag, v.data);
  } else if (Array.isArray(v)) {
    if (v.length < 16) w.byte(0x90 | v.length);
    else if (v.length <= 0xffff) {
      w.byte(0xdc);
      w.u16(v.length);
    } else {
      w.byte(0xdd);
      w.u32(v.length);
    }
    for (const item of v) packValue(w, item);
  } else if (v instanceof Map) {
    packMapEntries(
      w,
      [...v.keys()].map((k) => String(k)),
      (k) => v.get(k) as Value,
    );
  } else if (isPlainObject(v)) {
    packMapEntries(w, Object.keys(v), (k) => v[k] as Value);
  } else {
    throw new TypeError(`vrpc: cannot encode ${(v as object).constructor?.name ?? "object"} as a value`);
  }
}

function packMapEntries(w: Writer, keys: string[], get: (k: string) => Value | undefined): void {
  const live = keys.filter((k) => get(k) !== undefined).sort(compareUtf8);
  if (live.length < 16) w.byte(0x80 | live.length);
  else if (live.length <= 0xffff) {
    w.byte(0xde);
    w.u16(live.length);
  } else {
    w.byte(0xdf);
    w.u32(live.length);
  }
  for (const k of live) {
    packStr(w, k);
    packValue(w, get(k));
  }
}

/** Encodes a single value in value's canonical MessagePack form. */
export function msgpackEncode(v: Value): Uint8Array {
  const w = new Writer();
  packValue(w, v);
  return w.result();
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

class Reader {
  pos = 0;
  private readonly dv: DataView;

  constructor(
    readonly buf: Uint8Array,
    readonly limits: DecodeLimits,
  ) {
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  byte(): number {
    if (this.pos >= this.buf.length) throw new SyntaxError("vrpc: truncated msgpack input");
    return this.buf[this.pos++] as number;
  }

  take(n: number): Uint8Array {
    if (n > this.limits.maxByteLen) throw new RangeError(`vrpc: msgpack byte length ${n} exceeds limit`);
    if (this.pos + n > this.buf.length) throw new SyntaxError("vrpc: truncated msgpack input");
    const out = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  u8(): number {
    return this.byte();
  }
  u16(): number {
    const v = this.dv.getUint16(this.need(2));
    return v;
  }
  u32(): number {
    return this.dv.getUint32(this.need(4));
  }
  i8(): number {
    return this.dv.getInt8(this.need(1));
  }
  i16(): number {
    return this.dv.getInt16(this.need(2));
  }
  i32(): number {
    return this.dv.getInt32(this.need(4));
  }
  i64(): bigint {
    return this.dv.getBigInt64(this.need(8));
  }
  u64(): bigint {
    return this.dv.getBigUint64(this.need(8));
  }
  f32(): number {
    return this.dv.getFloat32(this.need(4));
  }
  f64(): number {
    return this.dv.getFloat64(this.need(8));
  }

  private need(n: number): number {
    if (this.pos + n > this.buf.length) throw new SyntaxError("vrpc: truncated msgpack input");
    const at = this.pos;
    this.pos += n;
    return at;
  }
}

function normalizeInt(v: bigint): number | bigint {
  return v >= -9007199254740991n && v <= 9007199254740991n ? Number(v) : v;
}

function decodeExt(tag: number, data: Uint8Array): Value {
  if (tag === BIGINT_EXT_TAG) return bigIntGobDecode(data);
  if (tag === DECIMAL_EXT_TAG) {
    if (data.length < 5) throw new SyntaxError("vrpc: truncated decimal payload");
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const exponent = dv.getInt32(0);
    return new VrpcDecimal(bigIntGobDecode(data.subarray(4)), exponent);
  }
  return new VrpcExt(tag, data);
}

function readValue(r: Reader, depth: number): Value {
  if (depth > r.limits.maxDepth) throw new RangeError("vrpc: msgpack nesting too deep");
  const b = r.byte();

  if (b <= 0x7f) return b; // positive fixint
  if (b >= 0xe0) return b - 0x100; // negative fixint
  if (b >= 0xa0 && b <= 0xbf) return utf8Decode(r.take(b & 0x1f)); // fixstr
  if (b >= 0x90 && b <= 0x9f) return readList(r, b & 0x0f, depth); // fixarray
  if (b >= 0x80 && b <= 0x8f) return readMap(r, b & 0x0f, depth); // fixmap

  switch (b) {
    case 0xc0:
      return null;
    case 0xc2:
      return false;
    case 0xc3:
      return true;
    case 0xc4:
      return r.take(r.u8());
    case 0xc5:
      return r.take(r.u16());
    case 0xc6:
      return r.take(r.u32());
    case 0xc7: {
      const n = r.u8();
      return decodeExt(r.byte(), r.take(n));
    }
    case 0xc8: {
      const n = r.u16();
      return decodeExt(r.byte(), r.take(n));
    }
    case 0xc9: {
      const n = r.u32();
      return decodeExt(r.byte(), r.take(n));
    }
    case 0xca:
      return r.f32();
    case 0xcb:
      return r.f64();
    case 0xcc:
      return r.u8();
    case 0xcd:
      return r.u16();
    case 0xce:
      return r.u32();
    case 0xcf:
      return normalizeInt(r.u64());
    case 0xd0:
      return r.i8();
    case 0xd1:
      return r.i16();
    case 0xd2:
      return r.i32();
    case 0xd3:
      return normalizeInt(r.i64());
    case 0xd4:
      return decodeExt(r.byte(), r.take(1));
    case 0xd5:
      return decodeExt(r.byte(), r.take(2));
    case 0xd6:
      return decodeExt(r.byte(), r.take(4));
    case 0xd7:
      return decodeExt(r.byte(), r.take(8));
    case 0xd8:
      return decodeExt(r.byte(), r.take(16));
    case 0xd9:
      return utf8Decode(r.take(r.u8()));
    case 0xda:
      return utf8Decode(r.take(r.u16()));
    case 0xdb:
      return utf8Decode(r.take(r.u32()));
    case 0xdc:
      return readList(r, r.u16(), depth);
    case 0xdd:
      return readList(r, r.u32(), depth);
    case 0xde:
      return readMap(r, r.u16(), depth);
    case 0xdf:
      return readMap(r, r.u32(), depth);
    default:
      throw new SyntaxError(`vrpc: unsupported msgpack format 0x${b.toString(16)}`);
  }
}

function readList(r: Reader, n: number, depth: number): Value[] {
  if (n > r.limits.maxCollectionLen) throw new RangeError(`vrpc: msgpack list length ${n} exceeds limit`);
  const out: Value[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = readValue(r, depth + 1);
  return out;
}

function readMap(r: Reader, n: number, depth: number): ValueMap {
  if (n > r.limits.maxCollectionLen) throw new RangeError(`vrpc: msgpack map length ${n} exceeds limit`);
  const out: ValueMap = {};
  for (let i = 0; i < n; i++) {
    const key = readValue(r, depth + 1);
    const val = readValue(r, depth + 1);
    // String keys are the MAP form; integer keys are value's SparseList
    // encoding — surfaced as stringified keys, matching the JSON projection.
    if (typeof key === "string") out[key] = val;
    else if (typeof key === "number" || typeof key === "bigint") out[String(key)] = val;
    else throw new SyntaxError("vrpc: unsupported msgpack map key type");
  }
  return out;
}

/** Decodes one value; throws on malformed, truncated, or oversized input. */
export function msgpackDecode(data: Uint8Array, limits: DecodeLimits = DEFAULT_LIMITS): Value {
  const r = new Reader(data, limits);
  const v = readValue(r, 0);
  if (r.pos !== data.length) throw new SyntaxError("vrpc: trailing bytes after msgpack value");
  return v;
}
