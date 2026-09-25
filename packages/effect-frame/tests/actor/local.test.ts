import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Schema,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import { describe, expect, it, yieldFibers } from "effect-bun-test";
import { Event, Machine, State } from "effect-machine";
import {
  ActorStopped,
  Behavior,
  Cell,
  Refused,
  Source,
  Value,
  committedRevision,
  modify,
  spawn,
} from "effect-frame/actor";
import type { CommandSettled } from "effect-frame/actor";

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
  it.scoped("a refused message is Rejected with its reason and commits no revision", () =>
    Effect.gen(function* () {
      const list = yield* spawn(
        Behavior.reducer<ReadonlyArray<string>, Append, Refused>({
          initial: [],
          reduce: (state, message) => [...state, message.item],
          refuse: (message) =>
            Option.as(
              Option.liftPredicate(message, (append) => append.item === ""),
              Refused.make({ reason: "empty" }),
            ),
        }),
      );
      const handle = yield* list.send({ _tag: "Append", item: "" });
      const settled = yield* handle.settled;
      expect(settled._tag).toBe("Rejected");
      expect(settled._tag === "Rejected" && settled.reason).toEqual(
        Refused.make({ reason: "empty" }),
      );
      const failed = yield* Effect.flip(list.call({ _tag: "Append", item: "" }));
      expect(failed).toEqual(Refused.make({ reason: "empty" }));
      // Nothing was applied: the next accepted message is revision 1.
      const applied = yield* list.call({ _tag: "Append", item: "a" });
      expect(applied).toEqual({ revision: committedRevision(1), state: ["a"] });
    }),
  );

  it.scoped("a value actor refuses by its rule, and modify reports the refusal", () =>
    Effect.gen(function* () {
      const count = yield* spawn(
        Behavior.value(0, {
          refuse: (value) =>
            Option.as(
              Option.liftPredicate(value, (n) => n < 0),
              Refused.make({ reason: "negative" }),
            ),
        }),
      );
      const failed = yield* Effect.flip(modify(count, (n) => n - 1));
      expect(failed).toEqual(Refused.make({ reason: "negative" }));
      expect(yield* count.applied.get).toEqual({ revision: committedRevision(0), state: 0 });
    }),
  );

  it.scoped("simple state replaces its value through Set", () =>
    Effect.gen(function* () {
      const count = yield* spawn(Behavior.value(0));
      const applied = yield* count.call(Value.Set(10));
      expect(applied).toEqual({ revision: committedRevision(1), state: 10 });
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
      const doubled = Source.select(count.state, (n) => n * 2);
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
      expect(applied).toEqual({ revision: committedRevision(3), state: ["a", "b", "c"] });
      expect(yield* first.settled).toEqual({
        _tag: "Applied",
        admitted: 1,
        revision: committedRevision(1),
        state: ["a"],
      });
      expect(yield* second.state.get).toEqual({
        _tag: "Applied",
        admitted: 2,
        revision: committedRevision(2),
        state: ["a", "b"],
      });
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
      expect(applied.revision.value).toBe(2);
      expect(applied.state).toEqual(CounterState.Counting({ count: 2 }));
      const reset = yield* counter.call(CounterEvent.Reset);
      expect(reset.state.count).toBe(0);
    }),
  );

  it.scoped("a machine's echo of an older message never takes its state back", () =>
    Effect.gen(function* () {
      const counter = yield* spawn(Behavior.machine(counterMachine));
      const seen: Array<number> = [];
      yield* Effect.forkScoped(
        Stream.runForEach(counter.applied.changes, (applied) =>
          Effect.sync(() => {
            seen.push(applied.state.count);
          }),
        ),
      );
      // Three messages in the mailbox before any turn runs: each turn's
      // transition reaches the actor after the next message is queued.
      yield* counter.send(CounterEvent.Increment);
      yield* counter.send(CounterEvent.Increment);
      const last = yield* counter.call(CounterEvent.Increment);
      for (let round = 0; round < 10; round += 1) {
        yield* yieldFibers;
      }
      expect(last.state.count).toBe(3);
      expect(seen).toEqual([0, 1, 2, 3]);
      expect((yield* counter.applied.get).revision.value).toBe(3);
    }),
  );

  it.scoped("a machine refuses by its rule: Rejected, and no transition runs", () =>
    Effect.gen(function* () {
      const counter = yield* spawn(
        Behavior.machine(counterMachine, {
          refuse: (event) =>
            Option.as(
              Option.liftPredicate(event, (one) => one._tag === "Reset"),
              Refused.make({ reason: "pinned" }),
            ),
        }),
      );
      yield* counter.call(CounterEvent.Increment);
      const handle = yield* counter.send(CounterEvent.Reset);
      expect(yield* handle.settled).toEqual({
        _tag: "Rejected",
        reason: Refused.make({ reason: "pinned" }),
      });
      // The refused Reset never reached the machine: the count carries on.
      const applied = yield* counter.call(CounterEvent.Increment);
      expect(applied.state).toEqual(CounterState.Counting({ count: 2 }));
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

  it.scoped("a local handle is Admitted before its turn and Applied after", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const held: Behavior.Behavior<number, number> = {
        initial: 0,
        open: () =>
          Effect.succeed({
            apply: (state, amount) => Effect.as(Deferred.await(gate), state + amount),
            changes: Stream.empty,
          }),
      };
      const count = yield* spawn(held);
      const handle = yield* count.send(2);
      expect(yield* handle.state.get).toEqual({ _tag: "Admitted", admitted: 1 });
      const states = yield* Effect.forkScoped(Stream.runCollect(handle.state.changes));
      yield* yieldFibers;
      yield* Deferred.succeed(gate, void 0);
      expect(Array.from(yield* Fiber.join(states))).toEqual([
        { _tag: "Admitted", admitted: 1 },
        { _tag: "Applied", admitted: 1, revision: committedRevision(1), state: 2 },
      ]);
    }),
  );

  it.effect("a handle admitted before a stop settles Rejected, never Uncertain", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const never: Behavior.Behavior<number, number> = {
        initial: 0,
        open: () =>
          Effect.succeed({
            apply: () => Effect.never,
            changes: Stream.empty,
          }),
      };
      const count = yield* spawn(never).pipe(Scope.provide(scope));
      const handle = yield* count.send(1);
      yield* Scope.close(scope, Exit.void);
      const stopped: CommandSettled<number, "local"> = {
        _tag: "Rejected",
        reason: ActorStopped.make(),
      };
      expect(yield* handle.settled).toEqual(stopped);
      expect(yield* handle.state.get).toEqual(stopped);
    }),
  );

  it.effect("closing the scope stops the actor and fails later sends", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const count = yield* spawn(Behavior.value(0)).pipe(Scope.provide(scope));
      yield* count.call(Value.Set(1));
      yield* Scope.close(scope, Exit.void);
      const refused = yield* count.send(Value.Set(2));
      expect(yield* refused.settled).toEqual({ _tag: "Rejected", reason: ActorStopped.make() });
      const callFailure = yield* Effect.flip(count.call(Value.Set(3)));
      expect(callFailure._tag).toBe("ActorStopped");
    }),
  );
});

