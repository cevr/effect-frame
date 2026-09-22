import { Effect, Function } from "effect";
import type { Behavior, SetValue } from "./behavior.js";
import { Value } from "./behavior.js";
import { openLocal } from "./local-engine.js";
import type { ActorRef, ActorStopped, Applied } from "./vocabulary.js";

/**
 * A local reference adds `derive`: compute the message from the current state
 * inside the actor's turn, so read and send cannot interleave with another
 * message.
 */
export interface LocalActorRef<State, Message> extends ActorRef<State, Message, "local"> {
  readonly derive: (
    derive: (state: State) => Message,
  ) => Effect.Effect<Applied<State>, ActorStopped>;
}

/**
 * Spawn a local actor in the current scope. Messages run in admission order.
 * Closing the scope stops the actor; every waiting `call` fails with
 * `ActorStopped`.
 */
export const spawn = Effect.fn("Actor.spawn")(function* <State, Message, R>(
  behavior: Behavior<State, Message, R>,
) {
  return yield* openLocal(behavior);
});

/**
 * Update simple state from its current value inside one turn. Only a local
 * reference to a `Behavior.value` actor has this. The message that reaches the
 * behavior is still a plain `Set`.
 */
export const modify: {
  <A>(
    update: (value: A) => A,
  ): (ref: LocalActorRef<A, SetValue<A>>) => Effect.Effect<Applied<A>, ActorStopped>;
  <A>(
    ref: LocalActorRef<A, SetValue<A>>,
    update: (value: A) => A,
  ): Effect.Effect<Applied<A>, ActorStopped>;
} = Function.dual(
  2,
  <A>(
    ref: LocalActorRef<A, SetValue<A>>,
    update: (value: A) => A,
  ): Effect.Effect<Applied<A>, ActorStopped> => ref.derive((value) => Value.Set(update(value))),
);
