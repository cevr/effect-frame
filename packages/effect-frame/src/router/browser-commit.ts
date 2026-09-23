import { Deferred, Effect, Exit, Option, Queue, Result, Stream } from "effect";
import type { Scope } from "effect";
import type { LocationService } from "./router.js";
import { browserLocation } from "./router.js";
import type { Traversal } from "./traversal.js";
import { register as registerTraversals } from "./traversal.js";

/**
 * PRIVATE (route slice 5). The browser `Location` with commit control over
 * Back and Forward. Not exported. See `docs/design/route-leave.md`.
 *
 * With the Navigation API, every interceptable, same-document traversal
 * that is not fragment-only reaches the router before it commits, as a
 * `Traversal`. The capability is read from each `navigate` event, never
 * from `window.navigation` alone:
 *
 * - `event.cancelable` and a precommit handler (`precommit`): the router
 *   answers asynchronously and `Stay` rejects the precommit handler, so the
 *   entry never commits.
 * - `event.cancelable` without a precommit handler (`cancel`): the event is
 *   canceled at once. `Leave` traverses to the same entry again, once, with
 *   a marker that this listener lets through. History never moved.
 * - Not cancelable (`none`): browser UI without history-action activation.
 *   The router is not asked; it follows and reports the unprotected path.
 *
 * An intercepted traversal keeps focus where it is (`focusReset: "manual"`)
 * and lets the browser restore scroll when the router has installed the
 * shell: the handler's promise waits for the router's `finish`.
 *
 * Without the Navigation API this is `browserLocation`: `popstate` after
 * commit, followed and reported by the router. There is no `history.go`
 * compensation and no `beforeunload` substitute.
 */

/** Whether to use a precommit handler when the browser has one. */
export type Precommit = "detect" | "off";

/** One traversal the listener handed to the router. */
interface Held {
  readonly key: string;
  /** True: the router lets it commit. */
  readonly answer: Deferred.Deferred<boolean>;
  /** True once committed; false when the platform abandoned it first. */
  readonly committed: Deferred.Deferred<boolean>;
  readonly abandoned: Deferred.Deferred<void>;
  readonly finished: Deferred.Deferred<void>;
}

/** Marks the one traversal this adapter re-issues after a canceled event. */
const resumed = { _tag: "effect-frame/router/resumed-traversal" };

const settle = <A>(deferred: Deferred.Deferred<A>, value: A): void => {
  Deferred.doneUnsafe(deferred, Exit.succeed(value));
};

const makeHeld = (key: string): Held => ({
  key,
  answer: Deferred.makeUnsafe<boolean>(),
  committed: Deferred.makeUnsafe<boolean>(),
  abandoned: Deferred.makeUnsafe<void>(),
  finished: Deferred.makeUnsafe<void>(),
});

/** Resolve at commit, then wait until the router is done: scroll restores after. */
const handlerOf = (held: Held) => () => {
  settle(held.committed, true);
  return Effect.runPromise(Deferred.await(held.finished));
};

/** Wait for the router's answer. `Stay` rejects, so the entry never commits. */
const precommitOf = (held: Held) => () =>
  Effect.runPromise(
    Effect.flatMap(Deferred.await(held.answer), (leave) => {
      if (leave) {
        return Effect.void;
      }
      return Effect.fail("stay");
    }),
  );

const hasNavigationApi = (): boolean => "navigation" in window;

/**
 * The browser Location. `precommit: "off"` ignores a precommit handler the
 * browser has, so a proof can drive the `cancel` path on such a browser.
 */
