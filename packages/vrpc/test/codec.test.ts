/*
 * Copyright (c) 2026 Karagatan LLC.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import { jsonDecode, jsonEncode } from "../src/json.js";
import { msgpackDecode, msgpackEncode } from "../src/msgpack.js";
import {
  VrpcDecimal,
  VrpcDouble,
  VrpcExt,
  VrpcTimestamp,
  bytesToHex,
  decimal,
  double,
  timestamp,
} from "../src/value.js";
import type { Value } from "../src/value.js";

function hex(v: Value): string {
  return bytesToHex(msgpackEncode(v));
}

describe("msgpack golden vectors (value CANONICAL.md)", () => {
  it("encodes primitives canonically", () => {
    expect(hex(null)).toBe("c0");
    expect(hex(true)).toBe("c3");
    expect(hex(false)).toBe("c2");
    expect(hex(0)).toBe("00");
    expect(hex(127)).toBe("7f");
    expect(hex(128)).toBe("cc80");
    expect(hex(-1)).toBe("ff");
    expect(hex(-32)).toBe("e0");
    expect(hex(-33)).toBe("d0df");
    expect(hex(65535)).toBe("cdffff");
    expect(hex(65536)).toBe("ce00010000");
    expect(hex(-129)).toBe("d1ff7f");
    expect(hex(2 ** 32)).toBe("cf0000000100000000");
    expect(hex(-(2 ** 31) - 1)).toBe("d3ffffffff7fffffff");
    expect(hex(double(1.5))).toBe("cb3ff8000000000000");
    expect(hex(1.5)).toBe("cb3ff8000000000000");
    expect(hex(new VrpcDouble(1))).toBe("cb3ff0000000000000");
    expect(hex("hello")).toBe("a568656c6c6f");
    expect(hex(new Uint8Array([1, 2, 3]))).toBe("c403010203");
    expect(hex([1, 2, 3])).toBe("93010203");
    expect(hex({ a: 1, b: 2 })).toBe("82a16101a16202");
    expect(hex({ b: 2, a: 1 })).toBe("82a16101a16202"); // sorted keys
  });

  it("encodes int64 range via bigint", () => {
    expect(hex(9223372036854775807n)).toBe("cf7fffffffffffffff");
    expect(hex(-9223372036854775808n)).toBe("d38000000000000000");
    expect(hex(123n)).toBe("7b"); // small bigint collapses to LONG
  });

  it("encodes BigInt beyond int64 as ext type 1 (two's complement)", () => {
    // Reachable from JS only beyond int64; the layout is BigInteger.toByteArray():
    // 2^64 is 01 followed by eight zero bytes, -2^63-1 is ff7f…ff.
    expect(bytesToHex(msgpackEncode(2n ** 64n))).toBe("c70901010000000000000000");
    expect(bytesToHex(msgpackEncode(-(2n ** 63n) - 1n))).toBe("c70901ff7fffffffffffffff");
    expect(bytesToHex(msgpackEncode(10n ** 20n))).toBe("c70901056bc75e2d63100000");
    expect(msgpackDecode(msgpackEncode(10n ** 20n))).toBe(10n ** 20n);
    expect(msgpackDecode(msgpackEncode(-(10n ** 20n)))).toBe(-(10n ** 20n));
    // The small BigInt vectors of CANONICAL.md decode to JS integers.
    expect(msgpackDecode(new Uint8Array([0xd4, 0x01, 0x00]))).toBe(0n);
    expect(msgpackDecode(new Uint8Array([0xd4, 0x01, 0x7b]))).toBe(123n);
    expect(msgpackDecode(new Uint8Array([0xd4, 0x01, 0x80]))).toBe(-128n);
    expect(msgpackDecode(new Uint8Array([0xd5, 0x01, 0xff, 0x7f]))).toBe(-129n);
    // Sign-extended encodings decode too; an empty one does not.
    expect(msgpackDecode(new Uint8Array([0xd5, 0x01, 0xff, 0xff]))).toBe(-1n);
    expect(() => msgpackDecode(new Uint8Array([0xc7, 0x00, 0x01]))).toThrow(/empty/);
  });

  it("round-trips decimals as ext type 2 (scale + two's-complement unscaled)", () => {
    const d = decimal("-1.045");
    expect(d.coefficient).toBe(-1045n);
    expect(d.exponent).toBe(-3);
    expect(bytesToHex(msgpackEncode(d))).toBe("c7060200000003fbeb");
    expect(bytesToHex(msgpackEncode(decimal("1.10")))).toBe("c70502000000026e");
    expect(bytesToHex(msgpackEncode(decimal("0")))).toBe("c705020000000000");
    expect(bytesToHex(msgpackEncode(decimal("1e3")))).toBe("c70502fffffffd01");
    const rt = msgpackDecode(msgpackEncode(d));
    expect(rt).toBeInstanceOf(VrpcDecimal);
    expect((rt as VrpcDecimal).toString()).toBe("-1.045");
    expect((rt as VrpcDecimal).exponent).toBe(-3);
    // 1, 1.0 and 1.00 are three values with three encodings.
    const scales = ["1", "1.0", "1.00"].map((t) => bytesToHex(msgpackEncode(decimal(t))));
    expect(new Set(scales).size).toBe(3);
    expect(() => msgpackDecode(new Uint8Array([0xd6, 0x02, 0, 0, 0, 2]))).toThrow(/truncated/);
  });

  it("bounds the decimal scale like value's MaxDecimalExponent", () => {
    const huge = new Uint8Array([0xc7, 0x05, 0x02, 0x00, 0x10, 0x00, 0x01, 0x01]); // scale 2^20 + 1
    expect(() => msgpackDecode(huge)).toThrow(/scale/);
    const d = msgpackDecode(huge, { maxDepth: 10, maxCollectionLen: 10, maxByteLen: 100 }) as VrpcDecimal;
    expect(d.exponent).toBe(-(2 ** 20 + 1));
  });

  it("encodes timestamps as ext type -1 in the smallest form", () => {
    const epoch = timestamp(0);
    expect(hex(epoch)).toBe("d6ff00000000");
    expect(hex(timestamp(1793345319))).toBe("d6ff6ae44727");
    expect(hex(timestamp(1793345319, 75_000_000))).toBe("d7ff11e1a3006ae44727");
    expect(hex(timestamp(2n ** 32n - 1n))).toBe("d6ffffffffff");
    expect(hex(timestamp(2n ** 32n))).toBe("d7ff0000000100000000");
    expect(hex(timestamp(2n ** 34n - 1n, 999_999_999))).toBe("d7ffee6b27ffffffffff");
    expect(hex(timestamp(2n ** 34n))).toBe("c70cff000000000000000400000000");
    expect(hex(timestamp(-1, 500_000_000))).toBe("c70cff1dcd6500ffffffffffffffff");
    expect(hex(timestamp(-62135596800n))).toBe("c70cff00000000fffffff1886e0900");
  });

  it("encodes a Date as a timestamp and decodes to a lossless VrpcTimestamp", () => {
    const d = new Date("2026-10-30T07:28:39.075Z");
    expect(hex(d)).toBe("d7ff11e1a3006ae44727");
    const rt = msgpackDecode(msgpackEncode(d));
    expect(rt).toBeInstanceOf(VrpcTimestamp);
    const ts = rt as VrpcTimestamp;
    expect(ts.seconds).toBe(1793345319n);
    expect(ts.nanos).toBe(75_000_000);
    expect(ts.exactAsDate()).toBe(true);
    expect(ts.toDate().getTime()).toBe(d.getTime());
    expect(ts.toString()).toBe("2026-10-30T07:28:39.075Z");
    // Before the epoch and whole seconds.
    expect(VrpcTimestamp.fromDate(new Date(-1500)).equals(timestamp(-2, 500_000_000))).toBe(true);
    expect(timestamp(1793345319).toString()).toBe("2026-10-30T07:28:39Z");
    // Nanoseconds survive a round trip and are not a Date.
    const nanos = msgpackDecode(msgpackEncode(timestamp(1793345319, 123_456_789))) as VrpcTimestamp;
    expect(nanos.nanos).toBe(123_456_789);
    expect(nanos.exactAsDate()).toBe(false);
    expect(nanos.toDate().toISOString()).toBe("2026-10-30T07:28:39.123Z");
    expect(nanos.toString()).toBe("2026-10-30T07:28:39.123456789Z");
    expect(() => msgpackEncode(new Date(NaN))).toThrow(/invalid Date/);
  });

  it("parses RFC 3339 timestamps", () => {
    expect(VrpcTimestamp.fromString("2026-10-30T09:28:39.075+02:00").toString()).toBe("2026-10-30T07:28:39.075Z");
    expect(VrpcTimestamp.fromString("1969-12-31T23:59:59.5Z").equals(timestamp(-1, 500_000_000))).toBe(true);
    expect(VrpcTimestamp.fromString("0001-01-01T00:00:00Z").seconds).toBe(-62135596800n);
    expect(VrpcTimestamp.fromString("2026-10-30T07:28:39.123456789Z").nanos).toBe(123_456_789);
    expect(() => VrpcTimestamp.fromString("2026-13-01T00:00:00Z")).toThrow(/RFC 3339/);
    expect(() => VrpcTimestamp.fromString("yesterday")).toThrow(/RFC 3339/);
    expect(() => timestamp(0, 1_000_000_000)).toThrow(/nanoseconds/);
  });

  it("decodes any timestamp form and rejects bad ones", () => {
    // 96-bit form of an instant the 32-bit form holds: decodes, re-encodes canonically.
    const wide = new Uint8Array([0xc7, 0x0c, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0x6a, 0xe4, 0x47, 0x27]);
    expect(hex(msgpackDecode(wide))).toBe("d6ff6ae44727");
    expect(() => msgpackDecode(new Uint8Array([0xd5, 0xff, 0, 0]))).toThrow(/payload/);
    // nanoseconds 1e9 in the 64-bit form: 1e9 << 34 = ee6b2800 00000000
    expect(() => msgpackDecode(new Uint8Array([0xd7, 0xff, 0xee, 0x6b, 0x28, 0x00, 0, 0, 0, 0]))).toThrow(
      /nanoseconds/,
    );
  });

  it("round-trips unknown exts", () => {
    const ext = new VrpcExt(42, new Uint8Array([9, 8, 7]));
    const rt = msgpackDecode(msgpackEncode(ext));
    expect(rt).toBeInstanceOf(VrpcExt);
    expect((rt as VrpcExt).tag).toBe(42);
    expect([...(rt as VrpcExt).data]).toEqual([9, 8, 7]);
  });

  it("round-trips a nested envelope", () => {
    const env: Value = {
      t: 2,
      rid: 1,
      fn: "user.get",
      args: [42, "x", null, true, new Uint8Array([0, 255]), { deep: [1.25] }],
      sla: 5000,
    };
    expect(msgpackDecode(msgpackEncode(env))).toEqual(env);
  });

  it("decodes int64 beyond 2^53 as bigint", () => {
    const v = msgpackDecode(msgpackEncode(9007199254740993n));
    expect(v).toBe(9007199254740993n);
    expect(msgpackDecode(msgpackEncode(9007199254740991n))).toBe(9007199254740991);
  });

  it("rejects unsafe integer numbers with guidance", () => {
    expect(() => msgpackEncode(2 ** 53 + 2)).toThrow(/bigint/);
  });

  it("treats -0 as Long 0", () => {
    expect(hex(-0)).toBe("00");
  });

  it("rejects trailing bytes and truncated input", () => {
    const good = msgpackEncode([1, 2]);
    expect(() => msgpackDecode(new Uint8Array([...good, 0x00]))).toThrow(/trailing/);
    expect(() => msgpackDecode(good.subarray(0, good.length - 1))).toThrow(/truncated/);
  });

  it("decodes sparse-list encodings (int-keyed maps) as objects", () => {
    // {0:10, 2:20} -> 82 00 0a 02 14 (SparseList canonical example)
    const v = msgpackDecode(new Uint8Array([0x82, 0x00, 0x0a, 0x02, 0x14]));
    expect(v).toEqual({ "0": 10, "2": 20 });
  });
});

describe("json codec (WEB.md §3.1 conventions)", () => {
  it("writes canonical sorted-key JSON", () => {
    expect(jsonEncode({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(jsonEncode([1, "x", null, true])).toBe('[1,"x",null,true]');
  });

  it("encodes bytes with the base64 raw-std convention", () => {
    expect(jsonEncode(new Uint8Array([0, 1, 2, 3, 4, 5]))).toBe('"base64,AAECAwQF"');
    expect(jsonDecode('"base64,AAECAwQF"')).toEqual(new Uint8Array([0, 1, 2, 3, 4, 5]));
  });

  it("round-trips exts through the data-uri convention", () => {
    const ext = new VrpcExt(3, new Uint8Array([1]));
    const text = jsonEncode(ext);
    expect(text).toBe('"data:application/x-msgpack-ext;base64,AwE"');
    const rt = jsonDecode(text) as VrpcExt;
    expect(rt.tag).toBe(3);
    expect([...rt.data]).toEqual([1]);
  });

  it("maps NaN and infinities to null", () => {
    expect(jsonEncode(NaN)).toBe("null");
    expect(jsonEncode(double(Infinity))).toBe("null");
    expect(jsonEncode(-Infinity)).toBe("null");
  });

  it("rejects values that cannot travel exactly", () => {
    expect(() => jsonEncode(2 ** 53 + 2)).toThrow(/2\^53/);
    expect(() => jsonEncode(2n ** 64n)).toThrow(/msgpack/);
    expect(() => jsonEncode(decimal("1.5"))).toThrow(/Decimal/);
  });

  it("renders timestamps as RFC 3339 text, which reads back as a string", () => {
    expect(jsonEncode(new Date("2026-10-30T07:28:39.075Z"))).toBe('"2026-10-30T07:28:39.075Z"');
    expect(jsonEncode(timestamp(1793345319))).toBe('"2026-10-30T07:28:39Z"');
    expect(jsonEncode({ when: timestamp(1793345319, 123_456_789) })).toBe('{"when":"2026-10-30T07:28:39.123456789Z"}');
    expect(jsonDecode('"2026-10-30T07:28:39Z"')).toBe("2026-10-30T07:28:39Z");
  });

  it("keeps ordinary strings intact", () => {
    expect(jsonDecode('"hello"')).toBe("hello");
    expect(jsonDecode('"0x7b"')).toBe("0x7b"); // bigint strings stay strings by policy
  });

  it("matches the WEB.md handshake example shape", () => {
    const frame = jsonEncode({
      cid: 712398211,
      m: "vRPC",
      rid: 0,
      t: 0,
      tok: "abc",
    });
    expect(frame).toBe('{"cid":712398211,"m":"vRPC","rid":0,"t":0,"tok":"abc"}');
  });
});
