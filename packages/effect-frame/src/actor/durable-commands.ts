import { Effect } from "effect";
import type { CommandAdapter } from "./command-owner.js";
import { lost, ownNothing, refused } from "./command-owner.js";
import type { DurableAdmissionError, DurableEngine } from "./durable-engine.js";
import type { CommandId, Refused } from "./vocabulary.js";
import { ActorStopped, CommandConflict } from "./vocabulary.js";

/** Refusals a durable engine can give one submission. */
export type DurableRejection<Refusal extends Refused = never> = DurableAdmissionError<Refusal>;

/**
 * The durable engine as a command adapter. A pass admits the retained bytes
 * and then waits for their exact stored receipt. No encoder runs here.
 */
export const durableCommands = <State, Refusal extends Refused = never>(
  engine: DurableEngine<State, Refusal>,
): CommandAdapter<State, DurableRejection<Refusal>> => ({
  kind: "durable",
  own: ownNothing,
  closed: engine.isClosed,
  send: (commandId: CommandId, payload: string) =>
    Effect.mapError(engine.sendEncoded(commandId, payload), refused),
  call: (commandId, payload, deadline) =>
    engine.callEncoded(commandId, payload, deadline).pipe(
      Effect.map((committed) => ({ committed, refreshed: [] })),
      Effect.mapError((failure) => {
        if (failure._tag === "Uncertain") {
          return lost;
        }
        return refused(failure);
      }),
    ),
  stopped: () => ActorStopped.make(),
  conflict: (commandId) => CommandConflict.make({ commandId }),
});
