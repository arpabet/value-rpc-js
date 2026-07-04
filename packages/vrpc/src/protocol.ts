/*
 * Copyright (c) 2026 Karagatan LLC.
 * SPDX-License-Identifier: Apache-2.0
 */

import { Code } from "./errors.js";
import { VrpcDouble, type Value, type ValueMap } from "./value.js";

/** vRPC message types (wire numbering; 12/13 reserved). */
export enum MessageType {
  HandshakeRequest = 0,
  HandshakeResponse = 1,
  FunctionRequest = 2,
  FunctionResponse = 3,
  GetStreamRequest = 4,
  PutStreamRequest = 5,
  ChatRequest = 6,
  ErrorResponse = 7,
  StreamReady = 8,
  StreamValue = 9,
  StreamEnd = 10,
  CancelRequest = 11,
  StreamCredit = 14,
}

/**
 * Dialect names the wire-level fields and markers of the vRPC envelope,
 * mirroring valuerpc.Dialect. Both peers MUST share the same dialect.
 * Override fields only if your Go deployment installed a custom Dialect.
 */
export interface Dialect {
  magic: string;
  version: number;
  handshakeRequestId: number;
  messageTypeField: string;
  magicField: string;
  versionField: string;
  requestIdField: string;
  timeoutField: string;
  clientIdField: string;
  sessionTokenField: string;
  authField: string;
  functionNameField: string;
  argumentsField: string;
  resultField: string;
  errorField: string;
  codeField: string;
  creditField: string;
  metadataField: string;
  valueField: string;
}

/** The standard vRPC dialect (the default wire format). */
export function newDialect(): Dialect {
  return {
    magic: "vRPC",
    version: 1.0,
    handshakeRequestId: 0,
    messageTypeField: "t",
    magicField: "m",
    versionField: "v",
    requestIdField: "rid",
    timeoutField: "sla",
    clientIdField: "cid",
    sessionTokenField: "tok",
    authField: "auth",
    functionNameField: "fn",
    argumentsField: "args",
    resultField: "res",
    errorField: "err",
    codeField: "code",
    creditField: "cr",
    metadataField: "md",
    valueField: "val",
  };
}

export type Metadata = Record<string, string>;

/** Envelope builders and field accessors bound to one dialect. */
export class Protocol {
  constructor(readonly d: Dialect) {}

  handshakeRequest(clientId: number, token: string, auth: Value | undefined): ValueMap {
    const req: ValueMap = {
      [this.d.magicField]: this.d.magic,
      // Sent as a DOUBLE like the Go client (value.Double(1.0)); the server
      // accepts any NUMBER <= its version.
      [this.d.versionField]: new VrpcDouble(this.d.version),
      [this.d.messageTypeField]: MessageType.HandshakeRequest,
      [this.d.requestIdField]: this.d.handshakeRequestId,
      [this.d.clientIdField]: clientId,
    };
    if (token !== "") req[this.d.sessionTokenField] = token;
    if (auth !== undefined && auth !== null) req[this.d.authField] = auth;
    return req;
  }

  request(
    mt: MessageType,
    requestId: number,
    name: string,
    args: Value | undefined,
    timeoutMs: number,
    metadata: Metadata | undefined,
  ): ValueMap {
    const req: ValueMap = {
      [this.d.messageTypeField]: mt,
      [this.d.requestIdField]: requestId,
      [this.d.functionNameField]: name,
    };
    if (args !== undefined) req[this.d.argumentsField] = args;
    if (timeoutMs > 0) req[this.d.timeoutField] = Math.floor(timeoutMs);
    if (metadata && Object.keys(metadata).length > 0) {
      req[this.d.metadataField] = { ...metadata };
    }
    return req;
  }

  functionResult(requestId: number, result: Value): ValueMap {
    const resp: ValueMap = {
      [this.d.messageTypeField]: MessageType.FunctionResponse,
      [this.d.requestIdField]: requestId,
    };
    if (result !== null && result !== undefined) resp[this.d.resultField] = result;
    return resp;
  }

  errorResponse(requestId: number, code: Code, message: string): ValueMap {
    return {
      [this.d.messageTypeField]: MessageType.ErrorResponse,
      [this.d.requestIdField]: requestId,
      [this.d.codeField]: code,
      [this.d.errorField]: message,
    };
  }

  streamReady(requestId: number): ValueMap {
    return {
      [this.d.messageTypeField]: MessageType.StreamReady,
      [this.d.requestIdField]: requestId,
    };
  }

  streamValue(requestId: number, value: Value): ValueMap {
    return {
      [this.d.messageTypeField]: MessageType.StreamValue,
      [this.d.requestIdField]: requestId,
      [this.d.valueField]: value,
    };
  }

  streamEnd(requestId: number, value?: Value): ValueMap {
    const resp: ValueMap = {
      [this.d.messageTypeField]: MessageType.StreamEnd,
      [this.d.requestIdField]: requestId,
    };
    if (value !== undefined && value !== null) resp[this.d.valueField] = value;
    return resp;
  }

  streamCredit(requestId: number, credit: number): ValueMap {
    return {
      [this.d.messageTypeField]: MessageType.StreamCredit,
      [this.d.requestIdField]: requestId,
      [this.d.creditField]: credit,
    };
  }

  cancelRequest(requestId: number): ValueMap {
    return {
      [this.d.messageTypeField]: MessageType.CancelRequest,
      [this.d.requestIdField]: requestId,
    };
  }

  // --- field accessors (absent or wrong-typed fields return undefined) ---

  messageType(msg: ValueMap): MessageType | undefined {
    return asIntField(msg[this.d.messageTypeField]);
  }

  requestId(msg: ValueMap): number | undefined {
    return asIntField(msg[this.d.requestIdField]);
  }

  functionName(msg: ValueMap): string | undefined {
    const v = msg[this.d.functionNameField];
    return typeof v === "string" ? v : undefined;
  }

  args(msg: ValueMap): Value {
    return msg[this.d.argumentsField] ?? null;
  }

  result(msg: ValueMap): Value {
    return msg[this.d.resultField] ?? null;
  }

  streamVal(msg: ValueMap): Value {
    return msg[this.d.valueField] ?? null;
  }

  credit(msg: ValueMap): number | undefined {
    return asIntField(msg[this.d.creditField]);
  }

  errorOf(msg: ValueMap): { code: Code; message: string } {
    const code = asIntField(msg[this.d.codeField]) ?? Code.Unknown;
    const err = msg[this.d.errorField];
    return { code: code as Code, message: typeof err === "string" ? err : "" };
  }

  metadata(msg: ValueMap): Metadata | undefined {
    const v = msg[this.d.metadataField];
    if (v === null || v === undefined || typeof v !== "object" || Array.isArray(v) || v instanceof Uint8Array) {
      return undefined;
    }
    const out: Metadata = {};
    let any = false;
    for (const [k, val] of Object.entries(v as ValueMap)) {
      if (typeof val === "string") {
        out[k] = val;
        any = true;
      }
    }
    return any ? out : undefined;
  }
}

function asIntField(v: Value | undefined): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "bigint") return Number(v);
  return undefined;
}
