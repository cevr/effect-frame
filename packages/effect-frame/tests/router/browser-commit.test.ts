/* oxlint-disable effect/noGlobals, effect/noNewError, effect/noThrowStatement, effect/noNullish -- this proof installs a fake `window.navigation` and hands the adapter fake navigate events. */
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
import * as Traversal from "../../src/router/traversal.js";

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
  // oxlint-disable-next-line effect/noAs, effect/noChainedTypeAssertions, typescript/no-unsafe-type-assertion -- a fake event with the fields the adapter reads.
  return event as unknown as NavigateEvent;
};

/** Mount the adapter, consume its traversals and pops into queues. */
const adapter = (precommit: boolean, consume: boolean) =>
  Effect.gen(function* () {
    const fake = yield* fakeNavigation(precommit);
    const location = yield* browserCommit("detect");
    const traversals = yield* Queue.unbounded<Traversal.Traversal>();
    const pops = yield* Queue.unbounded<URL>();
    const source = yield* Option.match(Traversal.read(location), {
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
    return { traversals, pops, dispatch, popTo };
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
