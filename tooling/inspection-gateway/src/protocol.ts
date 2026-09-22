/**
 * The browser-safe inspection protocol. Both the browser attachment and the
 * gateway import this module; it has no platform imports.
 *
 * Two boundaries use it:
 *
 * - Root link: the browser dials the gateway with one WebSocket. The browser
 *   is the RPC server for `RootRpcs`; the gateway is the RPC client.
 * - Reader API: a CLI-shaped client calls the gateway over loopback HTTP with
 *   one versioned JSON request and one versioned JSON response.
 */
import * as Frame from "effect-frame/frame";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";

export const PROTOCOL_VERSION = 1;

/** The WebSocket subprotocol that carries the root-link protocol version. */
export const ROOT_SUBPROTOCOL = `effect-frame-inspection.v${PROTOCOL_VERSION}`;
/** The WebSocket subprotocol prefix that carries the attach capability. */
export const ATTACH_TOKEN_PREFIX = "effect-frame-attach.";
/** The reader API version header. */
export const VERSION_HEADER = "effect-frame-inspection-version";

export const ATTACH_PATH = "/v1/attach";
export const ROOTS_PATH = "/v1/roots";
export const INSPECT_PATH = "/v1/inspect";

/** Limits shared by the gateway and the reader client. */
export const MAX_DEADLINE_MILLIS = 30_000;
export const DEFAULT_DEADLINE_MILLIS = 5_000;
export const MAX_SELECTOR_LENGTH = 256;
export const MAX_ROOT_NAME_LENGTH = 128;

/** True when any UTF-16 unit is below U+0020. */
export const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) < 0x20) return true;
  }
  return false;
};

// ---------------------------------------------------------------------------
// Root link
// ---------------------------------------------------------------------------

/** The encoded snapshot exceeded the gateway's byte limit. */
export const SnapshotTooLarge = Schema.TaggedStruct("SnapshotTooLarge", {
  bytes: Schema.Finite,
  limit: Schema.Finite,
});
export type SnapshotTooLarge = Schema.Schema.Type<typeof SnapshotTooLarge>;

/**
 * One RPC: take a fresh sample of the attached root. The gateway sends its
 * byte limit so the browser measures the encoded sample before it replies.
 */
export const Inspect = Rpc.make("Inspect", {
  payload: { maxBytes: Schema.Int },
  success: Frame.Snapshot,
  error: SnapshotTooLarge,
});

export const RootRpcs = RpcGroup.make(Inspect);

/** Root identities are Frame root IDs: printable, short, and URL-safe. */
export const RootId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._:-]{1,128}$/));

// ---------------------------------------------------------------------------
// Reader API
// ---------------------------------------------------------------------------

export const RootInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.NullOr(Schema.String),
  /** A gateway-local counter. A reconnect of the same root gets a new one. */
  incarnation: Schema.Int,
  attachedAt: Schema.Finite,
});
export type RootInfo = Schema.Schema.Type<typeof RootInfo>;

export const InspectRequest = Schema.Struct({
  version: Schema.Literal(PROTOCOL_VERSION),
  root: Schema.String,
  deadlineMillis: Schema.Int,
});
export type InspectRequest = Schema.Schema.Type<typeof InspectRequest>;

const errors = {
  UnsupportedProtocolVersion: Schema.TaggedStruct("UnsupportedProtocolVersion", {
    received: Schema.String,
    supported: Schema.Array(Schema.Finite),
  }),
  MalformedRequest: Schema.TaggedStruct("MalformedRequest", { detail: Schema.String }),
  Unauthorized: Schema.TaggedStruct("Unauthorized", {}),
  ForbiddenOrigin: Schema.TaggedStruct("ForbiddenOrigin", { origin: Schema.String }),
  ForbiddenHost: Schema.TaggedStruct("ForbiddenHost", { host: Schema.String }),
  NotFound: Schema.TaggedStruct("NotFound", { path: Schema.String }),
  InvalidDeadline: Schema.TaggedStruct("InvalidDeadline", {
    deadlineMillis: Schema.Finite,
    maximum: Schema.Finite,
  }),
  RootNotFound: Schema.TaggedStruct("RootNotFound", {
    selector: Schema.String,
    attached: Schema.Int,
  }),
  AmbiguousRoot: Schema.TaggedStruct("AmbiguousRoot", {
    selector: Schema.String,
    candidates: Schema.Array(RootInfo),
  }),
  RootDisconnected: Schema.TaggedStruct("RootDisconnected", {
    root: Schema.String,
    incarnation: Schema.Int,
  }),
  RootProtocolError: Schema.TaggedStruct("RootProtocolError", {
    root: Schema.String,
    incarnation: Schema.Int,
    detail: Schema.String,
  }),
  DeadlineExceeded: Schema.TaggedStruct("DeadlineExceeded", {
    root: Schema.String,
    deadlineMillis: Schema.Int,
  }),
  SnapshotTooLarge,
  TooManyRoots: Schema.TaggedStruct("TooManyRoots", { limit: Schema.Int }),
};

export const GatewayError = Schema.Union(Object.values(errors));
export type GatewayError = Schema.Schema.Type<typeof GatewayError>;

export const RootsResponse = Schema.TaggedStruct("Roots", {
  version: Schema.Literal(PROTOCOL_VERSION),
  roots: Schema.Array(RootInfo),
});
export type RootsResponse = Schema.Schema.Type<typeof RootsResponse>;

export const InspectResponse = Schema.TaggedStruct("Inspection", {
  version: Schema.Literal(PROTOCOL_VERSION),
  root: RootInfo,
  snapshot: Frame.Snapshot,
});
export type InspectResponse = Schema.Schema.Type<typeof InspectResponse>;

export const ErrorResponse = Schema.TaggedStruct("Error", {
  version: Schema.Literal(PROTOCOL_VERSION),
  error: GatewayError,
});
export type ErrorResponse = Schema.Schema.Type<typeof ErrorResponse>;

export const ReaderResponse = Schema.Union([RootsResponse, InspectResponse, ErrorResponse]);
export type ReaderResponse = Schema.Schema.Type<typeof ReaderResponse>;

/** The HTTP status for each reader error. */
export const statusOf = (error: GatewayError): number => {
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
