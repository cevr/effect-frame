/**
 * The browser-safe entry. Everything here may ship to a client: contracts,
 * vocabulary, local actors and behaviors, remote references, and the
 * transport service interface. Nothing here imports a store or a host.
 * `tests/boundary.test.ts` builds this file and checks that promise.
 */
export * as Behavior from "./behavior.js";
export { Value, type SetValue } from "./set-value.js";
export type { Turn } from "./behavior.js";
export { modify, type LocalActorRef, type LocalValueRef } from "./actor.js";
export { Actor } from "./placement.js";
export * from "./vocabulary.js";
export {
  contract,
  resumeCodec,
  type ActorContract,
  type Address,
  type AnyContract,
  type ContractOptions,
  type KeyOf,
  type MessageOf,
  type Pure,
  type SnapshotOf,
} from "./contract.js";
export { type RefOptions, type RemoteActorRef, type RemoteCommandRef } from "./ref.js";
// The Query primitive's client half.
export {
  InvalidQueryArgs,
  PolicyMissing,
  QueryFailed,
  QueryFailure,
  QueryState,
  QueryVersionMismatch,
  StreamEnded,
  UnknownQuery,
  batchedQuery,
  keyOf,
  query,
  type AnyQuery,
  type ArgsOf,
  type BatchedQuery,
  type QueryContract,
  type QueryFailedState,
  type QueryKey,
  type QueryLoading,
  type QueryOptions,
  type QueryMode,
  type SingleQuery,
  type QueryReady,
  type QueryStateCases,
  type ResultOf,
} from "./query.js";
// Streamed documents: the record channel and the cache's resume.
export * as Streaming from "./streaming-api.js";
export {
  QueryCache,
  followQuery,
  runQuery,
  type FollowedQuery,
  type QueryCacheService,
  type QueryEntry,
} from "./query-client.js";
export {
  ActorTransport,
  type Projection,
  type ProjectionWithRefresh,
  type ReceiptWithRefresh,
  type Refreshed,
  type TransportCallError,
  type TransportQueryError,
  type TransportReadError,
  type TransportSendError,
  type TransportService,
} from "./transport.js";
export * as HttpTransport from "./http/client.js";
// One path per combinator: `Source.select`, `Source.zip`, and the rest.
export { Source, type AllValues, type ValueOf } from "./source.js";
// Plain-form posts and generated fields.
export * as Form from "./form-api.js";
export * as Generated from "./generated-api.js";
// Authorization: who is asking. The rules that judge a principal
// are server-only (`policy.ts`) and never reach this entry.
export {
  Anonymous,
  Authenticated,
  Claims,
  CurrentPrincipal,
  Principal,
  type PrincipalRevision,
  type PrincipalSource,
} from "./principal.js";
