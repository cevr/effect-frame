import { Cause, Effect, Exit, Option, Scope } from "effect";
import type { Node } from "./jsx-runtime.js";

/**
 * PRIVATE proof (route-boundary slice 1). This module is not exported from
 * `effect-frame/view`. It exists so the owned-attempt contract can be proved
 * against the real runtime before any public `View.attempt` is chosen.
 * See `docs/design/owned-attempt.md`.
 *
 * `attempt(setup, fallback)` runs `setup` in one child Scope forked from the
 * caller's Scope. The caller's Scope is the owner: it is the Scope of the row,
 * branch, or mount whose setup yields the attempt.
 *
 * - Success keeps that child open. It closes when the owner closes.
 * - A typed failure closes the failed child, waiting for every finalizer,
 *   before `fallback` starts in a fresh child of the same owner.
 * - Defects and interruption bypass `fallback`. The failed child still closes.
 * - An owner that is already closed never starts setup or fallback, and a
 *   result that completes after the owner closed is refused by interruption,
 *   so late work cannot reach a host.
 *
 * Only `Scope` is replaced. Every other service, including `Clock`, stays the
 * caller's. There is no retry.
 */
export const attempt: <E, R, E2, R2>(
  setup: Effect.Effect<Node, E, R>,
  fallback: (error: E) => Effect.Effect<Node, E2, R2>,
) => Effect.Effect<Node, E2, R | R2 | Scope.Scope> = Effect.fn("View.attempt")(function* <
  E,
  R,
  E2,
  R2,
>(setup: Effect.Effect<Node, E, R>, fallback: (error: E) => Effect.Effect<Node, E2, R2>) {
  const first = yield* Effect.exit(owned(setup));
  if (Exit.isSuccess(first)) {
    return first.value;
  }
  const error = typedFailure(first.cause);
  if (Option.isNone(error)) {
    return yield* Effect.failCause(untyped(first.cause));
  }
  return yield* owned(fallback(error.value));
});

/**
 * The caller's Scope, refused when it has closed. `Scope.fork` of a closed
 * Scope returns a closed Scope rather than failing, so the check is explicit:
 * having a Scope value is not permission to start work under it.
 */
const openOwner: Effect.Effect<Scope.Scope, never, Scope.Scope> = Effect.flatMap(
  Effect.scope,
  (owner) => {
    if (owner.state._tag === "Closed") {
      return Effect.interrupt;
    }
    return Effect.succeed(owner);
  },
);

/**
 * Run one effect in a fresh child of the open owner. Any failure, defect, or
 * interruption closes that child with the same exit before the result is
 * observed. The close waits for held finalizers.
 */
const owned = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, Scope.Scope> | Scope.Scope> =>
  Effect.flatMap(openOwner, (owner) =>
    Effect.flatMap(Scope.fork(owner), (child) =>
      Effect.onExit(Scope.provide(effect, child), (exit) =>
        Exit.match(exit, {
          onSuccess: () => Effect.void,
          onFailure: () => Scope.close(child, exit),
        }),
      ).pipe(Effect.tap(() => openOwner)),
    ),
  );

/** The typed error, only when the cause holds no defect and no interruption. */
const typedFailure = <E>(cause: Cause.Cause<E>): Option.Option<E> => {
  if (Cause.hasDies(cause) || Cause.hasInterrupts(cause)) {
    return Option.none();
  }
  return Cause.findErrorOption(cause);
};

/**
 * A bypassed cause keeps its defects and interruptions. A typed failure mixed
 * into it becomes a defect, so setup's `E` never enters fallback's `E2`.
 */
const untyped = <E>(cause: Cause.Cause<E>): Cause.Cause<never> =>
  cause.reasons.reduce<Cause.Cause<never>>((all, reason) => {
    if (Cause.isFailReason(reason)) {
      return Cause.combine(all, Cause.die(reason.error));
    }
    return Cause.combine(all, Cause.fromReasons([reason]));
  }, Cause.empty);
