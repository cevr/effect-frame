import { registerDom } from "./dom-setup.js";

registerDom();

import {
  Behavior,
  Cell,
  Source,
  implementQuery,
  modify,
  query,
  spawn,
  useQuery,
} from "effect-frame/actor";
import type { QueryState, Source as SourceType } from "effect-frame/actor";
import { QueryTest } from "effect-frame/actor/testing";
import { Dom, Loading, Query, View, ViewTest, mount, readyWithStale } from "effect-frame/view";
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Match,
  Option,
  Scope,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import type { Host } from "effect-frame/view";
import { describe, expect, it, test } from "effect-bun-test";

interface CountProps {
  readonly count: SourceType<number>;
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
        if (service.value < 0) {
          return yield* SetupFailure.make();
        }
        return service.value;
      }),
  });

type TypedMake = ReturnType<typeof typedMake>;
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const setupValue: Equals<Effect.Success<TypedMake>["setup"], number> = true;
const setupRoot: Equals<Effect.Success<TypedMake>["root"], string> = true;
const setupFailure: Equals<Effect.Error<TypedMake>, SetupFailure> = true;
const setupRequirements: Equals<Effect.Services<TypedMake>, SetupService | Scope.Scope> = true;

declare const typedPage: ViewTest.ViewTest<string, number>;
declare const typedAction: Effect.Effect<boolean, SetupFailure, SetupService | Scope.Scope>;
const typedAct = () => typedPage.act(typedAction, { label: "typed", until: () => true });
type TypedAction = ReturnType<typeof typedAct>;
const actionSuccess: Equals<Effect.Success<TypedAction>, boolean> = true;
const actionFailure: Equals<
  Effect.Error<TypedAction>,
  SetupFailure | ViewTest.ConditionNotObserved | ViewTest.HarnessClosed
> = true;
const actionRequirements: Equals<Effect.Services<TypedAction>, SetupService> = true;

const typedProvided = () =>
  typedMake().pipe(
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(Layer.succeed(SetupService, SetupService.of({ value: 1 }))),
  );
type TypedProvided = ReturnType<typeof typedProvided>;
const providedFailure: Equals<Effect.Error<TypedProvided>, SetupFailure> = true;
const providedRequirements: Equals<Effect.Services<TypedProvided>, Scope.Scope> = true;

