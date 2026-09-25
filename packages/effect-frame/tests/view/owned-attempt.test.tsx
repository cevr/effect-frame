import { registerDom } from "./dom-setup.js";

registerDom();

import {
  Behavior,
  Value,
  implementQuery,
  query,
  spawn,
  useQuery,
  Policies,
  Policy,
} from "effect-frame/actor";
import type { Source } from "effect-frame/actor";
import { QueryTest } from "effect-frame/actor/testing";
import { Dom, Html, Await, Show, View } from "effect-frame/view";
import { ViewTest } from "effect-frame/view/testing";
import type { Node as ViewNode } from "effect-frame/view";
import * as Frame from "../../src/frame.js";
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "effect-bun-test";

/** The one policy table: every contract and query here declares `public`. */
const policies = Layer.succeed(Policies, Policies.of({ public: Policy.allowAll }));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AttemptQuery = query("OwnedAttempt", {
  policy: "public",
  args: Schema.Struct({ id: Schema.String }),
  result: Schema.String,
});

interface Held {
  readonly gate: Deferred.Deferred<void>;
  readonly started: Deferred.Deferred<void>;
}

interface FixturesService {
  readonly held: Ref.Ref<ReadonlyMap<string, Held>>;
  readonly calls: Ref.Ref<ReadonlyMap<string, number>>;
}

class Fixtures extends Context.Service<Fixtures, FixturesService>()(
  "effect-frame/tests/view/owned-attempt.test/Fixtures",
) {}

/** A real QueryTest handler: an id with a held entry blocks until its gate. */
const AttemptLive = implementQuery(AttemptQuery, ({ id }) =>
  Effect.gen(function* () {
    const fixtures = yield* Fixtures;
    yield* Ref.update(fixtures.calls, (calls) => {
      const next = new Map(calls);
      next.set(id, Option.getOrElse(Option.fromNullishOr(calls.get(id)), () => 0) + 1);
      return next;
    });
    const held = Option.fromNullishOr((yield* Ref.get(fixtures.held)).get(id));
    if (Option.isSome(held)) {
      yield* Deferred.succeed(held.value.started, void 0);
      yield* Deferred.await(held.value.gate);
    }
    return `value:${id}`;
  }),
);

const makeFixtures = Effect.gen(function* () {
  return Fixtures.of({
    held: yield* Ref.make<ReadonlyMap<string, Held>>(new Map()),
    calls: yield* Ref.make<ReadonlyMap<string, number>>(new Map()),
  });
});

const frameLayer = (name: string) =>
  QueryTest.layer({ queries: [AttemptLive] }).pipe(
    Layer.provide(policies),
    Layer.provideMerge(Layer.effect(Fixtures, makeFixtures)),
    Layer.provideMerge(TestClock.layer()),
    Layer.provideMerge(Frame.layer({ name })),
  );

const hold = Effect.fn("OwnedAttemptTest.hold")(function* (id: string) {
  const fixtures = yield* Fixtures;
  const held: Held = { gate: yield* Deferred.make<void>(), started: yield* Deferred.make<void>() };
  yield* Ref.update(fixtures.held, (all) => new Map(all).set(id, held));
  return held;
});

const callsOf = Effect.fn("OwnedAttemptTest.callsOf")(function* (id: string) {
  const fixtures = yield* Fixtures;
  return Option.getOrElse(Option.fromNullishOr((yield* Ref.get(fixtures.calls)).get(id)), () => 0);
});

class SetupFailed extends Schema.TaggedError<SetupFailed>()("SetupFailed", {
  reason: Schema.String,
}) {}

class FallbackFailed extends Schema.TaggedError<FallbackFailed>()("FallbackFailed", {
  reason: Schema.String,
}) {}

class Tenant extends Context.Service<Tenant, { readonly name: string }>()(
  "effect-frame/tests/view/owned-attempt.test/Tenant",
) {}

const queryRecord = (snapshot: Frame.Snapshot, id: string) =>
  Option.fromNullishOr(snapshot.queries.find((record) => record.key.includes(`"${id}"`)));

const queryIds = (snapshot: Frame.Snapshot): ReadonlyArray<string> =>
  snapshot.queries.map((record) => record.key).toSorted();

const onlyId = (records: ReadonlyArray<{ readonly id: Frame.Identity }>): Frame.Identity => {
  expect(records).toHaveLength(1);
  return Option.getOrThrow(Option.fromNullishOr(records[0]?.id));
};

const actorByRevision = (snapshot: Frame.Snapshot, revision: number) =>
  snapshot.actors.filter((record) => record.revision === revision);

const textAt = (root: globalThis.Node, selector: string): string => {
  if (!(root instanceof HTMLElement)) {
    return "";
  }
  return Option.getOrElse(
    Option.fromNullishOr(root.querySelector(selector)?.textContent),
    () => "",
  );
};

const hasAt = (root: globalThis.Node, selector: string): boolean =>
  root instanceof HTMLElement && Option.isSome(Option.fromNullishOr(root.querySelector(selector)));

const makeRoot = Effect.acquireRelease(
  Effect.sync(() => {
    const created = document.createElement("main");
    document.body.appendChild(created);
    return created;
  }),
  (created) => Effect.sync(() => created.remove()),
);

const mountPage = <E, R>(view: View.View<Record<string, never>, E, R>, root: HTMLElement) =>
  ViewTest.make({
    host: Dom.host,
    root,
    setup: (host, mountRoot) => View.mount(view, {}, host, mountRoot),
  });

const push = <A,>(ref: Ref.Ref<ReadonlyArray<A>>, value: A) =>
  Ref.update(ref, (all) => [...all, value]);

/** Increment Value actor revisions so a record can be told apart in a snapshot. */
const spawnAtRevision = Effect.fn("OwnedAttemptTest.spawnAtRevision")(function* (revision: number) {
  const actor = yield* spawn(Behavior.value(0));
  for (let next = 1; next <= revision; next += 1) {
    yield* Effect.orDie(actor.call(Value.Set(next)));
  }
  return actor;
});

// ---------------------------------------------------------------------------
// Proof 3: exact type fixtures. Unannotated expressions only.
// ---------------------------------------------------------------------------

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

class SetupService extends Context.Service<SetupService, { readonly offline: boolean }>()(
  "effect-frame/tests/view/owned-attempt.test/SetupService",
) {}

class FallbackService extends Context.Service<FallbackService, { readonly denied: boolean }>()(
  "effect-frame/tests/view/owned-attempt.test/FallbackService",
) {}

