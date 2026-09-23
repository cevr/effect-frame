import type { Effect, Stream } from "effect";
import { Option } from "effect";
import type { LocationService } from "./router.js";

/**
 * PRIVATE (route slice 5). A platform traversal (Back or Forward) that the
 * router sees before the platform commits it. A `Location` may carry a
 * stream of them beside its `pops`, through this registry, without a change
 * to the public `LocationService`. See `docs/design/route-leave.md`.
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
   * The router is done with it: the shell is installed, or nothing moved.
   * An unanswered traversal is let through, since only a check may refuse.
   * The platform's scroll restoration waits for this.
   */
  readonly finish: Effect.Effect<void>;
}

const traversals = new WeakMap<LocationService, Stream.Stream<Traversal>>();

/** Attach a traversal stream to a location service. */
export const register = (location: LocationService, stream: Stream.Stream<Traversal>): void => {
  traversals.set(location, stream);
};

/** The traversals a location reports before commit, if it can. */
export const read = (location: LocationService): Option.Option<Stream.Stream<Traversal>> =>
  Option.fromNullishOr(traversals.get(location));
