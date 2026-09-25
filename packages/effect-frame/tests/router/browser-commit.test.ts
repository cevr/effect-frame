/* oxlint-disable effect/noGlobals, effect/noThrowStatement, effect/noNullish, effect/noUnknownParameters, effect/noNewPromise -- this proof installs a fake `window.navigation`, replaces `history.pushState` with the platform signature, and hands the adapter fake navigate events whose handlers return promises. */
import { registerDom } from "./dom-setup.js";

registerDom();

/**
 * Route slice 5: the browser adapter's own boundary, with a fake
 * `navigation`. A real engine never lets a proof make `intercept` throw on
 * demand, so this is the one place the failure paths are driven. The real
 * browser behavior is proved in `route-leave-browser.test.ts`.
 */
import { Effect, Option, Queue, Stream } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { browserCommit } from "../../src/router/browser-commit.js";
import type * as Traversal from "../../src/router/traversal.js";
import { surfaceOf, traversalsOf } from "../../src/router/landing.js";
import type { Landing } from "../../src/router/landing.js";
import { Restore } from "../../src/router/navigation-behavior.js";

interface FakeNavigation {
  readonly listeners: Array<(event: NavigateEvent) => void>;
  currentEntry: { readonly key: string };
}

/** Install a fake `window.navigation` (and optionally the precommit controller) for the Scope. */
const fakeNavigation = (precommit: boolean): Effect.Effect<FakeNavigation, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const fake: FakeNavigation = { listeners: [], currentEntry: { key: "k0" } };
      const navigation = {
        get currentEntry() {
          return fake.currentEntry;
        },
        addEventListener: (_type: string, listener: (event: NavigateEvent) => void) => {
          fake.listeners.push(listener);
        },
        removeEventListener: (_type: string, listener: (event: NavigateEvent) => void) => {
          fake.listeners.splice(fake.listeners.indexOf(listener), 1);
        },
      };
      Object.defineProperty(globalThis, "navigation", { value: navigation, configurable: true });
      if (precommit) {
        Object.defineProperty(globalThis, "NavigationPrecommitController", {
          value: true,
          configurable: true,
        });
      }
      return fake;
    }),
    () =>
      Effect.sync(() => {
        Reflect.deleteProperty(globalThis, "navigation");
        Reflect.deleteProperty(globalThis, "NavigationPrecommitController");
      }),
  );

interface Sent {
  intercepted: number;
  prevented: number;
}

/** A same-document traverse event to entry `key`. `intercept` throws when asked. */
const traverseEvent = (
  key: string,
  options: { readonly cancelable: boolean; readonly interceptThrows: boolean },
  sent: Sent,
): NavigateEvent => {
  const event = {
    navigationType: "traverse",
    canIntercept: true,
    hashChange: false,
    cancelable: options.cancelable,
    info: undefined,
    destination: { key, url: `http://app.test/${key}` },
    signal: new AbortController().signal,
    intercept: () => {
      sent.intercepted += 1;
      if (options.interceptThrows) {
        throw new DOMException("not interceptable", "InvalidStateError");
      }
    },
    preventDefault: () => {
      sent.prevented += 1;
    },
  };
  // oxlint-disable-next-line effect/noAs, effect/noChainedTypeAssertions -- a fake event with the fields the adapter reads.
  return event as unknown as NavigateEvent;
};

/** Mount the adapter, consume its traversals and pops into queues. */
const adapter = (precommit: boolean, consume: boolean) =>
  Effect.gen(function* () {
    const fake = yield* fakeNavigation(precommit);
    const location = yield* browserCommit("detect");
    const traversals = yield* Queue.unbounded<Traversal.Traversal>();
    const pops = yield* Queue.unbounded<URL>();
    const source = yield* Option.match(traversalsOf(location), {
      onNone: () => Effect.die("no traversal source"),
      onSome: Effect.succeed,
    });
    if (consume) {
      const stream = yield* source.consume;
      yield* Effect.forkScoped(Stream.runForEach(stream, (one) => Queue.offer(traversals, one)));
    }
    yield* Effect.forkScoped(Stream.runForEach(location.pops, (url) => Queue.offer(pops, url)));
    // Let both streams attach.
    yield* Effect.yieldNow;
    yield* Effect.yieldNow;
    const dispatch = (event: NavigateEvent) =>
      Effect.sync(() => {
        for (const listener of fake.listeners) {
          listener(event);
        }
      });
    /** The platform commits to `key` and fires popstate. */
    const popTo = (key: string) =>
      Effect.gen(function* () {
        fake.currentEntry = { key };
        window.dispatchEvent(new Event("popstate"));
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
      });
    return { fake, location, traversals, pops, dispatch, popTo };
  });

