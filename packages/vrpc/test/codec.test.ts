/*
 * Copyright (c) 2026 Karagatan LLC.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import { jsonDecode, jsonEncode } from "../src/json.js";
import { msgpackDecode, msgpackEncode } from "../src/msgpack.js";
import { VrpcDecimal, VrpcDouble, VrpcExt, bytesToHex, decimal, double } from "../src/value.js";
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

  it("encodes BigInt beyond int64 as ext tag 1 (gob framing)", () => {
    // BigInt(123) example from CANONICAL.md: d5 01 02 7b (fixext2, tag 1)
    // — reachable from JS only beyond int64, but the framing must match.
    // ext8(len 10, tag 1), gob [0x02 version+sign, 0x01, 8 zero bytes]
    const enc = msgpackEncode(2n ** 64n); // 0x1_0000_0000_0000_0000
    expect(bytesToHex(enc)).toBe("c70a0102010000000000000000");
  });

  it("round-trips decimals as ext tag 2 (shopspring framing)", () => {
    const d = decimal("-1.045");
    expect(d.coefficient).toBe(-1045n);
    expect(d.exponent).toBe(-3);
    const rt = msgpackDecode(msgpackEncode(d));
    expect(rt).toBeInstanceOf(VrpcDecimal);
    expect((rt as VrpcDecimal).toString()).toBe("-1.045");
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
