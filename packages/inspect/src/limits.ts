/**
 * Reader and gateway limits that are not part of the public wire contract.
 * The deadline bound is on the wire: `Protocol.maxDeadlineMillis`.
 */
import type { Protocol } from "effect-frame/inspection";
import { Match } from "effect";

export const DEFAULT_DEADLINE_MILLIS = 5_000;

/** Reader request bodies are tiny; a larger one is refused as it arrives. */
export const MAX_REQUEST_BYTES = 4_096;

/** The HTTP status for each gateway error. */
export const statusOf = (error: Protocol.GatewayError): number =>
  Match.valueTags(error, {
    UnsupportedProtocolVersion: () => 400,
    MalformedRequest: () => 400,
    InvalidDeadline: () => 400,
    Unauthorized: () => 401,
    ForbiddenOrigin: () => 403,
    ForbiddenHost: () => 403,
    NotFound: () => 404,
    RootNotFound: () => 404,
    AmbiguousRoot: () => 409,
    SnapshotTooLarge: () => 413,
    TooManyRoots: () => 503,
    RootDisconnected: () => 502,
    RootProtocolError: () => 502,
    DeadlineExceeded: () => 504,
  });