describe("scoped view test harness", () => {
  test("preserves setup and action Effect channels", () => {
    expect(setupValue).toBe(true);
    expect(setupRoot).toBe(true);
    expect(setupFailure).toBe(true);
    expect(setupRequirements).toBe(true);
    expect(actionSuccess).toBe(true);
    expect(actionFailure).toBe(true);
    expect(actionRequirements).toBe(true);
    expect(providedFailure).toBe(true);
    expect(providedRequirements).toBe(true);
  });

  it.scoped("closes setup resources when setup fails", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const finalized = yield* Deferred.make<void>();
      const exit = yield* Effect.exit(
        ViewTest.make({
          host: Dom.host,
          root,
          setup: (host, mountRoot) =>
            Effect.gen(function* () {
              yield* mount(
                () => Effect.succeed(<p id="failed-setup">temporary</p>),
                {},
                host,
                mountRoot,
              );
              yield* Effect.addFinalizer(() =>
                Deferred.succeed(finalized, void 0).pipe(Effect.asVoid),
              );
              return yield* SetupFailure.make();
            }),
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect(failure.value._tag).toBe("SetupFailure");
        }
      }
      yield* Deferred.await(finalized);
      expect(root.childNodes.length).toBe(0);
    }),
  );

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
      let source: SourceType<QueryState<number, never>> = yield* Source.mapEffect(
        count.state,
        (value) => Effect.andThen(Effect.yieldNow, Effect.succeed(value + 1)),
      );
      for (let index = 1; index < 24; index += 1) {
        const previous = source;
        source = yield* Source.mapEffect(previous, (state) =>
          Match.value(state).pipe(
            Match.tagsExhaustive({
              Loading: () => Effect.never,
              Ready: (value) => Effect.andThen(Effect.yieldNow, Effect.succeed(value.value + 1)),
              Failed: () => Effect.never,
            }),
          ),
        );
      }
      const AsyncCountPage = () =>
        Effect.succeed(
          <Query
            state={source}
            loading={<output id="count">loading</output>}
            ready={(value) => <output id="count">{View.bind(value, String)}</output>}
            failed={() => <output id="count">failed</output>}
          />,
        );
      const page = yield* ViewTest.make({
        host: Dom.host,
        root,
        setup: (host, mountRoot) => mount(AsyncCountPage, {}, host, mountRoot),
      });

      yield* page.waitFor({
        label: "initial deep chain",
        until: (actualRoot) => countText(actualRoot) === "24",
      });
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

  it.scoped("does not lose a host write scheduled after action completion", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const count = yield* spawn(Behavior.value(0));
      const release = yield* Deferred.make<void>();
      const page = yield* ViewTest.make({
        host: Dom.host,
        root,
        setup: (host, mountRoot) => mount(CountPage, { count: count.state }, host, mountRoot),
      });

      yield* page.act(
        Effect.gen(function* () {
          yield* Effect.forkChild(
            Effect.andThen(
              Deferred.await(release),
              modify(count, (value) => value + 1),
            ),
          );
          yield* Deferred.succeed(release, void 0);
        }),
        {
          label: "scheduled child write",
          until: (actualRoot) => countText(actualRoot) === "1",
        },
      );
      expect(countText(root)).toBe("1");
    }),
  );

  it.scoped("closes the predicate to waiter registration race with its revision handshake", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      let observedHost: Option.Option<Host<Node>> = Option.none();
      const page = yield* ViewTest.make({
        host: Dom.host,
        root,
        setup: (host, mountRoot) => {
          observedHost = Option.some(host);
          return mount(
            CountPage,
            { count: { get: Effect.succeed(0), changes: Stream.empty } },
            host,
            mountRoot,
          );
        },
      });
      const originalAdd = Set.prototype.add;
      let injected = false;
      let writeDuringRegistration = false;
      // Test-only fault injection. The actual observed host write runs while
      // the waiter's Set registration is in progress.
      // oxlint-disable-next-line no-extend-native
      Set.prototype.add = function <T>(this: Set<T>, value: T): Set<T> {
        if (
          !injected &&
          // oxlint-disable-next-line effect/noRuntimeTypeof, effect/noNullish
          typeof value === "object" &&
          // oxlint-disable-next-line effect/noNullish
          value !== null &&
          "afterRevision" in value &&
          "resume" in value
        ) {
          injected = true;
          const host = observedHost;
          if (Option.isSome(host)) {
            const count = Option.fromNullishOr(root.querySelector("#count"));
            Option.match(count, {
              onNone: () => {},
              onSome: (node) => {
                writeDuringRegistration = true;
                host.value.setText(node, "raced");
              },
            });
          }
        }
        return originalAdd.call(this, value);
      };

      yield* Effect.ensuring(
        page.waitFor({
          label: "registration race",
          timeout: "100 millis",
          until: (actualRoot) => countText(actualRoot) === "raced",
        }),
        Effect.sync(() => {
          // oxlint-disable-next-line no-extend-native
          Set.prototype.add = originalAdd;
        }),
      );
      expect(injected).toBe(true);
      expect(writeDuringRegistration).toBe(true);
      expect(countText(root)).toBe("raced");
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

  it.scoped("returns HarnessClosed for operations started after explicit close", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      let started = false;
      const page = yield* ViewTest.make({
        host: Dom.host,
        root,
        setup: (host, mountRoot) =>
          mount(() => Effect.succeed(<p id="closed">closed</p>), {}, host, mountRoot),
      });
      yield* page.close;

      const assertClosed = (exit: Exit.Exit<unknown, unknown>): void => {
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const failure = Cause.findErrorOption(exit.cause);
          expect(Option.isSome(failure)).toBe(true);
          if (Option.isSome(failure)) {
            const closed = Schema.is(ViewTest.HarnessClosed)(failure.value);
            expect(closed).toBe(true);
            if (closed) {
              expect(failure.value.rootDisposed).toBe(true);
            }
          }
        }
      };

      assertClosed(
        yield* Effect.exit(page.waitFor({ label: "wait after close", until: () => false })),
      );
      assertClosed(
        yield* Effect.exit(
          page.act(
            Effect.sync(() => void (started = true)),
            {
              label: "act after close",
              until: () => true,
            },
          ),
        ),
      );
      expect(started).toBe(false);
    }),
  );

  it.scoped("returns HarnessClosed for operations after the parent scope closes", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      let started = false;
      const parent = yield* Scope.make();
      const page = yield* Scope.provide(
        ViewTest.make({
          host: Dom.host,
          root,
          setup: (host, mountRoot) =>
            mount(() => Effect.succeed(<p id="parent-closed">closed</p>), {}, host, mountRoot),
        }),
        parent,
      );
      yield* Scope.close(parent, Exit.void);

      const assertClosed = (exit: Exit.Exit<unknown, unknown>): void => {
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const failure = Cause.findErrorOption(exit.cause);
          expect(Option.isSome(failure)).toBe(true);
          if (Option.isSome(failure)) {
            const closed = Schema.is(ViewTest.HarnessClosed)(failure.value);
            expect(closed).toBe(true);
            if (closed) {
              expect(failure.value.rootDisposed).toBe(true);
            }
          }
        }
      };

      assertClosed(
        yield* Effect.exit(page.waitFor({ label: "wait after parent close", until: () => false })),
      );
      assertClosed(
        yield* Effect.exit(
          page.act(
            Effect.sync(() => void (started = true)),
            {
              label: "act after parent close",
              until: () => true,
            },
          ),
        ),
      );
      expect(started).toBe(false);
      expect(root.childNodes.length).toBe(0);
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
            expect(failure.value.rootDisposed).toBe(false);
          }
        }
      }
    }),
  );

  it.scoped("reports close before blocked cleanup has disposed the root", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const closing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const page = yield* ViewTest.make({
        host: Dom.host,
        root,
        setup: (host, mountRoot) =>
          Effect.gen(function* () {
            const mounted = yield* mount(
              () => Effect.succeed(<p id="still-mounted">still mounted</p>),
              {},
              host,
              mountRoot,
            );
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                yield* Deferred.succeed(closing, void 0);
                yield* Deferred.await(release);
              }),
            );
            return mounted;
          }),
      });
      const waiting = yield* page
        .waitFor({ label: "cleanup receipt", until: () => false })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const close = yield* page.close.pipe(Effect.forkChild);
      yield* Deferred.await(closing);

      const exit = yield* Fiber.await(waiting);
      expect(root.querySelector("#still-mounted")).not.toBeNull();
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect(failure.value._tag).toBe("HarnessClosed");
          if (failure.value._tag === "HarnessClosed") {
            expect(failure.value.rootDisposed).toBe(false);
          }
        }
      }

      yield* Deferred.succeed(release, void 0);
      yield* Fiber.join(close);
      expect(root.querySelector("#still-mounted")).toBeNull();
    }),
  );

  it.scoped("keeps a reentrant host write observable", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const count = yield* spawn(Behavior.value(0));
      let wrapped: Option.Option<Host<Node>> = Option.none();
      let nestedWrites = 0;
      let reentrant = false;
      const reentrantHost: Host<Node> = {
        ...Dom.host,
        setText: (node, text) => {
          Dom.host.setText(node, text);
          if (!reentrant && Option.isSome(wrapped)) {
            reentrant = true;
            nestedWrites += 1;
            wrapped.value.setText(node, text);
            reentrant = false;
          }
        },
      };
      const page = yield* ViewTest.make({
        host: reentrantHost,
        root,
        setup: (host, mountRoot) => {
          wrapped = Option.some(host);
          return mount(CountPage, { count: count.state }, host, mountRoot);
        },
      });

      yield* page.act(
        modify(count, (value) => value + 1),
        {
          label: "reentrant count write",
          until: (actualRoot) => countText(actualRoot) === "1",
        },
      );
      expect(nestedWrites).toBeGreaterThan(0);
      expect(countText(root)).toBe("1");
    }),
  );

  it.scoped("propagates an application action error", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const page = yield* ViewTest.make({
        host: Dom.host,
        root,
        setup: (host, mountRoot) =>
          mount(
            CountPage,
            { count: { get: Effect.succeed(0), changes: Stream.empty } },
            host,
            mountRoot,
          ),
      });
      const exit = yield* Effect.exit(
        page.act(Effect.fail("application boom"), {
          label: "action error",
          until: () => false,
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect(failure.value).toBe("application boom");
        }
      }
    }),
  );

  it.scoped("propagates a thrown predicate defect", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const page = yield* ViewTest.make({
        host: Dom.host,
        root,
        setup: (host, mountRoot) =>
          mount(
            CountPage,
            { count: { get: Effect.succeed(0), changes: Stream.empty } },
            host,
            mountRoot,
          ),
      });
      const exit = yield* Effect.exit(
        page.waitFor({
          label: "throwing predicate",
          until: () => {
            // This verifies that a programmer defect escapes the harness.
            // oxlint-disable-next-line effect/noThrowStatement, effect/noNewError
            throw new Error("predicate boom");
          },
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true);
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

  it.scoped("rejects non-positive and infinite condition deadlines", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const page = yield* ViewTest.make({
        host: Dom.host,
        root,
        setup: (host, mountRoot) =>
          mount(
            CountPage,
            { count: { get: Effect.succeed(0), changes: Stream.empty } },
            host,
            mountRoot,
          ),
      });
      for (const timeout of [0, -1, Infinity]) {
        const exit = yield* Effect.exit(
          page.waitFor({
            label: `invalid timeout ${String(timeout)}`,
            timeout,
            until: () => false,
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
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

  it.scoped.layer(TestClock.layer())(
    "observes debounced and recurring work on the application clock",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const input = yield* Cell.make(0);
        const debounced = yield* Source.debounce(input.state, "1 second");
        const recurring = yield* Cell.make(0);
        const recurringReached = yield* Deferred.make<void>();
        const Page = () =>
          Effect.gen(function* () {
            yield* Effect.forkScoped(
              Effect.repeat(
                Effect.gen(function* () {
                  yield* Effect.sleep("1 second");
                  yield* recurring.update((value) => value + 1);
                  if ((yield* recurring.get) === 3) {
                    yield* Deferred.succeed(recurringReached, void 0);
                  }
                }),
                Schedule.forever,
              ),
            );
            return (
              <section>
                <output id="debounced">{View.bind(debounced, String)}</output>
                <output id="recurring">{View.bind(recurring.state, String)}</output>
              </section>
            );
          });
        const page = yield* ViewTest.make({
          host: Dom.host,
          root,
          setup: (host, mountRoot) => mount(Page, {}, host, mountRoot),
        });

        yield* input.set(1);
        yield* input.set(2);
        expect(root.querySelector("#debounced")?.textContent).toBe("0");
        yield* TestClock.adjust("1 second");
        yield* page.waitFor({
          label: "debounced source",
          until: (actualRoot) => hasText(actualRoot, "#debounced", "2"),
        });

        const recurringObserved = yield* page
          .waitFor({
            label: "recurring source",
            until: (actualRoot) => hasText(actualRoot, "#recurring", "3"),
          })
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("3 seconds");
        yield* Deferred.await(recurringReached);
        yield* Fiber.join(recurringObserved);
      }),
  );
});
