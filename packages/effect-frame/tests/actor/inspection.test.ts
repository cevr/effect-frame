import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schema,
  Scheduler,
  Scope,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "effect-bun-test";
import { Event, Machine, State } from "effect-machine";
import {
  Behavior,
  Cell,
  CommandId,
  MailboxStore,
  contract,
  durable,
  implementQuery,
  query,
  spawn,
  useQuery,
} from "effect-frame/actor";
import { QueryCache } from "effect-frame/actor/client";
import { QueryTest } from "effect-frame/actor/testing";
import * as Frame from "../../src/frame.js";

class InspectionControl extends Context.Service<
  InspectionControl,
  {
    readonly gate: Deferred.Deferred<void>;
    readonly started: Deferred.Deferred<void>;
  }
>()("effect-frame/tests/actor/inspection.test/InspectionControl") {}

const StepState = State({ Start: {}, End: {} });
const StepEvent = Event({ Go: {} });
const stepMachine = Machine.make({
  state: StepState,
  event: StepEvent,
  initial: StepState.Start,
}).on(StepState.Start, StepEvent.Go, () => StepState.End);

const AutonomousState = State({ Start: {}, Running: {}, Done: {} });
const AutonomousEvent = Event({ Begin: {}, Finish: {} });
const autonomousMachine = Machine.make({
  state: AutonomousState,
  event: AutonomousEvent,
  initial: AutonomousState.Start,
})
  .on(AutonomousState.Start, AutonomousEvent.Begin, () => AutonomousState.Running)
  .on(AutonomousState.Running, AutonomousEvent.Finish, () => AutonomousState.Done)
  .task(AutonomousState.Running, () => Effect.void, {
    onSuccess: () => AutonomousEvent.Finish,
    onFailure: () => AutonomousEvent.Finish,
  });

const DurableAdd = Schema.Struct({ amount: Schema.Finite });
type DurableAdd = Schema.Schema.Type<typeof DurableAdd>;
const durableOptions = {
  behavior: Behavior.reducer<number, DurableAdd>({
    initial: 0,
    reduce: (state, message) => state + message.amount,
  }),
  state: Schema.fromJsonString(Schema.Finite),
  message: Schema.fromJsonString(DurableAdd),
};

const Blocked = query("InspectionBlocked", {
  args: Schema.Struct({ id: Schema.Finite }),
  result: Schema.Struct({ value: Schema.String }),
});

const Concurrent = query("InspectionConcurrent", {
  args: Schema.Struct({ id: Schema.Finite }),
  result: Schema.Finite,
});

const Failed = query("InspectionFailed", {
  args: Schema.Struct({ id: Schema.Finite }),
  result: Schema.Finite,
});

const InspectionSource = contract("InspectionSource", {
  version: 1,
  key: Schema.Struct({ id: Schema.Finite }),
  snapshot: Schema.Finite,
  message: Schema.Struct({}),
});

const Lifecycle = query("InspectionLifecycle", {
  args: Schema.Struct({ id: Schema.Finite }),
  result: Schema.Struct({ value: Schema.Finite }),
  depends: [InspectionSource],
});

const SameRootQuery = query("SameRootQuery", {
  args: Schema.Struct({ id: Schema.Finite }),
  result: Schema.Finite,
});

let concurrentReads = 0;
let failedReads = 0;
let blockedReads = 0;
let lifecycleValue = 1;
const inspectionCommandId = Schema.decodeSync(CommandId)("inspection-durable-1");
const inspectionTimeoutCommandId = Schema.decodeSync(CommandId)("inspection-timeout");

const makeFrame = (name: string) => Frame.layer({ name });