const setupExpr = Effect.gen(function* () {
  const service = yield* SetupService;
  if (service.offline) {
    return yield* SetupFailed.make({ reason: "offline" });
  }
  return <p>setup</p>;
});

const fallbackExpr = (error: SetupFailed) =>
  Effect.gen(function* () {
    const service = yield* FallbackService;
    if (service.denied) {
      return yield* FallbackFailed.make({ reason: error.reason });
    }
    return <p>fallback</p>;
  });

const attemptedExpr = View.attempt(setupExpr, fallbackExpr);
/** E is inferred from setup into the fallback parameter, not annotated. */
const inferredParameter = View.attempt(setupExpr, (error) => Effect.succeed(<p>{error.reason}</p>));
/** A fallback that needs no service and cannot fail. */
const handledExpr = View.attempt(setupExpr, () => Effect.succeed(<p>handled</p>));
/** A setup that needs no Scope still yields a Scope requirement: the owner. */
const noScopeSetup = View.attempt(Effect.succeed(<p>plain</p>), () => Effect.succeed(<p>never</p>));

const setupError: Equals<Effect.Error<typeof setupExpr>, SetupFailed> = true;
const setupServices: Equals<Effect.Services<typeof setupExpr>, SetupService> = true;
const successIsNode: Equals<Effect.Success<typeof attemptedExpr>, ViewNode> = true;
const errorIsFallbackError: Equals<Effect.Error<typeof attemptedExpr>, FallbackFailed> = true;
const servicesAreExact: Equals<
  Effect.Services<typeof attemptedExpr>,
  SetupService | FallbackService | Scope.Scope
> = true;
const inferredError: Equals<Effect.Error<typeof inferredParameter>, never> = true;
const inferredServices: Equals<
  Effect.Services<typeof inferredParameter>,
  SetupService | Scope.Scope
> = true;
const handledError: Equals<Effect.Error<typeof handledExpr>, never> = true;
const noScopeServices: Equals<Effect.Services<typeof noScopeSetup>, Scope.Scope> = true;

// @ts-expect-error Setup E does not leak into the result beside E2.
const leakedSetupError: Equals<
  Effect.Error<typeof attemptedExpr>,
  SetupFailed | FallbackFailed
> = true;
// @ts-expect-error The result is not typed with setup E instead of E2.
const setupErrorOnly: Equals<Effect.Error<typeof attemptedExpr>, SetupFailed> = true;
// @ts-expect-error Scope stays visible to the owner.
const scopeHidden: Equals<
  Effect.Services<typeof attemptedExpr>,
  SetupService | FallbackService
> = true;
// @ts-expect-error Setup R stays visible.
const setupServiceHidden: Equals<
  Effect.Services<typeof attemptedExpr>,
  FallbackService | Scope.Scope
> = true;
// @ts-expect-error Fallback R stays visible.
const fallbackServiceHidden: Equals<
  Effect.Services<typeof attemptedExpr>,
  SetupService | Scope.Scope
> = true;

// Negative fixtures below are TypeScript errors by design. The Effect language
// service reports the same mismatch separately, so it is paused for them only.
// @effect-diagnostics missingEffectError:off
const wrongFallback = View.attempt<SetupFailed, SetupService, never, never>(
  setupExpr,
  // @ts-expect-error A fallback for a different error does not accept setup E.
  (error: FallbackFailed) => Effect.succeed(<p>{error.reason}</p>),
);

const items: Source<ReadonlyArray<string>> = { get: Effect.succeed([]), changes: Stream.empty };
/** A handled attempt is a legal `View.list` row. */
const handledRow = View.list({ each: items, keyBy: (id) => id, row: () => handledExpr });
const handledRowServices: Equals<Effect.Services<typeof handledRow>, SetupService> = true;
const unhandledRow = View.list({
  each: items,
  keyBy: (id) => id,
  // @ts-expect-error A row cannot return fallback E2.
  row: () => attemptedExpr,
});

// @effect-diagnostics missingEffectError:error
const mountAttempted = () => View.mount(() => attemptedExpr, {}, Dom.host, document.body);
const mountIsExact: Equals<
  ReturnType<typeof mountAttempted>,
  Effect.Effect<void, FallbackFailed, SetupService | FallbackService | Scope.Scope>
> = true;

const typeFixtures: ReadonlyArray<boolean> = [
  setupError,
  setupServices,
  successIsNode,
  errorIsFallbackError,
  servicesAreExact,
  inferredError,
  inferredServices,
  handledError,
  noScopeServices,
  handledRowServices,
  mountIsExact,
];
const negativeFixtures: ReadonlyArray<unknown> = [
  leakedSetupError,
  setupErrorOnly,
  scopeHidden,
  setupServiceHidden,
  fallbackServiceHidden,
  wrongFallback,
  unhandledRow,
];

// ---------------------------------------------------------------------------
// Proofs
// ---------------------------------------------------------------------------

