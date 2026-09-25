import { Effect, Schema } from "effect";
import {
  InvalidQueryArgs,
  PolicyMissing,
  QueryFailed,
  QueryVersionMismatch,
  StreamEnded,
  UnknownQuery,
} from "../query.js";
import {
  ActorStopped,
  CommandConflict,
  CommandId,
  ContractMismatch,
  Refused,
  Unauthorized,
  Uncertain,
  UnknownContract,
  Unreachable,
} from "../vocabulary.js";

/**
 * The HTTP shape of the actor transport. Both sides import this module and
 * nothing else from the other side. Every body is JSON; `changes` is a
 * server-sent event stream with one `data:` line per revision.
 *
 *   POST {base}/send      SendBody     -> WireReceipt | WireError
 *   POST {base}/call      CallBody     -> WireProjection | WireError
 *   POST {base}/snapshot  AddressBody  -> WireProjection | WireError
 *   GET  {base}/changes?contract&version&key&after -> text/event-stream
 *
 * The Query primitive adds the query verbs and the single-flight field:
 *
 *   POST {base}/query     QueryBody    -> WireQueryValue | WireQueryError
 *   POST {base}/query/batch QueryBatchBody -> WireQueryBatch | WireQueryError
 *   POST {base}/send      SendBody   + active[] -> WireReceipt    + refreshed[]
 *   POST {base}/call      CallBody   + active[] -> WireProjection + refreshed[]
 *
 * `active` and `refreshed` are additive: a client that sends no `active`
 * gets an empty `refreshed` and the old behavior exactly.
 *
 * Plain-form posts add one route whose client is the browser:
 *
 *   POST {base}/form  application/x-www-form-urlencoded -> 303 | 200 page | 4xx
 */
export const WireAddress = Schema.Struct({
  contract: Schema.String,
  version: Schema.Finite,
  key: Schema.String,
});

export const AddressBody = Schema.Struct({ address: WireAddress });

/**
 * One cache entry the client is showing right now. The client sends these
 * with a command so the reply can carry their refreshed values. It is not
 * a subscription: the list is the client's cache, read at command time.
 */
export const WireQueryKey = Schema.Struct({
  query: Schema.String,
  version: Schema.Finite,
  args: Schema.String,
});

export const QueryBody = Schema.Struct({ key: WireQueryKey });

/** One request may carry keys from several contracts; the host groups valid keys by implementation. */
export const QueryBatchBody = Schema.Struct({ keys: Schema.Array(WireQueryKey) });

/** One query result as the wire carries it: the key it answers and the encoded value. */
export const WireQueryValue = Schema.Struct({
  key: WireQueryKey,
  result: Schema.String,
});

export const WireQueryError = Schema.Union([
  UnknownQuery,
  QueryVersionMismatch,
  PolicyMissing,
  InvalidQueryArgs,
  QueryFailed,
  Unauthorized,
  Unreachable,
  // Client-written. A host never sends it; the union matches `QueryFailure`.
  StreamEnded,
]);
export type WireQueryError = Schema.Schema.Type<typeof WireQueryError>;

/**
 * A refreshed value in a command reply. A refresh that failed carries its
 * error instead of a value, so one bad query never fails the command that
 * already committed.
 */
export const WireRefreshed = Schema.Union([
  Schema.TaggedStruct("Refreshed", { key: WireQueryKey, result: Schema.String }),
  Schema.TaggedStruct("RefreshFailed", { key: WireQueryKey, error: WireQueryError }),
]);
export type WireRefreshed = Schema.Schema.Type<typeof WireRefreshed>;

/** One aligned result per input key. Failures stay attached to their key. */
export const WireQueryBatch = Schema.Array(WireRefreshed);
export type WireQueryBatch = Schema.Schema.Type<typeof WireQueryBatch>;

/**
 * `active` is optional on the wire and defaults to empty. A client built
 * before the Query primitive keeps working unchanged, and a plain form post
 * can omit it too.
 */
const activeKeys = Schema.Array(WireQueryKey).pipe(
  Schema.withDecodingDefaultKey(Effect.succeed([])),
);

const refreshedValues = Schema.Array(WireRefreshed).pipe(
  Schema.withDecodingDefaultKey(Effect.succeed([])),
);

export const SendBody = Schema.Struct({
  address: WireAddress,
  commandId: CommandId,
  payload: Schema.String,
  active: activeKeys,
});

export const CallBody = Schema.Struct({
  address: WireAddress,
  commandId: CommandId,
  payload: Schema.String,
  timeoutMillis: Schema.Finite,
  active: activeKeys,
});

export const WireReceipt = Schema.Struct({
  commandId: CommandId,
  admitted: Schema.Finite,
  committed: Schema.OptionFromNullOr(Schema.Finite),
  refreshed: refreshedValues,
});

export const WireProjection = Schema.Struct({
  revision: Schema.Finite,
  snapshot: Schema.String,
});

/** A `call` reply: the projection the command produced, plus its refreshes. */
export const WireApplied = Schema.Struct({
  revision: Schema.Finite,
  snapshot: Schema.String,
  refreshed: refreshedValues,
});

export const WireError = Schema.Union([
  ActorStopped,
  CommandConflict,
  Refused,
  Uncertain,
  Unauthorized,
  ContractMismatch,
  UnknownContract,
  Unreachable,
]);
export type WireError = Schema.Schema.Type<typeof WireError>;

/** What each verb may fail with. A server that returns anything else broke the protocol. */
export const SendWireError = Schema.Union([
  ActorStopped,
  CommandConflict,
  Refused,
  Unauthorized,
  ContractMismatch,
  UnknownContract,
  Unreachable,
]);
export const CallWireError = Schema.Union([
  ActorStopped,
  CommandConflict,
  Refused,
  Uncertain,
  Unauthorized,
  ContractMismatch,
  UnknownContract,
  Unreachable,
]);
export const ReadWireError = Schema.Union([
  ActorStopped,
  Unauthorized,
  ContractMismatch,
  UnknownContract,
  Unreachable,
]);

export const statusOf = (error: WireError): number => {
  switch (error._tag) {
    case "Unauthorized":
      return 403;
    case "UnknownContract":
      return 404;
    case "CommandConflict":
    case "ContractMismatch":
      return 409;
    // The behavior read the message and will never apply it: a typed,
    // conclusive answer the client decodes, never a 5xx it would retry.
    case "Refused":
      return 422;
    case "Uncertain":
      return 504;
    case "ActorStopped":
      return 503;
    case "Unreachable":
      return 502;
  }
};

export const queryStatusOf = (error: WireQueryError): number => {
  switch (error._tag) {
    case "Unauthorized":
    case "PolicyMissing":
      return 403;
    case "UnknownQuery":
      return 404;
    case "InvalidQueryArgs":
      return 400;
    case "QueryVersionMismatch":
      return 409;
    // Not 500: the client turns an unexpected 5xx into `Unreachable`, and a
    // handler failure is a typed answer the caller must be able to decode.
    case "QueryFailed":
      return 422;
    case "Unreachable":
    case "StreamEnded":
      return 502;
  }
};

export const paths = {
  send: "/send",
  call: "/call",
  snapshot: "/snapshot",
  changes: "/changes",
  query: "/query",
  queryBatch: "/query/batch",
  form: "/form",
} satisfies Record<string, string>;

export const eventPrefix = "data: ";

/** The line that names a stream's terminal error event. Its `data:` line is a `WireError`. */
export const errorEvent = "event: error";
