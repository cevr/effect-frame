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
  type ActorContract,
  type Address,
  type AnyContract,
  type ContractOptions,
  type KeyOf,
  type MessageOf,
  type Pure,
  type SnapshotOf,
} from "./contract.js";
export { ref, type RefOptions, type RemoteActorRef } from "./ref.js";
export {
  ActorTransport,
  type Projection,
  type TransportCallError,
  type TransportReadError,
  type TransportSendError,
  type TransportService,
} from "./transport.js";
export { select, type Source } from "./source.js";