describe("source combinators", () => {
  it.live("zip loses no change that lands between its first read and its subscription", () =>
    Effect.gen(function* () {
      // A write lands right after zip's first read of the left side, before
      // anything follows it: the first read is 0 and the ref is then 1.
      const ref = yield* SubscriptionRef.make(0);
      const reads = { count: 0 };
      const left: Source<number> = {
        get: Effect.tap(SubscriptionRef.get(ref), () =>
          Effect.suspend(() => {
            reads.count += 1;
            if (reads.count === 1) {
              return SubscriptionRef.set(ref, 1);
            }
            return Effect.void;
          }),
        ),
        changes: SubscriptionRef.changes(ref),
      };
      const letter = yield* SubscriptionRef.make("a");
      const right: Source<string> = {
        get: SubscriptionRef.get(letter),
        changes: SubscriptionRef.changes(letter),
      };
      const pair = Source.zip(left, right, (n, s) => `${s}${String(n)}`);
      const reached = yield* Stream.runHead(
        Stream.filter(pair.changes, (value) => value === "a1"),
      ).pipe(Effect.timeoutOption("200 millis"));
      expect(Option.flatten(reached)).toEqual(Option.some("a1"));
    }),
  );

  it.scoped("zip reads both sides on either side's change", () =>
    Effect.gen(function* () {
      const left = yield* spawn(Behavior.value(1));
      const right = yield* spawn(Behavior.value("a"));
      const pair = Source.zip(left.state, right.state, (n, s) => `${s}${String(n)}`);
      expect(yield* pair.get).toBe("a1");

      const seen = yield* Stream.take(pair.changes, 3).pipe(Stream.runCollect, Effect.forkScoped);
      // Both sides followed before either changes.
      yield* yieldFibers;
      yield* left.call(Value.Set(2));
      yield* right.call(Value.Set("b"));
      expect(Array.from(yield* Fiber.join(seen))).toEqual(["a1", "a2", "b2"]);
    }),
  );
});

describe("source products and followers", () => {
  it.scoped("all builds a struct and a tuple, and re-reads on either side's change", () =>
    Effect.gen(function* () {
      const n = yield* spawn(Behavior.value(1));
      const s = yield* spawn(Behavior.value("a"));
      const struct = Source.all({ n: n.state, s: s.state });
      const tuple = Source.all([n.state, s.state]);
      expect(yield* struct.get).toEqual({ n: 1, s: "a" });
      expect(yield* tuple.get).toEqual([1, "a"]);

      const seen = yield* Stream.take(struct.changes, 3).pipe(Stream.runCollect, Effect.forkScoped);
      // Both sides followed before either changes.
      yield* yieldFibers;
      yield* n.call(Value.Set(2));
      yield* s.call(Value.Set("b"));
      expect(Array.from(yield* Fiber.join(seen))).toEqual([
        { n: 1, s: "a" },
        { n: 2, s: "a" },
        { n: 2, s: "b" },
      ]);
    }),
  );

  it.scoped("on runs for the current value and every change, and ends with the scope", () =>
    Effect.gen(function* () {
      const cell = yield* Cell.make(0);
      const seen: Array<number> = [];
      const scope = yield* Scope.make();
      yield* Scope.provide(
        Source.on(cell.state, (value) => Effect.sync(() => void seen.push(value))),
        scope,
      );
      yield* yieldFibers;
      yield* cell.set(1);
      yield* cell.update((value) => value + 1);
      yield* yieldFibers;
      expect(seen).toEqual([0, 1, 2]);

      yield* Scope.close(scope, Exit.void);
      yield* cell.set(9);
      yield* yieldFibers;
      expect(seen).toEqual([0, 1, 2]);
    }),
  );

  it.scoped("a write to a cell whose scope has closed is a no-op", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const cell = yield* Scope.provide(Cell.make("open"), scope);
      yield* Scope.close(scope, Exit.void);
      yield* cell.set("late");
      yield* cell.update((value) => `${value}!`);
      expect(yield* cell.get).toBe("open");
    }),
  );
});