/** One push the fake platform dispatched, and what the adapter did with it. */
interface PushEvent {
  readonly url: string;
  readonly abort: AbortController;
  intercepted: boolean;
  scrolled: number;
  settled: boolean;
}

/**
 * Replace `history.pushState` for the Scope, like the platform: it
 * dispatches `navigate` synchronously, and a newer navigation aborts the
 * ones still in progress. A listener may push again from inside a dispatch.
 */
const platformPush = (dispatch: (event: NavigateEvent) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<never>();
    const events: Array<PushEvent> = [];
    const original = window.history.pushState.bind(window.history);
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        window.history.pushState = (data: unknown, unused: string, url?: string | URL | null) => {
          original(data, unused, url);
          for (const earlier of events) {
            earlier.abort.abort();
          }
          const href = new URL(String(url), window.location.href).href;
          const own: PushEvent = {
            url: href,
            abort: new AbortController(),
            intercepted: false,
            scrolled: 0,
            settled: false,
          };
          events.push(own);
          const event = {
            navigationType: "push",
            canIntercept: true,
            hashChange: false,
            cancelable: true,
            info: undefined,
            destination: { key: "", url: href },
            signal: own.abort.signal,
            intercept: (options: NavigationInterceptOptions) => {
              own.intercepted = true;
              void Promise.resolve(options.handler?.()).then(() => {
                own.settled = true;
              });
            },
            scroll: () => {
              own.scrolled += 1;
            },
            preventDefault: () => {},
          };
          // oxlint-disable-next-line effect/noAs, effect/noChainedTypeAssertions -- a fake event with the fields the adapter reads.
          Effect.runSyncWith(context)(dispatch(event as unknown as NavigateEvent));
        };
      }),
      () =>
        Effect.sync(() => {
          window.history.pushState = original;
        }),
    );
    return events;
  });

