import { Effect, Predicate } from "effect";
import type { CommandAdapter } from "./command-owner.js";
import { lost, ownNothing, refused } from "./command-owner.js";
import type { Address } from "./contract.js";
import type { Committed } from "./engine-types.js";
import type { Projection, TransportCallError, TransportService } from "./transport.js";
import type {
  CommandId,
  ContractMismatch,
  Refused,
  Unauthorized,
  UnknownContract,
} from "./vocabulary.js";
import { ActorStopped, CommandConflict } from "./vocabulary.js";

/** Refusals a remote host can give one submission. `Unreachable` is not one. */
export type RemoteRejection =
  | ActorStopped
  | CommandConflict
  | Refused
  | Unauthorized
  | ContractMismatch
  | UnknownContract;

/** A lost reply or an expired server wait: the request may have been admitted. */
const isLostReply = Predicate.or(
  Predicate.isTagged("Uncertain"),
  Predicate.isTagged("Unreachable"),
);

const classify = (failure: TransportCallError) => {
  if (isLostReply(failure)) {
    return lost;
  }
  return refused<RemoteRejection>(failure);
};

/**
 * The transport as a command adapter. A healthy pass is one send, which
 * supplies admission order and carries no query keys, and one same-ID call,
 * which supplies the exact stored public result and the captured refreshes.
 */
export const transportCommands = <State>(
  transport: TransportService,
  address: Address,
  decode: (projection: Projection) => Effect.Effect<Committed<State>>,
): CommandAdapter<State, RemoteRejection> => ({
  kind: "remote",
  own: ownNothing,
  closed: Effect.succeed(false),
  send: (commandId: CommandId, payload: string) =>
    transport.send(address, commandId, payload, []).pipe(
      Effect.map((reply) => ({ admitted: reply.receipt.admitted })),
      Effect.mapError(classify),
    ),
  call: (commandId, payload, deadline, active) =>
    transport.call(address, commandId, payload, deadline, active).pipe(
      Effect.mapError(classify),
      Effect.flatMap((reply) =>
        Effect.map(decode(reply.projection), (committed) => ({
          committed,
          refreshed: reply.refreshed,
        })),
      ),
    ),
  stopped: () => ActorStopped.make(),
  conflict: (commandId) => CommandConflict.make({ commandId }),
});
