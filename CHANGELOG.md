# Changelog

All notable changes to the packages in this repository are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/), and
the packages follow [Semantic Versioning](https://semver.org/). All three
packages share one version.

## 0.4.0 — 2026-11-24

The client negotiates its codec as the Go client does. **A 0.4.0 client needs
a value-rpc server of v1.5.3 or later**, the first that negotiates.

### Changed

- **The msgpack codec offers the `vrpc.msgpack` WebSocket subprotocol** and
  requires the server to echo it. It offered nothing, on the reading that no
  subprotocol is the msgpack negotiation; but value-rpc's own client has
  offered `vrpc.msgpack` since the negotiation was added (v1.5.3), and the Go
  implementation is the reference. The JSON codec is unchanged (`vrpc.json`).
  Against a server that echoes nothing the connect fails with
  `Code.Unavailable` and an error that says why. To reach such a server pass a
  codec that offers nothing: `codec: { ...msgpackCodec(), subprotocols: [] }`.

### Added

- `SUBPROTOCOL_MSGPACK` and `SUBPROTOCOL_JSON`, the tokens of the two codecs.
- The conformance suite echoes text with control characters, quotes and
  backslashes, as a value and as a map key, in both codecs. Over JSON this
  needs a server built with value v1.6.2 (value-rpc v1.6.5), which the
  conformance server now is: before, such an answer was not JSON, and the
  client could not read it.

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