describe("private browser commit adapter", () => {
  it.scoped("a precommit intercept that throws falls back to cancel and claims nothing", () =>
    Effect.gen(function* () {
      const { traversals, pops, dispatch, popTo } = yield* adapter(true, true);
      const sent: Sent = { intercepted: 0, prevented: 0 };
      yield* dispatch(traverseEvent("k1", { cancelable: true, interceptThrows: true }, sent));
      expect(sent).toEqual({ intercepted: 1, prevented: 1 });
      const held = yield* Queue.take(traversals);
      expect(held.protection).toBe("cancel");
      // The key was not claimed: its popstate still reaches the router.
      yield* popTo("k1");
      expect(Option.isSome(yield* Queue.poll(pops))).toBe(true);
    }),
  );

  it.scoped("a noncancelable intercept that throws leaves the move to popstate", () =>
    Effect.gen(function* () {
      const { traversals, pops, dispatch, popTo } = yield* adapter(true, true);
      const sent: Sent = { intercepted: 0, prevented: 0 };
      yield* dispatch(traverseEvent("k1", { cancelable: false, interceptThrows: true }, sent));
      expect(sent).toEqual({ intercepted: 1, prevented: 0 });
      expect(Option.isNone(yield* Queue.poll(traversals))).toBe(true);
      yield* popTo("k1");
      expect(Option.isSome(yield* Queue.poll(pops))).toBe(true);
    }),
  );

  it.scoped("an accepted intercept claims its key: that popstate is dropped", () =>
    Effect.gen(function* () {
      const { traversals, pops, dispatch, popTo } = yield* adapter(true, true);
      const sent: Sent = { intercepted: 0, prevented: 0 };
      yield* dispatch(traverseEvent("k1", { cancelable: false, interceptThrows: false }, sent));
      const held = yield* Queue.take(traversals);
      expect(held.protection).toBe("none");
      yield* popTo("k1");
      expect(Option.isNone(yield* Queue.poll(pops))).toBe(true);
      yield* held.finish;
    }),
  );

  it.scoped("each own write lands on its own event, once, and never on a newer one", () =>
    Effect.gen(function* () {
      const { location, dispatch } = yield* adapter(true, false);
      const events = yield* platformPush(dispatch);
      const surface = yield* Option.match(surfaceOf(location), {
        onNone: () => Effect.die("no surface"),
        onSome: Effect.succeed,
      });
      const flush = Effect.promise(() => Bun.sleep(5));
      const landing: Landing = { behavior: Restore, focus: Option.none() };
      const first = yield* surface.write("push", new URL("/first", window.location.href));
      const second = yield* surface.write("push", new URL("/second", window.location.href));
      yield* flush;
      // The second push aborted the first, which is released; the second waits.
      expect(events.map((one) => [one.settled, one.scrolled])).toEqual([
        [true, 0],
        [false, 0],
      ]);
      // The first write's landing places nothing and leaves the second alone.
      yield* first.land(Option.some(landing));
      yield* flush;
      expect(events.map((one) => [one.settled, one.scrolled])).toEqual([
        [true, 0],
        [false, 0],
      ]);
      // The second lands on its own event, once.
      yield* second.land(Option.some(landing));
      yield* second.land(Option.some(landing));
      yield* flush;
      expect(events.map((one) => [one.settled, one.scrolled])).toEqual([
        [true, 0],
        [true, 1],
      ]);
    }),
  );

  for (const order of ["ours first", "another listener first"]) {
    it.scoped(`a nested push from another listener is never the router's (${order})`, () =>
      Effect.gen(function* () {
        const { fake, location, dispatch } = yield* adapter(true, false);
        const events = yield* platformPush(dispatch);
        const outer = new URL("/outer", window.location.href);
        const nested = new URL("/nested", window.location.href);
        // Another listener pushes again while the router's own push dispatches.
        const other = (event: NavigateEvent) => {
          if (event.destination.url === outer.href) {
            window.history.pushState({}, "", nested.href);
          }
        };
        if (order === "ours first") {
          fake.listeners.push(other);
        } else {
          fake.listeners.unshift(other);
        }
        const surface = yield* Option.match(surfaceOf(location), {
          onNone: () => Effect.die("no surface"),
          onSome: Effect.succeed,
        });
        const landing: Landing = { behavior: Restore, focus: Option.none() };
        const written = yield* surface.write("push", outer);
        yield* written.land(Option.some(landing));
        yield* Effect.promise(() => Bun.sleep(5));
        const byUrl = (href: string) => events.filter((one) => one.url === href);
        // The nested push is left to the platform: not intercepted, never placed.
        expect(byUrl(nested.href).map((one) => [one.intercepted, one.scrolled])).toEqual([
          [false, 0],
        ]);
        // The outer push was superseded: it places nothing.
        expect(byUrl(outer.href).map((one) => one.scrolled)).toEqual([0]);
        // Nothing intercepted is left waiting.
        expect(events.filter((one) => one.intercepted && !one.settled)).toEqual([]);
      }),
    );
  }

  it.scoped("without a consumer the adapter holds nothing", () =>
    Effect.gen(function* () {
      const { pops, dispatch, popTo } = yield* adapter(true, false);
      const sent: Sent = { intercepted: 0, prevented: 0 };
      yield* dispatch(traverseEvent("k1", { cancelable: true, interceptThrows: false }, sent));
      expect(sent).toEqual({ intercepted: 0, prevented: 0 });
      yield* popTo("k1");
      expect(Option.isSome(yield* Queue.poll(pops))).toBe(true);
    }),
  );
});
