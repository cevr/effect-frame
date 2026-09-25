import { Effect, Queue, Schema, Stream } from "effect";
import type { Scope } from "effect";
import type { Landing } from "./landing.js";

/**
 * PRIVATE. A platform traversal (Back or Forward) that the
 * router sees before the platform commits it. A `Location` may carry a
 * source of them beside its `pops`, in its capabilities (`landing.ts`),
 * whose key is not public. See `docs/design/route-leave.md`.
 *
 * `pops` stays the committed path: a URL the platform already moved to. A
 * traversal is the earlier path. Its `protection` says what the platform
 * allows before commit:
 *
 * - `precommit`: a cancelable `navigate` event with a precommit handler.
 *   The router answers asynchronously; `Stay` rejects the handler and the
 *   entry never commits.
 * - `cancel`: a cancelable `navigate` event without a precommit handler.
 *   The adapter cancels it at once. `Leave` traverses to the same entry
 *   again, once; `Stay` does nothing more. History never moved.
 * - `none`: the platform will commit whatever the router answers. The
 *   router does not ask a leave check, and reports the unprotected path.
 */
export interface Traversal {
  readonly destination: URL;
  readonly protection: "precommit" | "cancel" | "none";
  /** Refuse. Only for `precommit` and `cancel`: the entry does not commit. */
  readonly stay: Effect.Effect<void>;
  /**
   * Let the platform commit. True once it committed; false when the
   * platform abandoned the traversal first.
   */
  readonly leave: Effect.Effect<boolean>;
  /** Completes when the platform abandoned the traversal before an answer. */
  readonly abandoned: Effect.Effect<void>;
  /**
   * Place the viewport and focus for the committed shell (#31), before
   * `finish`. The router calls it once, only after it showed the entry.
   */
  readonly land: (landing: Landing) => Effect.Effect<void>;
  /**
   * The router is done with it: the shell is installed, or nothing moved.
   * An unanswered traversal is let through: only a check, or a router
   * failure (which answers `stay` first), may refuse. The platform's scroll
   * restoration waits for this. It is idempotent.
   */
  readonly finish: Effect.Effect<void>;
}

/** A second router tried to consume the traversals of one `Location`. */
export class TraversalConsumerTaken extends Schema.TaggedError<TraversalConsumerTaken>()(
  "TraversalConsumerTaken",
  {},
) {}

/**
 * The traversals of one `Location`, for exactly one consumer at a time.
 * A traversal is held only while a consumer is active: without one, a
 * producer must not hold the platform (`active` is false), and an offered
 * traversal is let through at once. When the consumer's Scope closes, every
 * traversal it has not finished is let through, so the platform never
 * waits for a router that is gone.
 */
export interface TraversalSource {
  /** True while a router consumes. A producer holds nothing otherwise. */
  readonly active: () => boolean;
  /** Hand one traversal to the consumer, or let it through when there is none. */
  readonly offer: (traversal: Traversal) => Effect.Effect<void>;
  /** Become the one consumer for the caller's Scope. A second is a defect. */
  readonly consume: Effect.Effect<Stream.Stream<Traversal>, never, Scope.Scope>;
}

/** Make the source a `Location` registers. */
export const makeSource: Effect.Effect<TraversalSource> = Effect.gen(function* () {
  const queue = yield* Queue.unbounded<Traversal>();
  /** Offered and not yet finished. */
  const live = new Set<Traversal>();
  let consuming = false;

  const track = (traversal: Traversal): Traversal => {
    const held: Traversal = {
      ...traversal,
      finish: Effect.andThen(
        traversal.finish,
        Effect.sync(() => {
          live.delete(held);
        }),
      ),
    };
    return held;
  };

  const offer = (traversal: Traversal): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (!consuming) {
        return traversal.finish;
      }
      const held = track(traversal);
      live.add(held);
      Queue.offerUnsafe(queue, held);
      return Effect.void;
    });

  const consume = Effect.acquireRelease(
    Effect.suspend(() => {
      if (consuming) {
        return Effect.die(TraversalConsumerTaken.make({}));
      }
      consuming = true;
      return Effect.succeed(Stream.fromQueue(queue));
    }),
    () =>
      Effect.gen(function* () {
        consuming = false;
        yield* Queue.clear(queue);
        const left = Array.from(live);
        live.clear();
        yield* Effect.forEach(left, (traversal) => traversal.finish, { discard: true });
      }),
  );

  const source: TraversalSource = { active: () => consuming, offer, consume };
  return source;
});
