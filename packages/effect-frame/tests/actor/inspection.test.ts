import { Context, Deferred, Effect, Exit, Layer, Schema, Scope } from "effect";
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
});
