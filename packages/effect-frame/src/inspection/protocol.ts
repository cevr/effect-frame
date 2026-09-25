/**
 * The browser-safe inspection protocol, version 1. The browser attachment in
 * this subpath and the `@effect-frame/inspect` gateway and reader import it.
 * It has no platform imports.
 *
 * Two boundaries use it:
 *
 * - Root link: the browser dials the gateway with one WebSocket. The browser
 *   is the RPC server for `RootRpcs`; the gateway is the RPC client.
 * - Reader API: a reader calls the gateway over loopback HTTP with one
 *   versioned JSON request and one versioned JSON response.
 */
import * as Frame from "../frame.js";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";

/** The fixed strings of protocol version 1. */
export interface Wire {
  /** The protocol version every document and request carries. */
  readonly version: 1;
  /** The WebSocket subprotocol that carries the root-link protocol version. */
  readonly subprotocol: "effect-frame-inspection.v1";
  /** The WebSocket subprotocol prefix that carries the attach capability. */
  readonly attachTokenPrefix: "effect-frame-attach.";
  /** The reader API version header. */
  readonly versionHeader: "effect-frame-inspection-version";
  /** The root-link WebSocket path. */
  readonly attachPath: "/v1/attach";
  /** The reader path that lists roots. */
  readonly rootsPath: "/v1/roots";
  /** The reader path that inspects one root. */
  readonly inspectPath: "/v1/inspect";
}

export const wire: Wire = {
  version: 1,
  subprotocol: "effect-frame-inspection.v1",
  attachTokenPrefix: "effect-frame-attach.",
  versionHeader: "effect-frame-inspection-version",
  attachPath: "/v1/attach",
  rootsPath: "/v1/roots",
  inspectPath: "/v1/inspect",
};

/**
 * Code points a terminal or a log could act on: C0 controls, DEL, and C1
 * controls. Identity and selector strings never carry them.
 */
// oxlint-disable-next-line no-control-regex -- matching control characters is the point.
const NO_CONTROL = /^[^\u0000-\u001f\u007f-\u009f]*$/;

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
 *
 * @unstable This value is built with `effect/unstable/rpc`. Its type follows
 * that module and can change with an Effect release. The wire format is
 * versioned by `wire.version`, not by this type.
 */
export const Inspect = Rpc.make("Inspect", {
  payload: { maxBytes: Schema.Int },
  success: Frame.Snapshot,
  error: SnapshotTooLarge,
});

/**
 * The root-link RPC group: the gateway is its client, the browser root its
 * server.
 *
 * @unstable This value is built with `effect/unstable/rpc`. Its type follows
 * that module and can change with an Effect release.
 */
export const RootRpcs = RpcGroup.make(Inspect);

/** Root identities are Frame root IDs: printable, short, and URL-safe. */
export const RootId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._:-]{1,128}$/));

/** A root's display name: at most 128 characters and no control characters. */
export const RootName = Schema.String.check(Schema.isMaxLength(128), Schema.isPattern(NO_CONTROL));

/** A reader's root selector: an exact ID, a unique ID prefix, or an exact name. */
export const RootSelector = Schema.String.check(
  Schema.isLengthBetween(1, 256),
  Schema.isPattern(NO_CONTROL),
);

/**
 * The longest deadline a reader may ask for, in milliseconds. The gateway
 * and the reader quote it; `DeadlineMillis` is built from it.
 *
 * ```ts
 * const help = `--deadline <ms>  1..${Protocol.maxDeadlineMillis}`;
 * ```
 */
export const maxDeadlineMillis = 30_000;

/**
 * The host names that count as loopback. The attachment dials only these,
 * and the reader calls only these.
 *
 * ```ts
 * if (!Protocol.loopbackHosts.includes(url.hostname)) return yield* refuse(url);
 * ```
 */
export const loopbackHosts: ReadonlyArray<string> = ["127.0.0.1", "localhost"];

/** A reader deadline in milliseconds. It is always finite: 1 to `maxDeadlineMillis`. */
export const DeadlineMillis = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: maxDeadlineMillis }),
);

// ---------------------------------------------------------------------------
// Reader API
// ---------------------------------------------------------------------------

export const RootInfo = Schema.Struct({
  id: RootId,
  name: Schema.NullOr(RootName),
  /** A gateway-local counter. A reconnect of the same root gets a new one. */
  incarnation: Schema.Int,
  attachedAt: Schema.Finite,
});
export type RootInfo = Schema.Schema.Type<typeof RootInfo>;

export const InspectRequest = Schema.Struct({
  version: Schema.Literal(wire.version),
  root: RootSelector,
  deadlineMillis: DeadlineMillis,
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
  version: Schema.Literal(wire.version),
  roots: Schema.Array(RootInfo),
});
export type RootsResponse = Schema.Schema.Type<typeof RootsResponse>;

export const InspectResponse = Schema.TaggedStruct("Inspection", {
  version: Schema.Literal(wire.version),
  root: RootInfo,
  snapshot: Frame.Snapshot,
});
export type InspectResponse = Schema.Schema.Type<typeof InspectResponse>;

export const ErrorResponse = Schema.TaggedStruct("Error", {
  version: Schema.Literal(wire.version),
  error: GatewayError,
});
export type ErrorResponse = Schema.Schema.Type<typeof ErrorResponse>;

export const ReaderResponse = Schema.Union([RootsResponse, InspectResponse, ErrorResponse]);
export type ReaderResponse = Schema.Schema.Type<typeof ReaderResponse>;
