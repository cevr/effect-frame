import { Deferred, Effect, Exit, Option, Result, Stream } from "effect";
import type { Scope } from "effect";
import type { Landing, WriteKind, Written } from "./landing.js";
import { withCapabilities } from "./landing.js";
import {
  browserLocation,
  historyWritten,
  placeIntercepted,
  placePop,
  placeTraversal,
} from "./navigation.js";
import type { LocationService } from "./router.js";
import type { Traversal } from "./traversal.js";
import { makeSource } from "./traversal.js";

/**
 * The browser `Location` with commit control over Back and Forward
 * (`docs/design/route-leave.md`) and the Navigation API landing of
 * #31 (`docs/design/navigation-behavior.md`). Public as `browserNavigation`;
 * `browserCommit(precommit)` is the proof seam.
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
 *   a marker that this listener lets through. History never moved. Only on
 *   an engine that has precommit handlers (and `precommit: "off"` chose not
 *   to use them): WebKit with the Navigation API but no precommit handler
 *   moves its back-forward list on a canceled traversal while the document
 *   stays, so the re-issued traversal becomes a reload of the page. There a
 *   cancelable traversal is `none`.
 * - Not cancelable, or not safely cancelable (`none`): browser UI without
 *   history-action activation. The router is not asked; it follows and
 *   reports the unprotected path.
 *
 * A traversal is held only while a router consumes this Location's
 * traversals. Without one, the listener intercepts nothing: the platform
 * moves as it would without this adapter.
 *
 * `intercept` may throw. A key is claimed (its `popstate` dropped) only
 * after `intercept` succeeded. A failed precommit intercept falls back to
 * `cancel`; any other failure leaves the move to `popstate`, which the
 * router follows and reports.
 *
 * Scroll and focus (#31): every navigation this adapter intercepts uses
 * `scroll: "manual"` and `focusReset: "manual"`, because both are fixed at
 * dispatch, before the router knows the destination's behavior or whether
 * its leaf stays. At shell commit the router lands: under `Restore` the
 * event's own `scroll()` places the viewport (top, fragment, or the entry's
 * saved position) and focus moves to the entering leaf. The handler's
 * promise waits for the router's `finish` (a traversal) or its landing (the
 * router's own push or replace, which is intercepted too).
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
  /** The intercepted event, once the platform accepted the intercept. */
  event: Option.Option<NavigateEvent>;
}

/**
 * What one write of the router saw of its own `navigate` event:
 * - `Unseen`: none reached this listener. A reentrant write that another
 *   listener started first superseded it.
 * - `Lost`: it arrived already aborted by such a write.
 * - `Uncaught`: the platform refused the intercept.
 * - `Claimed`: intercepted, and held until this write lands.
 */
type Claim =
  | { readonly _tag: "Unseen" }
  | { readonly _tag: "Lost" }
  | { readonly _tag: "Uncaught" }
  | { readonly _tag: "Claimed"; readonly own: Own };

/** One write in progress: the event it dispatches is the only one it may claim. */
interface Frame {
  readonly kind: WriteKind;
  readonly href: string;
  claim: Claim;
}

/** One of the router's own writes, intercepted until that write lands. */
interface Own {
  readonly event: NavigateEvent;
  readonly landed: Deferred.Deferred<void>;
  /** True once the platform aborted it: a newer navigation replaced it. */
  aborted: boolean;
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
  event: Option.none(),
});

/** Resolve at commit, then wait until the router is done: scroll restores after. */
const handlerOf = (held: Held) => () => {
  settle(held.committed, true);
  return Effect.runPromise(Deferred.await(held.finished));
};

/** A write a reentrant write superseded: nothing waits on it, and it places nothing. */
const superseded: Written = { land: () => Effect.void };

