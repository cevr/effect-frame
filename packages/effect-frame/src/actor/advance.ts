import { Effect, Equal, Option, Stream, SubscriptionRef } from "effect";

/**
 * Internal: no entry exports it. One state of a stateful derivation: a
 * value it carries forward, such as the last value `followQuery` shows or
 * the last value `ready` holds.
 *
 * The state moves in one place only: `advance`. It reads the upstream now,
 * under the ref's lock, and publishes the result only when it is not
 * `Equal` to the state. `get` advances and reads; each upstream delivery
 * only asks for an advance, and never applies the value it carried. So:
 *
 * - `get` never runs ahead of `changes`: a value `get` returns was
 *   published, in order, before `get` returned it.
 * - A delivery that arrives late reads the upstream again, so an older
 *   value never undoes a newer one that was shown.
 * - An equal value is never published twice.
 */
export const advance = <S, E, R>(
  ref: SubscriptionRef.SubscriptionRef<S>,
  next: (state: S) => Effect.Effect<S, E, R>,
): Effect.Effect<S, E, R> =>
  SubscriptionRef.updateSomeAndGetEffect(ref, (state) =>
    Effect.map(next(state), (moved) =>
      Option.liftPredicate(moved, (candidate) => !Equal.equals(candidate, state)),
    ),
  );

/** The ref's changes, advanced first: the first element is the state `get` gives now. */
export const advancedChanges = <S, E, R>(
  ref: SubscriptionRef.SubscriptionRef<S>,
  next: (state: S) => Effect.Effect<S, E, R>,
): Stream.Stream<S, E, R> =>
  Stream.unwrap(Effect.as(advance(ref, next), SubscriptionRef.changes(ref)));

/**
 * The ref's changes while this consumer follows `upstream`: each upstream
 * delivery asks for an advance, and the stream emits the ref's states.
 * The follow lives as long as the consumer, so no Scope outlives it.
 */
export const followedChanges = <S, U, E, R>(
  ref: SubscriptionRef.SubscriptionRef<S>,
  next: (state: S) => Effect.Effect<S, E, R>,
  upstream: Stream.Stream<U, E, R>,
): Stream.Stream<S, E, R> =>
  Stream.merge(
    advancedChanges(ref, next),
    Stream.drain(Stream.mapEffect(upstream, () => advance(ref, next))),
  );