export const browserCommit = Effect.fn("Router.browserCommit")(function* (
  precommit: Precommit,
): Effect.fn.Return<LocationService, never, Scope.Scope> {
  if (!hasNavigationApi()) {
    return browserLocation;
  }
  const navigation = window.navigation;
  const precommitSupported = precommit === "detect" && "NavigationPrecommitController" in window;
  const traversals = yield* Queue.unbounded<Traversal>();
  const outstanding = new Set<Held>();
  /** Entries whose traversal the router already has: their popstate is dropped. */
  const claimed = new Set<string>();
  /** Canceled traversals the router let leave, by entry key. */
  const reissued = new Map<string, Held>();

  const finish = (held: Held) =>
    Effect.sync(() => {
      // Only a check may refuse: an unanswered traversal is let through.
      settle(held.answer, true);
      settle(held.finished, void 0);
      outstanding.delete(held);
    });

  const reissue = (held: Held) =>
    Effect.gen(function* () {
      settle(held.answer, true);
      reissued.set(held.key, held);
      const started = Result.try(() => navigation.traverseTo(held.key, { info: resumed }));
      if (Result.isFailure(started)) {
        reissued.delete(held.key);
        settle(held.committed, false);
      } else {
        // A rejected commit (the entry is gone) means it will never commit.
        yield* Option.match(Option.fromNullishOr(started.success.committed), {
          onNone: () => Effect.void,
          onSome: (committed) =>
            Effect.asVoid(
              Effect.forkDetach(
                Effect.catch(
                  Effect.tryPromise(() => committed),
                  () =>
                    Effect.sync(() => {
                      reissued.delete(held.key);
                      settle(held.committed, false);
                    }),
                ),
              ),
            ),
        });
      }
      return yield* Deferred.await(held.committed);
    });

  const traversalOf = (
    held: Held,
    destination: URL,
    protection: Traversal["protection"],
  ): Traversal => {
    let leave = Effect.andThen(
      Effect.sync(() => settle(held.answer, true)),
      Deferred.await(held.committed),
    );
    if (protection === "cancel") {
      leave = reissue(held);
    }
    return {
      destination,
      protection,
      stay: Effect.sync(() => settle(held.answer, false)),
      leave,
      abandoned: Deferred.await(held.abandoned),
      finish: finish(held),
    };
  };

  /** The platform gave the traversal up: it will not commit now. */
  const abandonOn = (event: NavigateEvent, held: Held) => {
    event.signal.addEventListener("abort", () => {
      claimed.delete(held.key);
      settle(held.abandoned, void 0);
      settle(held.committed, false);
    });
  };

  const listener = (event: NavigateEvent) => {
    if (event.navigationType !== "traverse" || !event.canIntercept || event.hashChange) {
      return;
    }
    const key = event.destination.key;
    const again = Option.filter(
      Option.fromNullishOr(reissued.get(key)),
      () => event.info === resumed,
    );
    if (Option.isSome(again)) {
      // The traversal the router already let leave: commit it, then wait.
      reissued.delete(key);
      claimed.add(key);
      event.intercept({ focusReset: "manual", handler: handlerOf(again.value) });
      abandonOn(event, again.value);
      return;
    }
    const held = makeHeld(key);
    let protection: Traversal["protection"] = "none";
    if (event.cancelable && precommitSupported) {
      protection = "precommit";
    } else if (event.cancelable) {
      protection = "cancel";
    }
    if (protection === "cancel") {
      event.preventDefault();
    } else {
      claimed.add(key);
      const options: NavigationInterceptOptions = {
        focusReset: "manual",
        handler: handlerOf(held),
      };
      if (protection === "precommit") {
        options.precommitHandler = precommitOf(held);
      }
      event.intercept(options);
      abandonOn(event, held);
    }
    outstanding.add(held);
    Queue.offerUnsafe(traversals, traversalOf(held, new URL(event.destination.url), protection));
  };

  yield* Effect.acquireRelease(
    Effect.sync(() => {
      navigation.addEventListener("navigate", listener);
    }),
    () =>
      Effect.sync(() => {
        navigation.removeEventListener("navigate", listener);
        // Root close is cleanup: nothing held may keep the platform waiting.
        for (const held of outstanding) {
          settle(held.answer, true);
          settle(held.finished, void 0);
        }
        outstanding.clear();
      }),
  );

  const service: LocationService = {
    ...browserLocation,
    pops: Stream.filterMap(
      Stream.fromEventListener(window, "popstate"),
      (): Result.Result<URL, void> => {
        const key = Option.getOrElse(
          Option.map(Option.fromNullishOr(navigation.currentEntry), (entry) => entry.key),
          () => "",
        );
        if (claimed.delete(key)) {
          return Result.fail(void 0);
        }
        return Result.succeed(new URL(window.location.href));
      },
    ),
  };
  registerTraversals(service, Stream.fromQueue(traversals));
  return service;
});
