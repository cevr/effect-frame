/**
 * The browser-safe entry. Everything here may ship to a client: contracts,
 * vocabulary, local actors and behaviors, remote references, and the
 * transport service interface. Nothing here imports a store or a host.
 * `tests/boundary.test.ts` builds this file and checks that promise.
 */
export * as Behavior from "./behavior.js";
export { Value } from "./behavior.js";
export type { SetValue, Turn } from "./behavior.js";
export { modify, spawn, type LocalActorRef } from "./actor.js";
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
export {
  commandRef,
  ref,
  type RefOptions,
  type RemoteActorRef,
  type RemoteCommandRef,
} from "./ref.js";
// The Query primitive's client half (#17, #28).
export {
  Failed,
  InvalidQueryArgs,
  Loading,
  PolicyMissing,
  QueryFailed,
  QueryFailure,
  QueryState,
  QueryVersionMismatch,
  Ready,
  StreamEnded,
  UnknownQuery,
  canonicalize,
  isFailed,
  isLoading,
  isQueryFailure,
  isReady,
  keyOf,
  markStale,
  match,
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
// Streamed documents: the record channel and the cache's resume (#22).
export * as Streaming from "./streaming.js";
export {
  QueryCache,
  followQuery,
  useQuery,
  layer as queryCacheLayer,
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
export * as Wire from "./http/wire.js";
export {
  Source,
  all,
  debounce,
  mapEffect,
  on,
  select,
  throttle,
  zip,
  type AllValues,
  type ValueOf,
} from "./source.js";
export * as Cell from "./cell.js";
// Plain-form posts (#21) and generated fields (#32).
export * as Form from "./form.js";
export * as Generated from "./generated.js";
export { FormContext, type FormFields, type FormIssue, type FormIssues } from "./form.js";
// Authorization (#20, #30): who is asking. The rules that judge a principal
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
