import { Effect, Exit, Fiber, Option, Schema, Scope, Stream } from "effect";
import { describe, expect, it, yieldFibers } from "effect-bun-test";
import { Event, Machine, State } from "effect-machine";
import { Behavior, Value, modify, select, spawn, zip } from "effect-frame/actor";

const CounterState = State({
  Counting: { count: Schema.Finite },
});

const CounterEvent = Event({
  Increment: {},
  Reset: {},
});

const counterMachine = Machine.make({
  state: CounterState,
  event: CounterEvent,
  initial: CounterState.Counting({ count: 0 }),
})
  .on(CounterState.Counting, CounterEvent.Increment, ({ state }) =>
    CounterState.Counting({ count: state.count + 1 }),
  )
  .on(CounterState.Counting, CounterEvent.Reset, () => CounterState.Counting({ count: 0 }));

// A machine that moves on its own: Middle runs a task whose completion
// advances to End with no external message.
const StepState = State({ Start: {}, Middle: {}, End: {} });
const StepEvent = Event({ Go: {}, Advance: {} });
const stepMachine = Machine.make({
  state: StepState,
  event: StepEvent,
  initial: StepState.Start,
})
  .on(StepState.Start, StepEvent.Go, () => StepState.Middle)
  .on(StepState.Middle, StepEvent.Advance, () => StepState.End)
  .task(StepState.Middle, () => Effect.void, {
    onSuccess: () => StepEvent.Advance,
    onFailure: () => StepEvent.Advance,
  });

interface Append {
  readonly _tag: "Append";
  readonly item: string;
}

const listBehavior = Behavior.reducer<ReadonlyArray<string>, Append>({
  initial: [],
  reduce: (state, message) => [...state, message.item],
});

describe("local actor", () => {
  it.scoped("simple state replaces its value through Set", () =>
    Effect.gen(function* () {
      const count = yield* spawn(Behavior.value(0));
      const applied = yield* count.call(Value.Set(10));
      expect(applied).toEqual({ revision: 1, state: 10 });
      expect(yield* count.state.get).toBe(10);
    }),
  );

  it.scoped("modify computes the Set inside the turn, so concurrent updates never lose one", () =>
    Effect.gen(function* () {
      const count = yield* spawn(Behavior.value(0));
      yield* Effect.forEach(
        Array.from({ length: 50 }, (_, index) => index),
        () => modify(count, (n) => n + 1),
        { concurrency: 10, discard: true },
      );
      expect(yield* count.state.get).toBe(50);
    }),
  );

  it.scoped("a selector projects state without a second actor", () =>
    Effect.gen(function* () {
      const count = yield* spawn(Behavior.value(2));
      const doubled = select(count.state, (n) => n * 2);
      expect(yield* doubled.get).toBe(4);
      yield* count.call(Value.Set(5));
      expect(yield* doubled.get).toBe(10);
    }),
  );

  it.scoped("messages apply in admission order", () =>
    Effect.gen(function* () {
      const list = yield* spawn(listBehavior);
      const first = yield* list.send({ _tag: "Append", item: "a" });
      const second = yield* list.send({ _tag: "Append", item: "b" });
      const applied = yield* list.call({ _tag: "Append", item: "c" });
      expect(first.admitted).toBe(1);
      expect(second.admitted).toBe(2);
      expect(applied).toEqual({ revision: 3, state: ["a", "b", "c"] });
    }),
  );

  it.scoped("state changes stream every committed revision", () =>
    Effect.gen(function* () {
      const count = yield* spawn(Behavior.value(0));
      const collected = yield* Stream.runCollect(Stream.take(count.state.changes, 3)).pipe(
        Effect.forkScoped,
      );
      yield* yieldFibers;
      yield* count.call(Value.Set(1));
      yield* count.call(Value.Set(2));
      expect(Array.from(yield* Fiber.join(collected))).toEqual([0, 1, 2]);
    }),
  );

  it.scoped("a machine is one kind of behavior behind the same reference", () =>
    Effect.gen(function* () {
      const counter = yield* spawn(Behavior.machine(counterMachine));
      yield* counter.send(CounterEvent.Increment);
      const applied = yield* counter.call(CounterEvent.Increment);
      expect(applied.revision).toBe(2);
      expect(applied.state).toEqual(CounterState.Counting({ count: 2 }));
      const reset = yield* counter.call(CounterEvent.Reset);
      expect(reset.state.count).toBe(0);
    }),
  );

  it.scoped("a machine's own transition reaches the state source", () =>
    Effect.gen(function* () {
      const step = yield* spawn(Behavior.machine(stepMachine));
      const applied = yield* step.call(StepEvent.Go);
      expect(applied.state._tag).toBe("Middle");
      const end = yield* Stream.runHead(
        Stream.filter(step.state.changes, (state) => state._tag === "End"),
      );
      expect(Option.map(end, (state) => state._tag)).toEqual(Option.some("End"));
    }),
  );

  it.effect("closing the scope stops the actor and fails later sends", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const count = yield* spawn(Behavior.value(0)).pipe(Scope.provide(scope));
      yield* count.call(Value.Set(1));
      yield* Scope.close(scope, Exit.void);
      const failure = yield* Effect.flip(count.send(Value.Set(2)));
      expect(failure._tag).toBe("ActorStopped");
      const callFailure = yield* Effect.flip(count.call(Value.Set(3)));
      expect(callFailure._tag).toBe("ActorStopped");
    }),
  );
});

describe("source combinators", () => {
  it.scoped("zip reads both sides on either side's change", () =>
    Effect.gen(function* () {
      const left = yield* spawn(Behavior.value(1));
      const right = yield* spawn(Behavior.value("a"));
      const pair = zip(left.state, right.state, (n, s) => `${s}${String(n)}`);
      expect(yield* pair.get).toBe("a1");

      const seen = yield* Stream.take(pair.changes, 3).pipe(Stream.runCollect, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* left.call(Value.Set(2));
      yield* right.call(Value.Set("b"));
      expect(Array.from(yield* Fiber.join(seen))).toEqual(["a1", "a2", "b2"]);
    }),
  );
});