describe("Frame.inspect actor and query records", () => {
  it.scoped.layer(makeFrame("actors"))("samples local actors from applied memory", () =>
    Effect.gen(function* () {
      const cell = yield* Cell.make(0);
      const reducer = yield* spawn(
        Behavior.reducer<number, { readonly _tag: "Increment" }>({
          initial: 0,
          reduce: (state) => state + 1,
        }),
      );
      const machine = yield* spawn(Behavior.machine(stepMachine));

      const initial = yield* Frame.inspect;
      expect(initial.actors).toHaveLength(3);
      expect(initial.actors.every((actor) => actor.kind === "local")).toBe(true);
      expect(initial.actors.map((actor) => actor.revision).sort()).toEqual([0, 0, 0]);

      yield* cell.set(1);
      yield* reducer.call({ _tag: "Increment" });
      yield* machine.call(StepEvent.Go);

      const changed = yield* Frame.inspect;
      expect(changed.actors.map((actor) => actor.revision).sort()).toEqual([1, 1, 1]);

      const child = yield* Scope.make();
      yield* spawn(Behavior.value("owned")).pipe(Scope.provide(child));
      expect((yield* Frame.inspect).actors).toHaveLength(4);
      yield* Scope.close(child, Exit.void);
      expect((yield* Frame.inspect).actors).toHaveLength(3);
    }),
  );

  it.scoped.layer(makeFrame("autonomous"))("samples autonomous machine revisions", () =>
    Effect.gen(function* () {
      const machine = yield* spawn(Behavior.machine(autonomousMachine));
      yield* machine.call(AutonomousEvent.Begin);
      yield* Stream.runHead(Stream.filter(machine.state.changes, (state) => state._tag === "Done"));
      const snapshot = yield* Frame.inspect;
      expect(snapshot.actors).toHaveLength(1);
      expect(snapshot.actors[0]?.kind).toBe("local");
      expect(snapshot.actors[0]?.revision).toBeGreaterThan(0);
    }),
  );

  it.scoped.layer(makeFrame("blocked-actor"))(
    "samples a blocked actor without starting more work",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let setupCalls = 0;
        let commandCalls = 0;
        const actor = yield* spawn({
          initial: 0,
          open: () =>
            Effect.sync(() => {
              setupCalls += 1;
              return {
                apply: () =>
                  Effect.gen(function* () {
                    commandCalls += 1;
                    yield* Deferred.succeed(started, void 0);
                    yield* Deferred.await(release);
                    return 1;
                  }),
                changes: Stream.empty,
              };
            }),
        });
        const waiting = yield* Effect.forkScoped(actor.call({}));
        yield* Deferred.await(started);
        const before = yield* Frame.inspect;
        expect(setupCalls).toBe(1);
        expect(commandCalls).toBe(1);
        expect(before.actors[0]?.revision).toBe(0);
        const during = yield* Frame.inspect;
        expect(setupCalls).toBe(1);
        expect(commandCalls).toBe(1);
        expect(during.actors[0]?.revision).toBe(0);
        yield* Deferred.succeed(release, void 0);
        yield* Fiber.join(waiting);
        expect((yield* Frame.inspect).actors[0]?.revision).toBe(1);
      }),
  );

  it.scoped.layer(Layer.merge(makeFrame("durable"), MailboxStore.layerMemory))(
    "samples durable wrapper revisions from applied memory",
    () =>
      Effect.gen(function* () {
        const actor = yield* durable(durableOptions);
        const initial = yield* Frame.inspect;
        expect(initial.actors).toEqual([expect.objectContaining({ kind: "durable", revision: 0 })]);

        yield* actor.call({ amount: 3 }, { commandId: inspectionCommandId, timeout: "1 second" });
        const changed = yield* Frame.inspect;
        expect(changed.actors).toEqual([expect.objectContaining({ kind: "durable", revision: 1 })]);
      }),
  );

  it.scoped.layer(Layer.merge(makeFrame("durable-pending"), MailboxStore.layerMemory))(
    "reports commands unavailable while a timed-out durable command still runs",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let applyCalls = 0;
        const slowBehavior: Behavior.Behavior<number, DurableAdd> = {
          initial: 0,
          open: () =>
            Effect.succeed({
              apply: () =>
                Effect.gen(function* () {
                  applyCalls += 1;
                  yield* Deferred.succeed(started, void 0);
                  yield* Deferred.await(release);
                  return 1;
                }),
              changes: Stream.empty,
            }),
        };
        const actor = yield* durable({ ...durableOptions, behavior: slowBehavior });
        const waiting = yield* Effect.forkScoped(
          Effect.exit(
            actor.call(
              { amount: 1 },
              { commandId: inspectionTimeoutCommandId, timeout: "1 second" },
            ),
          ),
        );
        yield* Deferred.await(started);
        yield* TestClock.adjust("1 second");

        const snapshot = yield* Frame.inspect;
        expect(applyCalls).toBe(1);
        expect(snapshot.commands).toEqual({
          _tag: "Unavailable",
          reason: "ClientCommandLifecycleNotImplemented",
        });
        expect(snapshot.actors[0]?.revision).toBe(0);

        yield* Deferred.succeed(release, void 0);
        const outcome = yield* Fiber.join(waiting);
        expect(Exit.isFailure(outcome)).toBe(true);
      }),
  );

  it.scoped("keeps roots and registries independent", () =>
    Effect.gen(function* () {
      const inspectRoot = (name: string, value: number) =>
        Effect.gen(function* () {
          const context = yield* Layer.build(makeFrame(name));
          return yield* Effect.provideContext(
            Effect.gen(function* () {
              yield* spawn(Behavior.value(value));
              return yield* Frame.inspect;
            }),
            context,
          );
        });

      const first = yield* inspectRoot("first", 1);
      const second = yield* inspectRoot("second", 2);
      expect(first.root.id).not.toBe(second.root.id);
      expect(first.actors).toHaveLength(1);
      expect(second.actors).toHaveLength(1);
      expect(first.actors[0]?.id).not.toBe(second.actors[0]?.id);
    }),
  );

  it.scoped("keeps identical actor and query names independent after one root closes", () =>
    Effect.gen(function* () {
      const rootLayer = QueryTest.layer({
        queries: [implementQuery(SameRootQuery, () => Effect.succeed(1))],
      }).pipe(Layer.provideMerge(makeFrame("same-root")));
      const openRoot = Effect.gen(function* () {
        const rootScope = yield* Scope.make();
        const context = yield* Scope.provide(Layer.build(rootLayer), rootScope);
        yield* Scope.provide(Effect.provideContext(spawn(Behavior.value(1)), context), rootScope);
        const consumerScope = yield* Scope.make();
        const queryEntry = yield* Scope.provide(
          Effect.provideContext(useQuery(SameRootQuery, { id: 1 }), context),
          consumerScope,
        );
        yield* Stream.runHead(
          Stream.filter(queryEntry.state.changes, (state) => state._tag === "Ready"),
        );
        return { context, consumerScope, queryEntry, rootScope };
      });

      const first = yield* openRoot;
      const second = yield* openRoot;
      const firstSnapshot = yield* Effect.provideContext(Frame.inspect, first.context);
      const secondSnapshot = yield* Effect.provideContext(Frame.inspect, second.context);
      expect(firstSnapshot.root.name).toBe("same-root");
      expect(secondSnapshot.root.name).toBe("same-root");
      expect(firstSnapshot.root.id).not.toBe(secondSnapshot.root.id);
      expect(firstSnapshot.actors).toHaveLength(1);
      expect(secondSnapshot.actors).toHaveLength(1);
      expect(firstSnapshot.queries[0]?.key).toBe(secondSnapshot.queries[0]?.key);
      expect(firstSnapshot.queries[0]?.id).not.toBe(secondSnapshot.queries[0]?.id);

      yield* Scope.close(first.rootScope, Exit.void);
      expect(yield* first.queryEntry.state.get).toEqual({
        _tag: "Ready",
        value: 1,
        stale: false,
      });
      const secondAfterClose = yield* Effect.provideContext(Frame.inspect, second.context);
      expect(secondAfterClose.root.id).toBe(secondSnapshot.root.id);
      expect(secondAfterClose.actors).toHaveLength(1);
      expect(secondAfterClose.queries).toHaveLength(1);

      yield* Scope.close(first.consumerScope, Exit.void);
      yield* Scope.close(second.consumerScope, Exit.void);
      yield* Scope.close(second.rootScope, Exit.void);
    }),
  );

  it.scoped.layer(
    QueryTest.layer({
      queries: [
        implementQuery(Blocked, () =>
          Effect.gen(function* () {
            blockedReads += 1;
            const control = yield* InspectionControl;
            yield* Deferred.succeed(control.started, void 0);
            yield* Deferred.await(control.gate);
            return { value: "ready" };
          }),
        ),
        implementQuery(Concurrent, () =>
          Effect.sync(() => {
            concurrentReads += 1;
            return 1;
          }),
        ),
      ],
    }).pipe(
      Layer.provideMerge(makeFrame("queries")),
      Layer.provideMerge(
        Layer.effect(
          InspectionControl,
          Effect.map(
            Effect.all({
              gate: Deferred.make<void>(),
              started: Deferred.make<void>(),
            }),
            InspectionControl.of,
          ),
        ),
      ),
    ),
  )("samples a blocked query without invoking inspection work", () =>
    Effect.gen(function* () {
      blockedReads = 0;
      const control = yield* InspectionControl;
      const firstScope = yield* Scope.make();
      const secondScope = yield* Scope.make();

      yield* Scope.provide(useQuery(Blocked, { id: 1 }), firstScope);
      yield* Deferred.await(control.started);
      expect(blockedReads).toBe(1);
      let snapshot = yield* Frame.inspect;
      expect(snapshot.queries).toHaveLength(1);
      expect(snapshot.queries[0]?.state).toBe("Loading");

      yield* Scope.provide(useQuery(Blocked, { id: 1 }), secondScope);
      snapshot = yield* Frame.inspect;
      expect(snapshot.queries).toHaveLength(1);
      expect(blockedReads).toBe(1);

      yield* Scope.close(firstScope, Exit.void);
      expect((yield* Frame.inspect).queries).toHaveLength(1);
      yield* Scope.close(secondScope, Exit.void);
      expect((yield* Frame.inspect).queries).toHaveLength(0);
    }),
  );

  it.scoped.layer(
    QueryTest.layer({
      queries: [
        implementQuery(Failed, () =>
          Effect.sync(() => {
            failedReads += 1;
            return Effect.fail("inspection failure");
          }).pipe(Effect.flatten),
        ),
      ],
    }).pipe(Layer.provideMerge(makeFrame("query-failure"))),
  )("samples failure, removes the owner, and reacquires a fresh slot", () =>
    Effect.gen(function* () {
      failedReads = 0;
      const firstScope = yield* Scope.make();
      const first = yield* Scope.provide(useQuery(Failed, { id: 1 }), firstScope);
      yield* Stream.runHead(Stream.filter(first.state.changes, (state) => state._tag === "Failed"));

      const failed = yield* Frame.inspect;
      expect(failed.queries).toHaveLength(1);
      expect(failed.queries[0]?.state).toBe("Failed");
      const firstId = failed.queries[0]?.id;

      yield* Scope.close(firstScope, Exit.void);
      expect((yield* Frame.inspect).queries).toHaveLength(0);

      const secondScope = yield* Scope.make();
      const second = yield* Scope.provide(useQuery(Failed, { id: 1 }), secondScope);
      yield* Stream.runHead(
        Stream.filter(second.state.changes, (state) => state._tag === "Failed"),
      );
      const reacquired = yield* Frame.inspect;
      expect(reacquired.queries).toHaveLength(1);
      expect(reacquired.queries[0]?.id).not.toBe(firstId);
      expect(failedReads).toBe(2);
      yield* Scope.close(secondScope, Exit.void);
    }),
  );

  it.scoped.layer(
    QueryTest.layer({
      queries: [implementQuery(Lifecycle, () => Effect.succeed({ value: lifecycleValue }))],
    }).pipe(
      Layer.provideMerge(TestClock.layer()),
      Layer.provideMerge(makeFrame("query-lifecycle")),
    ),
  )("samples query state, encoded values, and age without resetting entry time", () =>
    Effect.gen(function* () {
      lifecycleValue = 1;
      const scope = yield* Scope.make();
      const entry = yield* Scope.provide(useQuery(Lifecycle, { id: 1 }), scope);
      yield* Stream.runHead(Stream.filter(entry.state.changes, (state) => state._tag === "Ready"));

      const ready = yield* Frame.inspect;
      expect(ready.queries[0]?.state).toBe("Ready");
      expect(ready.queries[0]?.value).toEqual({
        _tag: "Encoded",
        encoding: "json",
        value: '{"value":1}',
      });
      expect(ready.queries[0]?.stale).toBe(false);
      expect(ready.queries[0]?.ageMs).toBeLessThan(1);

      yield* TestClock.adjust("1 second");
      expect((yield* Frame.inspect).queries[0]?.ageMs).toBe(1_000);

      yield* entry.override({ value: 2 });
      const overridden = yield* Frame.inspect;
      expect(overridden.queries[0]?.state).toBe("Ready");
      expect(overridden.queries[0]?.stale).toBe(true);
      expect(overridden.queries[0]?.value).toEqual({
        _tag: "Encoded",
        encoding: "json",
        value: '{"value":2}',
      });
      expect(overridden.queries[0]?.ageMs).toBe(1_000);

      lifecycleValue = 3;
      yield* entry.refresh;
      const refreshed = yield* Frame.inspect;
      expect(refreshed.queries[0]?.state).toBe("Ready");
      expect(refreshed.queries[0]?.stale).toBe(false);
      expect(refreshed.queries[0]?.value).toEqual({
        _tag: "Encoded",
        encoding: "json",
        value: '{"value":3}',
      });
      expect(refreshed.queries[0]?.ageMs).toBe(1_000);

      const cache = yield* QueryCache;
      yield* cache.invalidate(InspectionSource.name);
      const invalidated = yield* Frame.inspect;
      expect(invalidated.queries[0]?.state).toBe("Ready");
      expect(invalidated.queries[0]?.stale).toBe(true);
      expect(invalidated.queries[0]?.value).toEqual({
        _tag: "Encoded",
        encoding: "json",
        value: '{"value":3}',
      });
      expect(invalidated.queries[0]?.ageMs).toBe(1_000);

      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.scoped.layer(
    QueryTest.layer({
      queries: [
        implementQuery(Concurrent, () =>
          Effect.sync(() => {
            concurrentReads += 1;
            return 1;
          }),
        ),
      ],
    }).pipe(Layer.provideMerge(makeFrame("query-ownership"))),
  )("deduplicates concurrent first declarations and releases the RcMap entry", () =>
    Effect.gen(function* () {
      concurrentReads = 0;
      const scopes = yield* Effect.forEach(Array.from({ length: 10 }), () => Scope.make());
      const entries = yield* Effect.provideService(
        Effect.forEach(scopes, (scope) => Scope.provide(useQuery(Concurrent, { id: 1 }), scope), {
          concurrency: 10,
        }),
        Scheduler.MaxOpsBeforeYield,
        32,
      );

      yield* Effect.forEach(
        entries,
        (entry) =>
          Stream.runHead(Stream.filter(entry.state.changes, (state) => state._tag !== "Loading")),
        { concurrency: 10, discard: true },
      );
      expect(concurrentReads).toBe(1);
      expect((yield* Frame.inspect).queries).toHaveLength(1);

      yield* Scope.close(Option.getOrThrow(Option.fromNullishOr(scopes[0])), Exit.void);
      expect((yield* Frame.inspect).queries).toHaveLength(1);
      yield* Effect.forEach(scopes.slice(1), (scope) => Scope.close(scope, Exit.void), {
        discard: true,
      });
      expect((yield* Frame.inspect).queries).toHaveLength(0);
    }),
  );
});
