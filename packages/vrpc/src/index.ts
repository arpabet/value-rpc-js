/*
 * Copyright (c) 2026 Karagatan LLC.
 * SPDX-License-Identifier: Apache-2.0
 */

export {
  VrpcClient,
  createClient,
  type CallOptions,
  type ChatHandler,
  type ClientEvents,
  type ClientOptions,
  type HandlerContext,
  type IncomingStreamHandler,
  type OutgoingStreamHandler,
  type ReconnectOptions,
  type Status,
  type UnaryHandler,
  type VrpcChat,
  type VrpcStream,
} from "./client.js";

export { Code, VrpcError, codeName, codeOf } from "./errors.js";

export {
  VrpcBigInt,
  VrpcDecimal,
  VrpcDouble,
  VrpcExt,
  VrpcTimestamp,
  bigInt,
  decimal,
  double,
  timestamp,
  type Value,
  type ValueMap,
} from "./value.js";

export {
  MessageType,
  Protocol,
  newDialect,
  type Dialect,
  type Metadata,
} from "./protocol.js";

export {
  codecByName,
  jsonCodec,
  msgpackCodec,
  type CodecName,
  type WireCodec,
} from "./codec.js";

export {
  msgpackDecode,
  msgpackEncode,
  timestampPayload,
  twosComplementDecode,
  twosComplementEncode,
  BIGINT_EXT_TAG,
  DECIMAL_EXT_TAG,
  DEFAULT_LIMITS,
  TIMESTAMP_EXT_TAG,
  type DecodeLimits,
} from "./msgpack.js";
export { jsonDecode, jsonEncode } from "./json.js";
export { HashChain } from "./hashchain.js";
export { webSocketDialer, type DialOptions, type Dialer, type Transport } from "./transport.js";
export { typedClient, type ApiShape, type TypedChat, type TypedClient, type TypedStream } from "./typed.js";
