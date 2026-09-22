import {
  Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Schema,
  Scheduler,
  Scope,
  Stream,
} from "effect";
import { describe, expect, it } from "effect-bun-test";
import { Event, Machine, State } from "effect-machine";
import { Behavior, Cell, implementQuery, query, spawn, useQuery } from "effect-frame/actor";
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

let concurrentReads = 0;
let failedReads = 0;

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

  it.scoped.layer(
    QueryTest.layer({
      queries: [
        implementQuery(Blocked, () =>
          Effect.gen(function* () {
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
      const control = yield* InspectionControl;
      const firstScope = yield* Scope.make();
      const secondScope = yield* Scope.make();

      yield* Scope.provide(useQuery(Blocked, { id: 1 }), firstScope);
      yield* Deferred.await(control.started);
      let snapshot = yield* Frame.inspect;
      expect(snapshot.queries).toHaveLength(1);
      expect(snapshot.queries[0]?.state).toBe("Loading");

      yield* Scope.provide(useQuery(Blocked, { id: 1 }), secondScope);
      snapshot = yield* Frame.inspect;
      expect(snapshot.queries).toHaveLength(1);

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
