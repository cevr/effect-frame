import type { Duration, Effect, Stream } from "effect";
import { Context } from "effect";
import type { Address } from "./contract.js";
import type {
  ActorStopped,
  CommandConflict,
  CommandId,
  DurableReceipt,
  RemoteFailure,
  Uncertain,
} from "./vocabulary.js";

/** One committed revision with the encoded snapshot it produced. */
export interface Projection {
  readonly revision: number;
  readonly snapshot: string;
}

export type TransportSendError = ActorStopped | CommandConflict | RemoteFailure;
export type TransportCallError = TransportSendError | Uncertain;
export type TransportReadError = ActorStopped | RemoteFailure;

/**
 * The wire between a remote reference and the process that hosts the actor.
 * Every payload is an encoded string; the contract owns the codecs. The
 * client side of this service is safe for a browser. A host provides it.
 */
export interface TransportService {
  readonly send: (
    address: Address,
    commandId: CommandId,
    payload: string,
  ) => Effect.Effect<DurableReceipt, TransportSendError>;
  readonly call: (
    address: Address,
    commandId: CommandId,
    payload: string,
    timeout: Duration.Input,
  ) => Effect.Effect<Projection, TransportCallError>;
  readonly snapshot: (address: Address) => Effect.Effect<Projection, TransportReadError>;
  /**
   * Every revision after `after`, in order, starting with the latest one if
   * it is newer than `after`. A client resumes with the revision it holds.
   */
  readonly changes: (
    address: Address,
    after: number,
  ) => Stream.Stream<Projection, TransportReadError>;
}

export class ActorTransport extends Context.Service<ActorTransport, TransportService>()(
  "@effect-frame/actor/src/transport/ActorTransport",
) {}
