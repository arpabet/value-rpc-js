# Changelog

All notable changes to the packages in this repository are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/), and
the packages follow [Semantic Versioning](https://semver.org/). All three
packages share one version.

## 0.3.0 — 2026-11-03

Wire alignment with `go.arpabet.com/value` v1.5.0. **The msgpack bytes of
decimals and big integers change**; a 0.3.0 client needs a server built with
value v1.5.0 or later to exchange those two kinds (every other kind is
unchanged, and timestamps pass through older servers as unknown extensions).

### Added

- **Timestamps.** `VrpcTimestamp` (`timestamp(seconds, nanos)`) is value's
  `TIMESTAMP` kind: MessagePack's timestamp extension (type -1) in its
  smallest form, with nanosecond precision and no zone. A `Date` encodes as
  one; the decoder yields a `VrpcTimestamp`, which loses nothing, with
  `toDate()`, `exactAsDate()`, `fromDate()`, `fromString()` (RFC 3339) and
  `toString()` (RFC 3339 in UTC, the text the Go side renders). The JSON codec
  writes timestamps as that text.
- `VrpcBigInt` (`bigInt(x)`) forces the BIGINT kind for an integer that fits
  int64, as `VrpcDouble` does for DOUBLE; a bare `bigint` keeps encoding as
  LONG when it fits.
- The conformance vectors of value, `test/canonical.json`, run against the
  codec (`test/vectors.test.ts`).
- `DecodeLimits.maxDecimalExponent` (default 2^20, value's
  `MaxDecimalExponent`) bounds the scale of a decoded decimal.
- Exported `twosComplementEncode`, `twosComplementDecode`, `timestampPayload`
  and the extension type constants.
- CI runs build, typecheck and tests, including the Go conformance suite, on
  every push and pull request.

### Changed

- **BigInt (ext type 1)** payloads are the minimal two's-complement big-endian
  integer (`BigInteger.toByteArray()`); **Decimal (ext type 2)** payloads are a
  4-byte big-endian scale followed by the two's-complement unscaled integer
  (`BigDecimal(unscaled, scale)`). Both replace Go's gob framings.
- `Value` includes `Date` and `VrpcTimestamp`.

### Removed

- `happy-dom` is no longer a runtime dependency of `@arpabet/vrpc`; it was
  listed by mistake. The package has no runtime dependencies.
- `bigIntGobEncode`/`bigIntGobDecode` (internal helpers of the old framing).

## 0.2.1

Previous release; see the git history.
