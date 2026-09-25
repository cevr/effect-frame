/**
 * Reader and gateway limits that are not part of the public wire contract.
 * The deadline bound is on the wire: `Protocol.maxDeadlineMillis`.
 */
import type { Protocol } from "effect-frame/inspection";

export const DEFAULT_DEADLINE_MILLIS = 5_000;

/** Reader request bodies are tiny; a larger one is refused as it arrives. */
export const MAX_REQUEST_BYTES = 4_096;

/** The HTTP status for each gateway error. */
export const statusOf = (error: Protocol.GatewayError): number => {
  switch (error._tag) {
    case "UnsupportedProtocolVersion":
    case "MalformedRequest":
    case "InvalidDeadline":
      return 400;
    case "Unauthorized":
      return 401;
    case "ForbiddenOrigin":
    case "ForbiddenHost":
      return 403;
    case "NotFound":
    case "RootNotFound":
      return 404;
    case "AmbiguousRoot":
      return 409;
    case "SnapshotTooLarge":
      return 413;
    case "TooManyRoots":
      return 503;
    case "RootDisconnected":
    case "RootProtocolError":
      return 502;
    case "DeadlineExceeded":
      return 504;
  }
};
