import type { Scope } from "effect";
import { Effect } from "effect";
import { modify, spawn } from "./actor.js";
import { Value, value } from "./behavior.js";
import type { Source } from "./source.js";
import type { ActorStopped, Applied } from "./vocabulary.js";

/**
 * A local value with a source, a setter and an updater: the shape a view's
 * private state takes. It is a `Behavior.value` actor underneath, so writes
 * apply in admission order and `update` reads the current value inside the
 * actor's turn, never beside another write.
 *
 * A write to a cell whose scope has closed does nothing. The cell belongs
 * to a view, and a view that is gone has no one left to show the value to;
 * a failure there would only reach an event handler that cannot return it.
 */
export interface Cell<A> {
  readonly state: Source<A>;
  readonly get: Effect.Effect<A>;
  readonly set: (value: A) => Effect.Effect<void>;
  readonly update: (update: (value: A) => A) => Effect.Effect<void>;
}

const quiet = <A>(write: Effect.Effect<Applied<A>, ActorStopped>): Effect.Effect<void> =>
  Effect.asVoid(Effect.catchTag(write, "ActorStopped", () => Effect.void));

/** Make a cell in the current scope. Closing the scope ends it. */
export const make = <A>(initial: A): Effect.Effect<Cell<A>, never, Scope.Scope> =>
  Effect.map(spawn(value(initial)), (ref) => ({
    state: ref.state,
    get: ref.state.get,
    set: (next) => quiet(ref.derive(() => Value.Set(next))),
    update: (update) => quiet(modify(ref, update)),
  }));
