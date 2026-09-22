import { registerDom } from "./dom-setup.js";

registerDom();

import {
  Behavior,
  implementQuery,
  modify,
  query,
  select,
  spawn,
  useQuery,
} from "effect-frame/actor";
import type { Source } from "effect-frame/actor";
import { QueryTest } from "effect-frame/actor/testing";
import { Dom, Loading, Query, View, ViewTest, mount, readyWithStale } from "effect-frame/view";
import { Cause, Clock, Context, Deferred, Effect, Exit, Fiber, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import type { Host } from "effect-frame/view";
import type { Scope } from "effect";
import { describe, expect, it, test } from "effect-bun-test";

interface CountProps {
  readonly count: Source<number>;
}

const CountPage = (props: CountProps) =>
  Effect.succeed(<output id="count">{View.bind(props.count, (value) => String(value))}</output>);

const makeRoot = Effect.sync(() => document.createElement("main"));

const countText = (root: Node): string => {
  if (root instanceof HTMLElement) {
    return root.querySelector("#count")?.textContent ?? "";
  }
  return "";
};

const hasText = (root: Node, selector: string, expected: string): boolean =>
  root instanceof HTMLElement &&
  Option.match(Option.fromNullishOr(root.querySelector(selector)), {
    onNone: () => false,
    onSome: (element) => element.textContent === expected,
  });

const Search = query("ViewTestingSearch", {
  args: Schema.Struct({}),
  result: Schema.String,
});

let searchGate: Option.Option<Deferred.Deferred<void>> = Option.none();
let searchResolved: Option.Option<Deferred.Deferred<void>> = Option.none();

const SearchLive = implementQuery(Search, () =>
  Effect.gen(function* () {
    const gate = searchGate;
    if (Option.isSome(gate)) {
      yield* Deferred.await(gate.value);
    }
    if (Option.isSome(searchResolved)) {
      yield* Deferred.succeed(searchResolved.value, void 0);
    }
    return "first-row";
  }),
);

const searchLayer = QueryTest.layer({ queries: [SearchLive] });

class SetupService extends Context.Service<SetupService, { readonly value: number }>()(
  "effect-frame/tests/view/testing.test/SetupService",
) {}

class SetupFailure extends Schema.TaggedError<SetupFailure>()("SetupFailure", {}) {}

declare const typedHost: Host<string>;
const typedMake = () =>
  ViewTest.make({
    host: typedHost,
    root: "root",
    setup: () =>
      Effect.gen(function* () {
        const service = yield* SetupService;
        return service.value;
      }),
  });

const setupChannels: () => Effect.Effect<
  ViewTest.ViewTest<string, number>,
  SetupFailure,
  SetupService | Scope.Scope
> = typedMake;

declare const typedPage: ViewTest.ViewTest<string, number>;
declare const typedAction: Effect.Effect<boolean, SetupFailure, SetupService | Scope.Scope>;
const typedAct = () => typedPage.act(typedAction, { label: "typed", until: () => true });
const actionChannels: () => Effect.Effect<
  boolean,
  SetupFailure | ViewTest.ConditionNotObserved | ViewTest.HarnessClosed,
  SetupService
> = typedAct;

describe("scoped view test harness", () => {
  test("preserves setup and action Effect channels", () => {
    expect(setupChannels).toBeDefined();
    expect(actionChannels).toBeDefined();
  });

  it.scoped("mounts through the production runtime and waits for the observed result", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const count = yield* spawn(Behavior.value(0));
      const page = yield* ViewTest.make({
        host: Dom.host,
        root,
        setup: (host, mountRoot) => mount(CountPage, { count: count.state }, host, mountRoot),
      });

      expect(countText(root)).toBe("0");
      const applied = yield* page.act(
        modify(count, (value) => value + 1),
        {
          label: "counter shows one",
          until: (actualRoot) => countText(actualRoot) === "1",
        },
      );

      expect(applied.state).toBe(1);
      expect(countText(root)).toBe("1");
      yield* page.close;
      yield* page.close;
    }),
  );

  it.scoped("observes a deep asynchronous source chain without a yield count", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const count = yield* spawn(Behavior.value(0));
      let source: Source<number> = count.state;
      for (let index = 0; index < 24; index += 1) {
        source = select(source, (value) => value + 1);
      }
      const page = yield* ViewTest.make({
        host: Dom.host,
        root,
        setup: (host, mountRoot) => mount(CountPage, { count: source }, host, mountRoot),
      });

      expect(countText(root)).toBe("24");
      yield* page.act(
        modify(count, (value) => value + 1),
        {
          label: "deep chain reaches twenty-five",
          until: (actualRoot) => countText(actualRoot) === "25",
        },
      );
      expect(countText(root)).toBe("25");
    }),
  );

  it.scoped.layer(searchLayer)("observes loading while a real QueryTest handler is blocked", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const gate = yield* Deferred.make<void>();
      const resolved = yield* Deferred.make<void>();
      searchGate = Option.some(gate);
      searchResolved = Option.some(resolved);
      const SearchPage = () =>
        Loading({
          fallback: <p id="loading">loading</p>,
          children: Effect.gen(function* () {
            const entry = yield* useQuery(Search, {});
            yield* readyWithStale(entry.state, "");
            return (
              <Query
                state={entry.state}
                loading={<p id="query-loading">query-loading</p>}
                ready={(value) => <p id="result">{View.bind(value)}</p>}
                failed={() => <p id="failed">failed</p>}
              />
            );
          }),
        });
      const page = yield* ViewTest.make({
        host: Dom.host,
        root,
        setup: (host, mountRoot) => mount(SearchPage, {}, host, mountRoot),
      });

      yield* page.waitFor({
        label: "search loading",
        until: (actualRoot) =>
          actualRoot instanceof HTMLElement &&
          Option.isSome(Option.fromNullishOr(actualRoot.querySelector("#loading"))),
      });
      expect(root.querySelector("#result")).toBeNull();

      yield* page.act(Effect.andThen(Deferred.succeed(gate, void 0), Deferred.await(resolved)), {
        label: "search first row",
        until: (actualRoot) => hasText(actualRoot, "#result", "first-row"),
      });
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          searchGate = Option.none();
          searchResolved = Option.none();
        }),
      ),
    ),
  );

  it.scoped("closes a blocked action through the operation scope", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const count = yield* spawn(Behavior.value(0));
      const started = yield* Deferred.make<void>();
      const page = yield* ViewTest.make({
        host: Dom.host,
        root,
        setup: (host, mountRoot) => mount(CountPage, { count: count.state }, host, mountRoot),
      });
      const action = Effect.gen(function* () {
        yield* Deferred.succeed(started, void 0);
        return yield* Effect.never;
      });
      const fiber = yield* page
        .act(action, {
          label: "blocked action",
          until: () => false,
          timeout: "1 second",
        })
        .pipe(Effect.forkChild);

      yield* Deferred.await(started);
      yield* page.close;
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect(failure.value._tag).toBe("HarnessClosed");
        }
      }
    }),
  );

  it.scoped("returns an observed true state while an event handler remains blocked", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const started = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      const finished = yield* Deferred.make<void>();
      const EventPage = () =>
        Effect.succeed(
          <button
            id="dispatch"
            onClick={View.event(() =>
              Effect.gen(function* () {
                yield* Deferred.succeed(started, void 0);
                yield* Deferred.await(released);
                yield* Deferred.succeed(finished, void 0);
              }),
            )}
          >
            ready
          </button>,
        );
      const page = yield* ViewTest.make({
        host: Dom.host,
        root,
        setup: (host, mountRoot) => mount(EventPage, {}, host, mountRoot),
      });

      yield* page.act(
        Effect.sync(() => {
          const button = root.querySelector("#dispatch");
          if (button instanceof HTMLElement) {
            button.dispatchEvent(new Event("click"));
          }
        }),
        {
          label: "dispatch keeps ready state",
          until: (actualRoot) => hasText(actualRoot, "#dispatch", "ready"),
        },
      );

      yield* Deferred.await(started);
      expect(yield* Deferred.isDone(finished)).toBe(false);
      yield* Deferred.succeed(released, void 0);
      yield* Deferred.await(finished);
    }),
  );

  it.scoped("closes waits, listeners, and mounted nodes together", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      let released = 0;
      const trackedHost: Host<Node> = {
        ...Dom.host,
        addEventListener: (node, name, handler) => {
          const cleanup = Dom.host.addEventListener(node, name, handler);
          return () => {
            released += 1;
            cleanup();
          };
        },
      };
      const page = yield* ViewTest.make({
        host: trackedHost,
        root,
        setup: (host, mountRoot) =>
          mount(
            () =>
              Effect.succeed(
                <button id="listener" onClick={View.event(() => Effect.void)}>
                  listener
                </button>,
              ),
            {},
            host,
            mountRoot,
          ),
      });
      const waiting = yield* page
        .waitFor({ label: "never closes", timeout: "1 second", until: () => false })
        .pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      yield* page.close;
      const exit = yield* Fiber.await(waiting);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(root.querySelector("#listener")).toBeNull();
      expect(released).toBe(1);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect(failure.value._tag).toBe("HarnessClosed");
          if (failure.value._tag === "HarnessClosed") {
            expect(failure.value.listenersAttached).toBe(1);
            expect(failure.value.rootDisposed).toBe(true);
          }
        }
      }
    }),
  );

  it.scoped("times out an impossible condition without polling", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      let checks = 0;
      const count = yield* spawn(Behavior.value(0));
      const page = yield* ViewTest.make({
        host: Dom.host,
        root,
        rootId: "no-spin",
        summarizeRoot: () => "x".repeat(4096),
        setup: (host, mountRoot) => mount(CountPage, { count: count.state }, host, mountRoot),
      });
      const exit = yield* Effect.exit(
        page.waitFor({
          label: "never appears",
          timeout: "20 millis",
          until: () => {
            checks += 1;
            return false;
          },
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(checks).toBe(1);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect(failure.value._tag).toBe("ConditionNotObserved");
          if (failure.value._tag === "ConditionNotObserved") {
            expect(failure.value.rootId).toBe("no-spin");
            expect(failure.value.rootSummary.length).toBe(2048);
            expect(failure.value.revisionAtFailure).toBeGreaterThanOrEqual(
              failure.value.revisionAtStart,
            );
          }
        }
      }
    }),
  );

  it.scoped("interrupts an action when its deadline expires", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const interrupted = yield* Deferred.make<void>();
      const count = yield* spawn(Behavior.value(0));
      const page = yield* ViewTest.make({
        host: Dom.host,
        root,
        setup: (host, mountRoot) => mount(CountPage, { count: count.state }, host, mountRoot),
      });
      const exit = yield* Effect.exit(
        page.act(Effect.ensuring(Effect.never, Deferred.succeed(interrupted, void 0)), {
          label: "blocked action deadline",
          timeout: "20 millis",
          until: () => false,
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(yield* Deferred.isDone(interrupted)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect(failure.value._tag).toBe("ConditionNotObserved");
          if (failure.value._tag === "ConditionNotObserved") {
            expect(failure.value.actionFinished).toBe(false);
            expect(failure.value.rootDisposed).toBe(false);
          }
        }
      }
    }),
  );

  it.scoped("keeps two harnesses isolated by root", () =>
    Effect.gen(function* () {
      const firstRoot = yield* makeRoot;
      const secondRoot = yield* makeRoot;
      const first = yield* spawn(Behavior.value(0));
      const second = yield* spawn(Behavior.value(0));
      const firstPage = yield* ViewTest.make({
        host: Dom.host,
        root: firstRoot,
        setup: (host, mountRoot) => mount(CountPage, { count: first.state }, host, mountRoot),
      });
      const secondPage = yield* ViewTest.make({
        host: Dom.host,
        root: secondRoot,
        setup: (host, mountRoot) => mount(CountPage, { count: second.state }, host, mountRoot),
      });
      const waiting = yield* firstPage
        .waitFor({
          label: "first root reaches one",
          timeout: "20 millis",
          until: (root) => countText(root) === "1",
        })
        .pipe(Effect.forkChild);

      yield* secondPage.act(
        modify(second, (value) => value + 1),
        {
          label: "second root reaches one",
          until: (root) => countText(root) === "1",
        },
      );
      const firstExit = yield* Fiber.await(waiting);
      expect(Exit.isFailure(firstExit)).toBe(true);
      if (Exit.isFailure(firstExit)) {
        const failure = Cause.findErrorOption(firstExit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect(failure.value._tag).toBe("ConditionNotObserved");
        }
      }
      expect(countText(firstRoot)).toBe("0");
      expect(countText(secondRoot)).toBe("1");
    }),
  );

  it.scoped.layer(TestClock.layer())(
    "uses a live watchdog without advancing application time",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const count = yield* spawn(Behavior.value(0));
        const page = yield* ViewTest.make({
          host: Dom.host,
          root,
          setup: (host, mountRoot) => mount(CountPage, { count: count.state }, host, mountRoot),
        });
        const before = yield* Clock.currentTimeMillis;
        const exit = yield* Effect.exit(
          page.waitFor({
            label: "impossible state",
            until: () => false,
            timeout: "20 millis",
          }),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        expect(yield* Clock.currentTimeMillis).toBe(before);
        if (Exit.isFailure(exit)) {
          const failure = Cause.findErrorOption(exit.cause);
          expect(Option.isSome(failure)).toBe(true);
          if (Option.isSome(failure)) {
            expect(failure.value._tag).toBe("ConditionNotObserved");
            if (failure.value._tag === "ConditionNotObserved") {
              expect(failure.value.predicateChecked).toBe(true);
              expect(failure.value.predicateResult).toBe(false);
            }
          }
        }
      }),
  );
});