describe("private owned attempt", () => {
  it.scoped.layer(frameLayer("owned-attempt-success"))(
    "1. keeps a successful row owner's actor and held query until only that row leaves",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const heldA = yield* hold("row-a");
        const heldB = yield* hold("row-b");
        const setups = yield* Ref.make<ReadonlyArray<string>>([]);
        const closedB = yield* Deferred.make<void>();
        const parentSetups = yield* Ref.make(0);
        const rowsSource = yield* spawn(
          Behavior.value<
            ReadonlyArray<{
              readonly id: string;
              readonly label: string;
              readonly revision: number;
            }>
          >([
            { id: "a", label: "A", revision: 21 },
            { id: "b", label: "B", revision: 22 },
          ]),
        );

        const Page = () =>
          Effect.gen(function* () {
            yield* Ref.update(parentSetups, (count) => count + 1);
            const parent = yield* spawnAtRevision(24);
            const rows = yield* View.list({
              each: rowsSource.state,
              keyBy: (row) => row.id,
              row: (item) =>
                View.attempt(
                  Effect.gen(function* () {
                    const first = yield* item.get;
                    // Registered first, so it runs after the actor and query close.
                    if (first.id === "b") {
                      yield* Effect.addFinalizer(() => Deferred.succeed(closedB, void 0));
                    }
                    yield* push(setups, first.id);
                    const actor = yield* spawnAtRevision(first.revision);
                    const entry = yield* useQuery(AttemptQuery, { id: `row-${first.id}` });
                    return (
                      <li id={`row-${first.id}`}>
                        <span class="label">{View.bind(item, (row) => row.label)}</span>
                        <output class="actor">{View.bind(actor.state, String)}</output>
                        <Await
                          state={entry.state}
                          loading={<span class="value">loading</span>}
                          ready={(value) => <span class="value">{View.bind(value)}</span>}
                          failed={() => <span class="value">failed</span>}
                        />
                      </li>
                    );
                  }),
                  (error: SetupFailed) => Effect.succeed(<li>{error.reason}</li>),
                ),
            });
            return (
              <section id="parent">
                <output id="parent-actor">{View.bind(parent.state, String)}</output>
                <ul>{rows}</ul>
              </section>
            );
          });

        const sourceId = onlyId((yield* Frame.inspect).actors);
        const page = yield* mountPage(Page, root);
        yield* Deferred.await(heldA.started);
        yield* Deferred.await(heldB.started);
        yield* page.waitFor({
          label: "both rows show their held query",
          until: (actual) =>
            textAt(actual, "#row-a .value") === "loading" &&
            textAt(actual, "#row-b .value") === "loading",
        });
        const held = yield* Frame.inspect;
        expect(held.mounts).toHaveLength(1);
        expect(actorByRevision(held, 21)).toHaveLength(1);
        expect(actorByRevision(held, 22)).toHaveLength(1);
        expect(held.actors).toHaveLength(4);
        expect(Option.map(queryRecord(held, "row-a"), (record) => record.state)).toEqual(
          Option.some("Loading"),
        );
        expect(Option.map(queryRecord(held, "row-b"), (record) => record.state)).toEqual(
          Option.some("Loading"),
        );
        const parentActorId = onlyId(actorByRevision(held, 24));
        const rowAActorId = onlyId(actorByRevision(held, 21));
        const rowAQueryId = Option.map(queryRecord(held, "row-a"), (record) => record.id);

        yield* Deferred.succeed(heldA.gate, void 0);
        yield* Deferred.succeed(heldB.gate, void 0);
        yield* page.waitFor({
          label: "query data updates both rows",
          until: (actual) =>
            textAt(actual, "#row-a .value") === "value:row-a" &&
            textAt(actual, "#row-b .value") === "value:row-b",
        });
        const firstA = root.querySelector("#row-a");
        yield* page.act(
          rowsSource.call(
            Value.Set([
              { id: "a", label: "A2", revision: 21 },
              { id: "b", label: "B2", revision: 22 },
            ]),
          ),
          {
            label: "row item update",
            until: (actual) =>
              textAt(actual, "#row-a .label") === "A2" && textAt(actual, "#row-b .label") === "B2",
          },
        );
        expect(yield* Ref.get(setups)).toEqual(["a", "b"]);
        expect(root.querySelector("#row-a")).toBe(firstA);

        yield* page.act(rowsSource.call(Value.Set([{ id: "a", label: "A2", revision: 21 }])), {
          label: "row b leaves",
          until: (actual) => !hasAt(actual, "#row-b"),
        });
        yield* Deferred.await(closedB);
        const after = yield* Frame.inspect;
        expect(after.actors.map((record) => record.id).toSorted()).toEqual(
          [sourceId, parentActorId, rowAActorId].toSorted(),
        );
        expect(actorByRevision(after, 22)).toHaveLength(0);
        expect(Option.isNone(queryRecord(after, "row-b"))).toBe(true);
        expect(Option.map(queryRecord(after, "row-a"), (record) => record.id)).toEqual(rowAQueryId);
        expect(textAt(root, "#parent-actor")).toBe("24");
        expect(root.querySelector("#row-a")).toBe(firstA);
        expect(yield* Ref.get(parentSetups)).toBe(1);
        expect(yield* Ref.get(setups)).toEqual(["a", "b"]);

        yield* page.close;
        const closed = yield* Frame.inspect;
        expect(closed.actors.map((record) => record.id)).toEqual([sourceId]);
        expect(closed.queries).toHaveLength(0);
      }),
  );

  it.scoped.layer(frameLayer("owned-attempt-typed-failure"))(
    "2. closes a failed setup, waiting for its held finalizer, before fallback starts fresh",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const finalizerStarted = yield* Deferred.make<void>();
        const releaseFinalizer = yield* Deferred.make<void>();
        const setupScope = yield* Deferred.make<Scope.Scope>();
        const rowScope = yield* Deferred.make<Scope.Scope>();
        const fallbackStarted = yield* Deferred.make<{
          readonly scope: Scope.Scope;
          readonly tenant: string;
          readonly now: number;
          readonly reason: string;
          readonly setupClosedFirst: boolean;
        }>();
        yield* TestClock.adjust("5 seconds");
        const rowsSource: Source<ReadonlyArray<string>> = {
          get: Effect.succeed(["only"]),
          changes: Stream.empty,
        };

        const Page = () =>
          Effect.gen(function* () {
            const rows = yield* View.list({
              each: rowsSource,
              keyBy: (id) => id,
              row: () =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(rowScope, yield* Effect.scope);
                  return yield* View.attempt(
                    Effect.gen(function* () {
                      yield* Deferred.succeed(setupScope, yield* Effect.scope);
                      yield* spawnAtRevision(3);
                      yield* useQuery(AttemptQuery, { id: "doomed" });
                      yield* Effect.addFinalizer(() =>
                        Effect.andThen(
                          Deferred.succeed(finalizerStarted, void 0),
                          Deferred.await(releaseFinalizer),
                        ),
                      );
                      return yield* SetupFailed.make({ reason: "denied" });
                    }),
                    (error) =>
                      Effect.gen(function* () {
                        const scope = yield* Effect.scope;
                        const tenant = yield* Tenant;
                        const failedScope = yield* Deferred.await(setupScope);
                        yield* Deferred.succeed(fallbackStarted, {
                          scope,
                          tenant: tenant.name,
                          now: yield* Clock.currentTimeMillis,
                          reason: error.reason,
                          setupClosedFirst: failedScope.state._tag === "Closed",
                        });
                        return <p id="fallback-row">{error.reason}</p>;
                      }),
                  );
                }),
            });
            return <section id="parent">{rows}</section>;
          });

        const page = yield* Effect.provideService(
          mountPage(Page, root),
          Tenant,
          Tenant.of({ name: "acme" }),
        );
        yield* Deferred.await(finalizerStarted);
        const whileHeld = yield* Frame.inspect;
        expect(actorByRevision(whileHeld, 3)).toHaveLength(1);
        expect(yield* Deferred.isDone(fallbackStarted)).toBe(false);
        expect(hasAt(root, "#fallback-row")).toBe(false);
        const failedScope = yield* Deferred.await(setupScope);
        expect(failedScope.state._tag).toBe("Closed");

        yield* Deferred.succeed(releaseFinalizer, void 0);
        const started = yield* Deferred.await(fallbackStarted);
        const owner = yield* Deferred.await(rowScope);
        expect(started.setupClosedFirst).toBe(true);
        expect(started.scope).not.toBe(failedScope);
        expect(started.scope).not.toBe(owner);
        expect(started.scope.state._tag).not.toBe("Closed");
        expect(owner.state._tag).toBe("Open");
        expect(started.tenant).toBe("acme");
        expect(started.now).toBe(5_000);
        expect(started.reason).toBe("denied");
        yield* page.waitFor({
          label: "fallback row appears",
          until: (actual) => textAt(actual, "#fallback-row") === "denied",
        });
        const after = yield* Frame.inspect;
        expect(actorByRevision(after, 3)).toHaveLength(0);
        expect(Option.isNone(queryRecord(after, "doomed"))).toBe(true);
      }),
  );

  it.scoped("3. keeps fallback's own typed error as E2 and does not retry", () =>
    Effect.gen(function* () {
      const fallbackClosed = yield* Ref.make(0);
      const setupRuns = yield* Ref.make(0);
      const fallbackRuns = yield* Ref.make(0);
      const owner = yield* Scope.make();
      const exit = yield* Effect.exit(
        View.attempt(
          Effect.andThen(
            Ref.update(setupRuns, (count) => count + 1),
            Effect.fail(SetupFailed.make({ reason: "offline" })),
          ),
          (error) =>
            Effect.gen(function* () {
              yield* Ref.update(fallbackRuns, (count) => count + 1);
              yield* Effect.addFinalizer(() => Ref.update(fallbackClosed, (count) => count + 1));
              return yield* FallbackFailed.make({ reason: `after ${error.reason}` });
            }),
        ).pipe(Scope.provide(owner)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.findErrorOption(exit.cause)).toEqual(
          Option.some(FallbackFailed.make({ reason: "after offline" })),
        );
        expect(Cause.hasDies(exit.cause)).toBe(false);
      }
      expect(yield* Ref.get(setupRuns)).toBe(1);
      expect(yield* Ref.get(fallbackRuns)).toBe(1);
      expect(yield* Ref.get(fallbackClosed)).toBe(1);
      expect(owner.state._tag).not.toBe("Closed");
      expect(typeFixtures.every((fixture) => fixture)).toBe(true);
      expect(negativeFixtures).toHaveLength(7);
      yield* Scope.close(owner, Exit.void);
    }),
  );

  describe("4. defects and interruption", () => {
    const bypassCase = (
      label: string,
      setupFailure: Effect.Effect<never, SetupFailed>,
      check: (cause: Cause.Cause<unknown>) => void,
    ) =>
      it.scoped(label, () =>
        Effect.gen(function* () {
          const fallbackRuns = yield* Ref.make(0);
          const setupClosed = yield* Ref.make(0);
          const owner = yield* Scope.make();
          const exit = yield* Effect.exit(
            View.attempt(
              Effect.andThen(
                Effect.addFinalizer(() => Ref.update(setupClosed, (count) => count + 1)),
                setupFailure,
              ),
              () =>
                Effect.as(
                  Ref.update(fallbackRuns, (count) => count + 1),
                  <p>fallback</p>,
                ),
            ).pipe(Scope.provide(owner)),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            check(exit.cause);
          }
          expect(yield* Ref.get(fallbackRuns)).toBe(0);
          expect(yield* Ref.get(setupClosed)).toBe(1);
          expect(owner.state._tag).not.toBe("Closed");
          yield* Scope.close(owner, Exit.void);
        }),
      );

    bypassCase("bypasses fallback for a setup defect", Effect.die("setup defect"), (cause) => {
      expect(Cause.hasDies(cause)).toBe(true);
      expect(Cause.hasFails(cause)).toBe(false);
    });

    bypassCase("bypasses fallback for setup interruption", Effect.interrupt, (cause) => {
      expect(Cause.hasInterruptsOnly(cause)).toBe(true);
    });

    bypassCase(
      "bypasses fallback when a typed failure is mixed with a defect, without leaking E",
      Effect.failCause(
        Cause.combine(Cause.fail(SetupFailed.make({ reason: "mixed" })), Cause.die("defect")),
      ),
      (cause) => {
        expect(Cause.hasFails(cause)).toBe(false);
        expect(cause.reasons.filter(Cause.isDieReason)).toHaveLength(2);
      },
    );

    it.scoped("propagates a fallback defect once, after closing the fallback child", () =>
      Effect.gen(function* () {
        const fallbackRuns = yield* Ref.make(0);
        const fallbackClosed = yield* Ref.make(0);
        const owner = yield* Scope.make();
        const exit = yield* Effect.exit(
          View.attempt(Effect.fail(SetupFailed.make({ reason: "x" })), () =>
            Effect.gen(function* () {
              yield* Ref.update(fallbackRuns, (count) => count + 1);
              yield* Effect.addFinalizer(() => Ref.update(fallbackClosed, (count) => count + 1));
              return yield* Effect.die("fallback defect");
            }),
          ).pipe(Scope.provide(owner)),
        );
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
        expect(yield* Ref.get(fallbackRuns)).toBe(1);
        expect(yield* Ref.get(fallbackClosed)).toBe(1);
        yield* Scope.close(owner, Exit.void);
      }),
    );

    it.scoped("never starts setup under an owner that has already closed", () =>
      Effect.gen(function* () {
        const setupRuns = yield* Ref.make(0);
        const owner = yield* Scope.make();
        yield* Scope.close(owner, Exit.void);
        const exit = yield* Effect.exit(
          View.attempt(
            Effect.as(
              Ref.update(setupRuns, (count) => count + 1),
              <p>late</p>,
            ),
            () => Effect.succeed(<p>fallback</p>),
          ).pipe(Scope.provide(owner)),
        );
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
        expect(yield* Ref.get(setupRuns)).toBe(0);
      }),
    );

    it.scoped(
      "does not start fallback when the owner closes while the failed child is closing",
      () =>
        Effect.gen(function* () {
          const finalizerStarted = yield* Deferred.make<void>();
          const releaseFinalizer = yield* Deferred.make<void>();
          const fallbackRuns = yield* Ref.make(0);
          const owner = yield* Scope.make();
          // The attempt fiber is not owned by `owner`: only the explicit owner
          // check can refuse fallback here, not interruption.
          const fiber = yield* Effect.forkDetach(
            View.attempt(
              Effect.andThen(
                Effect.addFinalizer(() =>
                  Effect.andThen(
                    Deferred.succeed(finalizerStarted, void 0),
                    Deferred.await(releaseFinalizer),
                  ),
                ),
                Effect.fail(SetupFailed.make({ reason: "held" })),
              ),
              () =>
                Effect.as(
                  Ref.update(fallbackRuns, (count) => count + 1),
                  <p>fallback</p>,
                ),
            ).pipe(Scope.provide(owner)),
          );
          yield* Deferred.await(finalizerStarted);
          yield* Scope.close(owner, Exit.void);
          expect(owner.state._tag).toBe("Closed");
          yield* Deferred.succeed(releaseFinalizer, void 0);
          const exit = yield* Fiber.await(fiber);
          expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
          expect(yield* Ref.get(fallbackRuns)).toBe(0);
        }),
    );

    it.scoped("refuses a setup result that completes after its owner closed", () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const completed = yield* Ref.make(false);
        const owner = yield* Scope.make();
        const fiber = yield* Effect.forkDetach(
          View.attempt(
            Effect.gen(function* () {
              yield* Deferred.succeed(started, void 0);
              yield* Deferred.await(gate);
              yield* Ref.set(completed, true);
              return <p>late</p>;
            }),
            () => Effect.succeed(<p>fallback</p>),
          ).pipe(Scope.provide(owner)),
        );
        yield* Deferred.await(started);
        yield* Scope.close(owner, Exit.void);
        yield* Deferred.succeed(gate, void 0);
        const exit = yield* Fiber.await(fiber);
        expect(yield* Ref.get(completed)).toBe(true);
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      }),
    );

    const suspendedRootClose = (phase: "setup" | "fallback") =>
      it.scoped(`root close during suspended ${phase} prevents a late mount`, () =>
        Effect.gen(function* () {
          const root = yield* makeRoot;
          const started = yield* Deferred.make<void>();
          const gate = yield* Deferred.make<void>();
          const closed = yield* Ref.make(0);
          const resumed = yield* Ref.make(false);
          const suspended = Effect.gen(function* () {
            yield* Effect.addFinalizer(() => Ref.update(closed, (count) => count + 1));
            yield* Deferred.succeed(started, void 0);
            yield* Deferred.await(gate);
            yield* Ref.set(resumed, true);
            return <p id="late">late</p>;
          });
          const rowsSource: Source<ReadonlyArray<string>> = {
            get: Effect.succeed(["row"]),
            changes: Stream.empty,
          };
          const Page = () =>
            Effect.map(
              View.list({
                each: rowsSource,
                keyBy: (id) => id,
                row: () => {
                  if (phase === "setup") {
                    return View.attempt(suspended, () => Effect.succeed(<p id="fallback">f</p>));
                  }
                  return View.attempt(
                    Effect.fail(SetupFailed.make({ reason: "x" })),
                    () => suspended,
                  );
                },
              }),
              (rows) => <section>{rows}</section>,
            );
          const lifetime = yield* Scope.make();
          yield* View.mount(Page, {}, Dom.host, root).pipe(Scope.provide(lifetime));
          yield* Deferred.await(started);
          yield* Scope.close(lifetime, Exit.void);
          expect(yield* Ref.get(closed)).toBe(1);
          yield* Deferred.succeed(gate, void 0);
          yield* View.flush;
          expect(root.childNodes.length).toBe(0);
          expect(yield* Ref.get(resumed)).toBe(false);
          expect(yield* Ref.get(closed)).toBe(1);
        }),
      );

    suspendedRootClose("setup");
    suspendedRootClose("fallback");
  });

  it.scoped.layer(frameLayer("owned-attempt-repeated"))(
    "5. removes each failed row's actors and queries while the parent stays live",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const rowsSource = yield* spawn(Behavior.value<ReadonlyArray<string>>([]));
        const fallbackClosed = yield* Ref.make<ReadonlyMap<string, Deferred.Deferred<void>>>(
          new Map(),
        );
        const heldFinalizerStarted = yield* Deferred.make<void>();
        const releaseHeld = yield* Deferred.make<void>();
        const heldOwnerClosing = yield* Deferred.make<void>();
        const heldAttemptExit = yield* Deferred.make<Exit.Exit<ViewNode, never>>();
        const fallbackStarts = yield* Ref.make<ReadonlyArray<string>>([]);
        const parentSetups = yield* Ref.make(0);
        for (const key of ["r1", "r2", "r3"]) {
          const done = yield* Deferred.make<void>();
          yield* Ref.update(fallbackClosed, (all) => new Map(all).set(key, done));
        }

        const failedRow = (key: string) =>
          View.attempt(
            Effect.gen(function* () {
              yield* spawnAtRevision(5);
              yield* useQuery(AttemptQuery, { id: `setup-${key}` });
              if (key === "held") {
                yield* Effect.addFinalizer(() =>
                  Effect.andThen(
                    Deferred.succeed(heldFinalizerStarted, void 0),
                    Deferred.await(releaseHeld),
                  ),
                );
              }
              return yield* SetupFailed.make({ reason: key });
            }),
            (error) =>
              Effect.gen(function* () {
                const done = Option.fromNullishOr((yield* Ref.get(fallbackClosed)).get(key));
                if (Option.isSome(done)) {
                  yield* Effect.addFinalizer(() => Deferred.succeed(done.value, void 0));
                }
                yield* push(fallbackStarts, key);
                const actor = yield* spawnAtRevision(7);
                yield* useQuery(AttemptQuery, { id: `fallback-${key}` });
                return (
                  <li id={`row-${key}`}>
                    {error.reason}:{View.bind(actor.state, String)}
                  </li>
                );
              }),
          );

        const Page = () =>
          Effect.gen(function* () {
            yield* Ref.update(parentSetups, (count) => count + 1);
            const parent = yield* spawn(Behavior.value("parent"));
            yield* useQuery(AttemptQuery, { id: "parent" });
            const rows = yield* View.list({
              each: rowsSource.state,
              keyBy: (key) => key,
              row: (item) =>
                Effect.flatMap(item.get, (key) => {
                  if (key === "held") {
                    // The row Scope is the attempt owner. This finalizer runs
                    // once that owner has been marked closed.
                    return Effect.flatMap(Effect.scope, (owner) =>
                      Effect.andThen(
                        Scope.addFinalizer(owner, Deferred.succeed(heldOwnerClosing, void 0)),
                        failedRow(key).pipe(
                          Effect.onExit((exit) => Deferred.succeed(heldAttemptExit, exit)),
                        ),
                      ),
                    );
                  }
                  return failedRow(key);
                }),
            });
            return (
              <section id="parent">
                <output id="parent-actor">{View.bind(parent.state)}</output>
                <ul>{rows}</ul>
              </section>
            );
          });

        // The test's own list-source actor is not part of the page.
        const sourceId = onlyId((yield* Frame.inspect).actors);
        const pageActors = (snapshot: Frame.Snapshot) =>
          snapshot.actors.filter((record) => record.id !== sourceId);
        const page = yield* mountPage(Page, root);
        const baseline = yield* Frame.inspect;
        expect(queryIds(baseline)).toHaveLength(1);
        const parentActorId = onlyId(pageActors(baseline));
        const parentQueryId = Option.map(queryRecord(baseline, "parent"), (record) => record.id);

        for (const key of ["r1", "r2", "r3"]) {
          yield* page.act(rowsSource.call(Value.Set([key])), {
            label: `${key} fallback appears`,
            until: (actual) => textAt(actual, `#row-${key}`) === `${key}:7`,
          });
          const live = yield* Frame.inspect;
          const liveActors = pageActors(live);
          expect(liveActors.filter((record) => record.revision === 5)).toHaveLength(0);
          expect(liveActors.filter((record) => record.revision === 7)).toHaveLength(1);
          expect(Option.isNone(queryRecord(live, `setup-${key}`))).toBe(true);
          expect(Option.isSome(queryRecord(live, `fallback-${key}`))).toBe(true);
          expect(liveActors).toHaveLength(2);

          yield* page.act(rowsSource.call(Value.Set([])), {
            label: `${key} leaves`,
            until: (actual) => !hasAt(actual, `#row-${key}`),
          });
          const done = Option.getOrThrow(
            Option.fromNullishOr((yield* Ref.get(fallbackClosed)).get(key)),
          );
          yield* Deferred.await(done);
          const after = yield* Frame.inspect;
          expect(pageActors(after).map((record) => record.id)).toEqual([parentActorId]);
          expect(queryIds(after)).toEqual(queryIds(baseline));
          expect(Option.map(queryRecord(after, "parent"), (record) => record.id)).toEqual(
            parentQueryId,
          );
          expect(after.mounts).toHaveLength(1);
        }
        expect(yield* Ref.get(fallbackStarts)).toEqual(["r1", "r2", "r3"]);

        // Held case: the row leaves while its failed child is still closing.
        yield* rowsSource.call(Value.Set(["held"]));
        yield* Deferred.await(heldFinalizerStarted);
        yield* rowsSource.call(Value.Set([]));
        yield* Deferred.await(heldOwnerClosing);
        expect(yield* Deferred.isDone(heldAttemptExit)).toBe(false);
        yield* Deferred.succeed(releaseHeld, void 0);
        const heldExit = yield* Deferred.await(heldAttemptExit);
        expect(Exit.isFailure(heldExit) && Cause.hasInterruptsOnly(heldExit.cause)).toBe(true);
        expect(yield* Ref.get(fallbackStarts)).toEqual(["r1", "r2", "r3"]);
        yield* View.flush;
        expect(hasAt(root, "#row-held")).toBe(false);
        const afterHeld = yield* Frame.inspect;
        expect(pageActors(afterHeld).map((record) => record.id)).toEqual([parentActorId]);
        expect(queryIds(afterHeld)).toEqual(queryIds(baseline));
        expect(textAt(root, "#parent-actor")).toBe("parent");
        expect(yield* Ref.get(parentSetups)).toBe(1);
      }),
  );

  describe("6. two-level layout and explicit outlet", () => {
    interface ChildRoute {
      readonly id: string;
      readonly tenant: string;
      readonly post: string;
      readonly revision: number;
    }

    /**
     * A fixture-only transition owner. It acquires the entering branch's
     * shared declaration before it replaces the outlet item, then releases
     * the exited declaration. `View.list` alone removes the old row first.
     */
    const makeTransition = Effect.fn("OwnedAttemptTest.makeTransition")(function* (
      initial: ChildRoute,
      overlap: boolean,
    ) {
      const owner = yield* Effect.scope;
      const current = yield* spawn(Behavior.value<ReadonlyArray<ChildRoute>>([initial]));
      const declare = Effect.fn("OwnedAttemptTest.declare")(function* (route: ChildRoute) {
        const declarations = yield* Scope.fork(owner);
        if (overlap) {
          yield* useQuery(AttemptQuery, { id: `tenant-${route.tenant}` }).pipe(
            Scope.provide(declarations),
          );
        }
        return declarations;
      });
      const declared = yield* Ref.make(yield* declare(initial));
      const go = Effect.fn("OwnedAttemptTest.go")(function* (next: ChildRoute) {
        const entering = yield* declare(next);
        yield* Effect.orDie(current.call(Value.Set([next])));
        const exited = yield* Ref.getAndSet(declared, entering);
        yield* Scope.close(exited, Exit.void);
      });
      return { routes: current.state, go };
    });

    type Transition = Effect.Success<ReturnType<typeof makeTransition>>;

    const outletProof = (label: string, overlap: boolean) =>
      it.scoped.layer(frameLayer(`owned-attempt-outlet-${String(overlap)}`))(label, () =>
        Effect.gen(function* () {
          const root = yield* makeRoot;
          const tenantHeld = yield* hold("tenant-t1");
          const post1 = yield* hold("post-1");
          const post2 = yield* hold("post-2");
          const layoutSetups = yield* Ref.make(0);
          const childSetups = yield* Ref.make<ReadonlyArray<string>>([]);
          const childClosed = yield* Deferred.make<void>();
          const childFailed = yield* Deferred.make<void>();
          const transitionReady = yield* Deferred.make<Transition>();

          const child = (item: Source<ChildRoute>) =>
            View.attempt(
              Effect.gen(function* () {
                const route = yield* item.get;
                if (route.id === "a") {
                  yield* Effect.addFinalizer(() => Deferred.succeed(childClosed, void 0));
                }
                yield* push(childSetups, route.id);
                yield* spawnAtRevision(route.revision);
                if (route.post === "missing") {
                  return yield* SetupFailed.make({ reason: "missing" });
                }
                const tenant = yield* useQuery(AttemptQuery, { id: `tenant-${route.tenant}` });
                const post = yield* useQuery(AttemptQuery, { id: `post-${route.post}` });
                const tenantName = yield* View.ready(tenant.state, "");
                const title = yield* View.ready(post.state, "");
                return (
                  <article id={`child-${route.id}`}>
                    <h2>{View.bind(title)}</h2>
                    <p class="tenant">{View.bind(tenantName)}</p>
                  </article>
                );
              }),
              (error) =>
                Effect.as(
                  Deferred.succeed(childFailed, void 0),
                  <p id="child-failed">{error.reason}</p>,
                ),
            );

          const Layout = <ChildR,>(props: {
            readonly outlet: Effect.Effect<ViewNode, never, ChildR>;
          }) =>
            Effect.gen(function* () {
              yield* Ref.update(layoutSetups, (count) => count + 1);
              const local = yield* spawnAtRevision(30);
              const body = yield* View.loading({
                fallback: <p id="child-loading">loading child</p>,
                content: Effect.map(props.outlet, (outlet) => <div id="outlet">{outlet}</div>),
              });
              return (
                <section id="layout">
                  <output id="layout-actor">{View.bind(local.state, String)}</output>
                  {body}
                </section>
              );
            });

          const Page = () =>
            Effect.gen(function* () {
              const transition = yield* makeTransition(
                { id: "a", tenant: "t1", post: "1", revision: 11 },
                overlap,
              );
              yield* Deferred.succeed(transitionReady, transition);
              return yield* Layout({
                outlet: View.list({
                  each: transition.routes,
                  keyBy: (route) => route.id,
                  row: child,
                }),
              });
            });

          const page = yield* mountPage(Page, root);
          const transition = yield* Deferred.await(transitionReady);
          yield* Deferred.await(post1.started);
          yield* Deferred.await(tenantHeld.started);
          yield* page.waitFor({
            label: "layout fallback while the child's held query runs",
            until: (actual) =>
              textAt(actual, "#child-loading") === "loading child" &&
              !hasAt(actual, "#child-a") &&
              textAt(actual, "#layout-actor") === "30",
          });
          expect(yield* Ref.get(childSetups)).toEqual(["a"]);
          const layoutElement = root.querySelector("#layout");
          const started = yield* Frame.inspect;
          const layoutActorId = onlyId(actorByRevision(started, 30));
          expect(actorByRevision(started, 11)).toHaveLength(1);
          const tenantQueryId = Option.map(
            queryRecord(started, "tenant-t1"),
            (record) => record.id,
          );

          yield* Deferred.succeed(tenantHeld.gate, void 0);
          yield* Deferred.succeed(post1.gate, void 0);
          yield* page.waitFor({
            label: "child a content visible",
            until: (actual) =>
              textAt(actual, "#child-a h2") === "value:post-1" &&
              textAt(actual, "#child-a .tenant") === "value:tenant-t1" &&
              !hasAt(actual, "#child-loading"),
          });
          const outletElement = root.querySelector("#outlet");

          yield* transition.go({ id: "b", tenant: "t1", post: "2", revision: 12 });
          yield* Deferred.await(post2.started);
          yield* Deferred.await(childClosed);
          yield* page.waitFor({
            label: "replacement child pending under the retained layout",
            until: (actual) => hasAt(actual, "#child-loading") && !hasAt(actual, "#child-a"),
          });
          yield* Deferred.succeed(post2.gate, void 0);
          yield* page.waitFor({
            label: "child b content visible",
            until: (actual) =>
              textAt(actual, "#child-b h2") === "value:post-2" &&
              textAt(actual, "#child-b .tenant") === "value:tenant-t1",
          });

          const replaced = yield* Frame.inspect;
          expect(root.querySelector("#layout")).toBe(layoutElement);
          expect(root.querySelector("#outlet")).toBe(outletElement);
          expect(yield* Ref.get(layoutSetups)).toBe(1);
          expect(yield* Ref.get(childSetups)).toEqual(["a", "b"]);
          expect(replaced.actors.some((record) => record.id === layoutActorId)).toBe(true);
          expect(actorByRevision(replaced, 11)).toHaveLength(0);
          expect(actorByRevision(replaced, 12)).toHaveLength(1);
          expect(Option.isNone(queryRecord(replaced, "post-1"))).toBe(true);
          expect(yield* callsOf("post-1")).toBe(1);
          expect(yield* callsOf("post-2")).toBe(1);
          if (overlap) {
            expect(yield* callsOf("tenant-t1")).toBe(1);
            expect(Option.map(queryRecord(replaced, "tenant-t1"), (record) => record.id)).toEqual(
              tenantQueryId,
            );
          } else {
            expect(yield* callsOf("tenant-t1")).toBe(2);
            expect(
              Option.map(queryRecord(replaced, "tenant-t1"), (record) => record.id),
            ).not.toEqual(tenantQueryId);
          }

          // A typed child failure runs its fallback inside the outlet row.
          // No registration remains under the layout Loading, so it has
          // nothing to wait for and shows the failure.
          yield* transition.go({ id: "c", tenant: "t1", post: "missing", revision: 13 });
          yield* Deferred.await(childFailed);
          yield* page.waitFor({
            label: "failed child fallback shows under an empty Loading",
            until: (actual) =>
              !hasAt(actual, "#child-loading") &&
              !hasAt(actual, "#child-b") &&
              hasAt(actual, "#child-failed"),
          });
          expect(root.querySelector("#layout")).toBe(layoutElement);
          expect(yield* Ref.get(layoutSetups)).toBe(1);
          expect(yield* Ref.get(childSetups)).toEqual(["a", "b", "c"]);
          const failedChild = yield* Frame.inspect;
          expect(actorByRevision(failedChild, 12)).toHaveLength(0);
          expect(actorByRevision(failedChild, 13)).toHaveLength(0);

          yield* page.close;
          const closed = yield* Frame.inspect;
          expect(closed.actors).toHaveLength(0);
          expect(closed.mounts).toHaveLength(0);
          expect(closed.queries).toHaveLength(0);
        }),
      );

    outletProof(
      "starts an unseeded child under the layout fallback and overlaps the shared key",
      true,
    );
    outletProof(
      "control: without entering-first declarations the shared key is fetched again",
      false,
    );
  });

  describe("7. host timing and existing boundaries", () => {
    it.scoped("serializes a truthful first HTML frame for immediate and delayed setup", () =>
      Effect.gen(function* () {
        const succeeded = yield* Html.renderToString(
          () => View.attempt(Effect.succeed(<p id="ok">ok</p>), () => Effect.succeed(<p>no</p>)),
          {},
        );
        expect(succeeded).toBe('<p id="ok">ok</p>');
        const recovered = yield* Html.renderToString(
          () =>
            View.attempt(Effect.fail(SetupFailed.make({ reason: "denied" })), (error) =>
              Effect.succeed(<p id="fallback">{error.reason}</p>),
            ),
          {},
        );
        expect(recovered).toBe('<p id="fallback">denied</p>');

        const started = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const finalized = yield* Ref.make(0);
        const delayed = yield* Html.renderToString(
          () =>
            Effect.map(
              View.list({
                each: { get: Effect.succeed(["late"]), changes: Stream.empty },
                keyBy: (id: string) => id,
                row: () =>
                  View.attempt(
                    Effect.gen(function* () {
                      yield* Effect.addFinalizer(() => Ref.update(finalized, (count) => count + 1));
                      yield* Deferred.succeed(started, void 0);
                      yield* Deferred.await(gate);
                      return <li id="late">late</li>;
                    }),
                    () => Effect.succeed(<li>fallback</li>),
                  ),
              }),
              (rows) => <ul>{rows}</ul>,
            ),
          {},
        );
        expect(delayed).toBe("<ul></ul>");
        expect(yield* Deferred.isDone(started)).toBe(true);
        expect(yield* Ref.get(finalized)).toBe(1);
      }),
    );

    it.scoped("runs attachments only after a delayed setup or fallback node is inserted", () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const log: Array<string> = [];
        const lateStarted = yield* Deferred.make<void>();
        const lateGate = yield* Deferred.make<void>();
        const failStarted = yield* Deferred.make<void>();
        const failGate = yield* Deferred.make<void>();
        const attached = (id: string) =>
          Dom.attach((element) =>
            Effect.sync(() => {
              log.push(
                `${id}:${String(element.isConnected)}:${String(Option.isSome(Option.fromNullishOr(element.parentElement)))}`,
              );
            }),
          );
        const Page = () =>
          Effect.map(
            View.list({
              each: { get: Effect.succeed(["late", "failed"]), changes: Stream.empty },
              keyBy: (id: string) => id,
              row: (item) =>
                Effect.flatMap(item.get, (id) =>
                  View.attempt(
                    Effect.gen(function* () {
                      if (id === "late") {
                        yield* Deferred.succeed(lateStarted, void 0);
                        yield* Deferred.await(lateGate);
                        return (
                          <li id="late" attach={attached("late")}>
                            late
                          </li>
                        );
                      }
                      yield* Deferred.succeed(failStarted, void 0);
                      yield* Deferred.await(failGate);
                      return yield* SetupFailed.make({ reason: "failed" });
                    }),
                    (error) =>
                      Effect.succeed(
                        <li id="recovered" attach={attached("recovered")}>
                          {error.reason}
                        </li>,
                      ),
                  ),
                ),
            }),
            (rows) => <ul>{rows}</ul>,
          );
        const page = yield* mountPage(Page, root);
        yield* Deferred.await(lateStarted);
        yield* Deferred.await(failStarted);
        yield* View.flush;
        expect(log).toEqual([]);
        expect(hasAt(root, "li")).toBe(false);

        yield* page.act(Deferred.succeed(lateGate, void 0), {
          label: "late setup node inserted",
          until: (actual) => hasAt(actual, "#late"),
        });
        yield* page.act(Deferred.succeed(failGate, void 0), {
          label: "fallback node inserted",
          until: (actual) => textAt(actual, "#recovered") === "failed",
        });
        yield* page.waitFor({
          label: "both attachments ran",
          until: () => log.length === 2,
        });
        expect(log.toSorted()).toEqual(["late:true:true", "recovered:true:true"]);
        yield* page.close;
      }),
    );

    it.scoped("keeps ordinary Show destructive; the attempt stays owned by its caller", () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const visible = yield* spawn(Behavior.value(true));
        const setups = yield* Ref.make(0);
        const closed = yield* Ref.make(0);
        const childScope = yield* Deferred.make<Scope.Scope>();
        const Page = () =>
          Effect.gen(function* () {
            const node = yield* View.attempt(
              Effect.gen(function* () {
                yield* Ref.update(setups, (count) => count + 1);
                yield* Deferred.succeed(childScope, yield* Effect.scope);
                yield* Effect.addFinalizer(() => Ref.update(closed, (count) => count + 1));
                return <p id="owned">owned</p>;
              }),
              () => Effect.succeed(<p>fallback</p>),
            );
            return (
              <Show when={visible.state} fallback={<p id="hidden">hidden</p>}>
                {node}
              </Show>
            );
          });
        const page = yield* mountPage(Page, root);
        yield* page.waitFor({ label: "shown", until: (actual) => hasAt(actual, "#owned") });
        const first = root.querySelector("#owned");
        yield* page.act(visible.call(Value.Set(false)), {
          label: "hidden",
          until: (actual) => hasAt(actual, "#hidden") && !hasAt(actual, "#owned"),
        });
        const scope = yield* Deferred.await(childScope);
        expect(scope.state._tag).not.toBe("Closed");
        expect(yield* Ref.get(closed)).toBe(0);
        yield* page.act(visible.call(Value.Set(true)), {
          label: "shown again",
          until: (actual) => hasAt(actual, "#owned"),
        });
        expect(root.querySelector("#owned")).not.toBe(first);
        expect(yield* Ref.get(setups)).toBe(1);
        yield* page.close;
        expect(scope.state._tag).toBe("Closed");
        expect(yield* Ref.get(closed)).toBe(1);
      }),
    );

    it.scoped("adds no readiness registration: an empty Loading shows its content", () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const settled: Source<{
          readonly _tag: "Ready";
          readonly value: string;
          readonly stale: false;
        }> = {
          get: Effect.succeed({ _tag: "Ready", value: "ready", stale: false }),
          changes: Stream.empty,
        };
        const setups = yield* Ref.make(0);
        const owned = View.attempt(
          Effect.as(
            Ref.update(setups, (count) => count + 1),
            <p id="content">content</p>,
          ),
          () => Effect.succeed(<p>fallback</p>),
        );
        const Empty = () =>
          View.loading({ fallback: <p id="fallback">loading</p>, content: owned });
        const page = yield* mountPage(Empty, root);
        yield* View.flush;
        expect(hasAt(root, "#fallback")).toBe(false);
        expect(hasAt(root, "#content")).toBe(true);
        expect(yield* Ref.get(setups)).toBe(1);
        yield* page.close;

        const Registered = () =>
          View.loading({
            fallback: <p id="fallback">loading</p>,
            content: Effect.andThen(View.ready(settled, ""), owned),
          });
        const second = yield* mountPage(Registered, root);
        yield* second.waitFor({
          label: "one settled registration reveals content",
          until: (actual) => hasAt(actual, "#content") && !hasAt(actual, "#fallback"),
        });
        expect(yield* Ref.get(setups)).toBe(2);
      }),
    );
  });
});
