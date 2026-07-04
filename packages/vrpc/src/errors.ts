/*
 * Copyright (c) 2026 Karagatan LLC.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Machine-readable RPC status, mirroring valuerpc.Code (a useful subset of
 * gRPC status codes). Carried on the wire in ErrorResponse frames.
 */
export enum Code {
  OK = 0,
  Unknown = 1,
  Canceled = 2,
  InvalidArgument = 3,
  DeadlineExceeded = 4,
  NotFound = 5,
  ResourceExhausted = 6,
  Unavailable = 7,
  Unauthenticated = 8,
  Internal = 9,
}

const CODE_NAMES: Record<number, string> = {
  [Code.OK]: "OK",
  [Code.Unknown]: "Unknown",
  [Code.Canceled]: "Canceled",
  [Code.InvalidArgument]: "InvalidArgument",
  [Code.DeadlineExceeded]: "DeadlineExceeded",
  [Code.NotFound]: "NotFound",
  [Code.ResourceExhausted]: "ResourceExhausted",
  [Code.Unavailable]: "Unavailable",
  [Code.Unauthenticated]: "Unauthenticated",
  [Code.Internal]: "Internal",
};

export function codeName(code: Code): string {
  return CODE_NAMES[code] ?? "Unknown";
}

/**
 * A coded RPC error, mirroring *valuerpc.Error. Server-raised failures arrive
 * with the server's code; client-local failures (timeout, connection loss,
 * cancellation) use the matching local code so callers can branch on
 * `err.code` the way Go callers branch on valuerpc.CodeOf(err).
 */
export class VrpcError extends Error {
  override readonly name = "VrpcError";
  constructor(
    readonly code: Code,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`vrpc ${codeName(code)}: ${message}`, options);
  }

  /** The message without the "vrpc <Code>: " prefix. */
  get detail(): string {
    return this.message.replace(/^vrpc [A-Za-z]+: /, "");
  }
}

/** The Code carried by err: VrpcError's code, or Unknown for foreign errors. */
export function codeOf(err: unknown): Code {
  if (err == null) return Code.OK;
  if (err instanceof VrpcError) return err.code;
  return Code.Unknown;
}

export function errTimeout(what: string, ms: number): VrpcError {
  return new VrpcError(Code.DeadlineExceeded, `${what} timed out after ${ms}ms`);
}

export function errCanceled(what: string): VrpcError {
  return new VrpcError(Code.Canceled, `${what} was canceled`);
}

export function errConnectionLost(): VrpcError {
  return new VrpcError(Code.Unavailable, "connection lost");
}

export function errClientClosed(): VrpcError {
  return new VrpcError(Code.Unavailable, "client closed");
}