/** The router's own move fulfills when it lands. */
const waitFor = (landed: Deferred.Deferred<void>) => () =>
  Effect.runPromise(Deferred.await(landed));

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
export const browserCommit = /* @__PURE__ */ Effect.fn("Router.browserCommit")(function* (
  precommit: Precommit,
): Effect.fn.Return<LocationService, never, Scope.Scope> {
  if (!hasNavigationApi()) {
    return browserLocation;
  }
  const navigation = window.navigation;
  const precommitEngine = "NavigationPrecommitController" in window;
  const precommitSupported = precommit === "detect" && precommitEngine;
  // Only an engine with precommit handlers keeps its history whole after a
  // canceled traversal (see the header).
  const cancelSafe = precommitEngine;
  const source = yield* makeSource;
  const context = yield* Effect.context<never>();
  const outstanding = new Set<Held>();
  /** Entries whose traversal the router already has: their popstate is dropped. */
  const claimed = new Set<string>();
  /** Canceled traversals the router let leave, by entry key. */
  const reissued = new Map<string, Held>();
  /** The router's write in progress, while its `pushState` or `replaceState` runs. */
  let frame = Option.none<Frame>();
  /** Own writes not landed yet: released at root close. */
  const owned = new Set<Own>();

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
      land: (landing: Landing) =>
        Effect.sync(() => {
          Option.map(held.event, (event) => placeTraversal(landing, event));
        }),
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

  /** Intercept, and claim the key only if the platform accepted it. */
  const intercepted = (
    event: NavigateEvent,
    held: Held,
    options: NavigationInterceptOptions,
  ): boolean => {
    const accepted = Result.try(() => event.intercept(options));
    if (Result.isFailure(accepted)) {
      return false;
    }
    held.event = Option.some(event);
    claimed.add(held.key);
    abandonOn(event, held);
    return true;
  };

  /** Release one own write: its handler fulfills. */
  const release = (own: Own) => {
    owned.delete(own);
    settle(own.landed, void 0);
  };

  /**
   * Whether `event` is the one the write in progress dispatched: the same
   * kind, the same destination, and that write has claimed nothing yet.
   * A nested write that another listener starts while ours runs has another
   * destination or comes after the claim, and is left to the platform.
   */
  const isOwn = (current: Frame, event: NavigateEvent): boolean =>
    current.claim._tag === "Unseen" &&
    current.kind === event.navigationType &&
    current.href === event.destination.url;

  /**
   * The router's own push or replace, dispatched synchronously by
   * `pushState` or `replaceState`. Intercepted so its scroll and focus wait
   * for its shell; the URL has already changed. Only the write that
   * dispatched it can land it.
   */
  const claimOwn = (current: Frame, event: NavigateEvent) => {
    if (event.signal.aborted) {
      current.claim = { _tag: "Lost" };
      return;
    }
    const landed = Deferred.makeUnsafe<void>();
    const accepted = Result.try(() =>
      event.intercept({
        scroll: "manual",
        focusReset: "manual",
        handler: waitFor(landed),
      }),
    );
    if (Result.isFailure(accepted)) {
      current.claim = { _tag: "Uncaught" };
      return;
    }
    const own: Own = { event, landed, aborted: false };
    owned.add(own);
    current.claim = { _tag: "Claimed", own };
    event.signal.addEventListener("abort", () => {
      own.aborted = true;
      release(own);
    });
  };

  const hold = (event: NavigateEvent, held: Held, protection: Traversal["protection"]) => {
    outstanding.add(held);
    Effect.runSyncWith(context)(
      source.offer(traversalOf(held, new URL(event.destination.url), protection)),
    );
  };

  const listener = (event: NavigateEvent) => {
    if (event.navigationType === "push" || event.navigationType === "replace") {
      Option.map(
        Option.filter(frame, (current) => isOwn(current, event)),
        (current) => claimOwn(current, event),
      );
      return;
    }
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
      const options: NavigationInterceptOptions = {
        scroll: "manual",
        focusReset: "manual",
        handler: handlerOf(again.value),
      };
      if (!intercepted(event, again.value, options)) {
        // It commits unintercepted: `popstate` follows it, and the router
        // stops waiting for this commit.
        settle(again.value.committed, false);
      }
      return;
    }
    if (!source.active()) {
      // No router consumes: hold nothing.
      return;
    }
    const held = makeHeld(key);
    const handler = handlerOf(held);
    if (event.cancelable && precommitSupported) {
      const options: NavigationInterceptOptions = {
        scroll: "manual",
        focusReset: "manual",
        handler,
        precommitHandler: precommitOf(held),
      };
      if (intercepted(event, held, options)) {
        hold(event, held, "precommit");
        return;
      }
    }
    if (event.cancelable && cancelSafe) {
      event.preventDefault();
      hold(event, held, "cancel");
      return;
    }
    if (intercepted(event, held, { scroll: "manual", focusReset: "manual", handler })) {
      hold(event, held, "none");
    }
    // Otherwise `popstate` carries the committed move.
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
        for (const own of owned) {
          settle(own.landed, void 0);
        }
        owned.clear();
      }),
  );

  /**
   * The handle a write gets for what it claimed. A superseded write places
   * nothing; a refused intercept lands as the History API would.
   */
  const writtenFor = (claim: Claim): Written => {
    if (claim._tag === "Claimed") {
      return writtenOf(claim.own);
    }
    if (claim._tag === "Uncaught") {
      return historyWritten;
    }
    return superseded;
  };

  /** Land one own write on its own event, once. An aborted write places nothing. */
  const writtenOf = (own: Own): Written => ({
    land: (landing) =>
      Effect.sync(() => {
        if (!own.aborted && owned.has(own)) {
          Option.map(landing, (placed) => placeIntercepted(placed, own.event));
        }
        release(own);
      }),
  });

  /**
   * Write history as the router's own move, so the listener intercepts it,
   * and hand back the handle of that write. When the platform did not let it
   * be intercepted, it lands as the History API would.
   */
  const write = (kind: WriteKind, url: URL) =>
    Effect.suspend(() => {
      const mine: Frame = { kind, href: url.href, claim: { _tag: "Unseen" } };
      const outer = frame;
      frame = Option.some(mine);
      const written = Result.try(() => {
        if (kind === "push") {
          window.history.pushState({}, "", url.href);
          return;
        }
        window.history.replaceState({}, "", url.href);
      });
      frame = outer;
      return Result.match(written, {
        onFailure: (cause) => Effect.die(cause),
        onSuccess: () => Effect.succeed(writtenFor(mine.claim)),
      });
    });

  /** A pop no handler held: the browser restored scroll, so focus only. */
  const pop = (landing: Option.Option<Landing>) =>
    Effect.sync(() => {
      Option.map(landing, placePop);
    });

  // A direct `push` or `replace` is not the router's: nothing would land
  // it, so it is not intercepted (`browserLocation`'s plain write).
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
  return withCapabilities(service, {
    surface: Option.some({ write, pop }),
    traversals: Option.some(source),
  });
});

/**
 * The browser `Location` (#31): the Navigation API where the browser has
 * it, the History API (`browserLocation`) where it does not. Its Scope owns
 * the `navigate` listener. Provide it as the router's `Location`.
 */
export const browserNavigation: Effect.Effect<LocationService, never, Scope.Scope> =
  /* @__PURE__ */ Effect.suspend(() => browserCommit("detect"));
