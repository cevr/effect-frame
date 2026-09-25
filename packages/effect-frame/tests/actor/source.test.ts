import { Deferred, Effect, Exit, Fiber, Ref, Scope, Stream, SubscriptionRef } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it, yieldFibers } from "effect-bun-test";
import { Cell, QueryState, Source } from "effect-frame/actor/client";
import type { QueryState as QueryStateValue } from "effect-frame/actor/client";

describe("time-based sources", () => {
  it.scoped("debounce emits the seed and only the latest quiet value", () =>
    Effect.gen(function* () {
      const cell = yield* Cell.make(0);
      const debounced = yield* Source.debounce(cell.state, "1 second");
      const seen = yield* Stream.take(debounced.changes, 2).pipe(
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* yieldFibers;

      expect(yield* debounced.get).toBe(0);
      yield* cell.set(1);
      yield* cell.set(2);
      yield* yieldFibers;
      expect(yield* debounced.get).toBe(0);

      yield* TestClock.adjust("1 second");
      expect(Array.from(yield* Fiber.join(seen))).toEqual([0, 2]);
      expect(yield* debounced.get).toBe(2);
    }),
  );

  it.scoped("throttle emits the first value and shapes later values", () =>
    Effect.gen(function* () {
      const cell = yield* Cell.make(0);
      const throttled = yield* Source.throttle(cell.state, "1 second");
      const seen = yield* Stream.take(throttled.changes, 3).pipe(
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* yieldFibers;

      yield* cell.set(1);
      yield* yieldFibers;
      expect(yield* throttled.get).toBe(1);

      yield* cell.set(2);
      yield* yieldFibers;
      expect(yield* throttled.get).toBe(1);

      yield* TestClock.adjust("1 second");
      expect(Array.from(yield* Fiber.join(seen))).toEqual([0, 1, 2]);
      expect(yield* throttled.get).toBe(2);
    }),
  );

  it.scoped("time-based work ends with its owner scope", () =>
    Effect.gen(function* () {
      const cell = yield* Cell.make(0);
      const owner = yield* Scope.make();
      const debounced = yield* Source.debounce(cell.state, "1 second").pipe(Scope.provide(owner));

      yield* cell.set(1);
      yield* Scope.close(owner, Exit.void);
      yield* cell.set(2);
      yield* TestClock.adjust("1 second");

      expect(yield* debounced.get).toBe(0);
    }),
  );

  it.scoped("does not lose a change made between the read and registration", () =>
    Effect.gen(function* () {
      const current = yield* SubscriptionRef.make(0);
      const source = {
        get: SubscriptionRef.get(current),
        changes: Stream.fromEffect(
          Effect.gen(function* () {
            // This is the update that can land after a separate `get` and
            // before that implementation subscribes to `changes`.
            yield* SubscriptionRef.set(current, 1);
            return yield* SubscriptionRef.get(current);
          }),
        ),
      };

      expect(yield* source.get).toBe(0);
      const debounced = yield* Source.debounce(source, "1 second");

      expect(yield* debounced.get).toBe(1);
    }),
  );

  it.scoped("preserves later values in the seed chunk", () =>
    Effect.gen(function* () {
      const source = {
        get: Effect.succeed(0),
        changes: Stream.make(0, 1, 2),
      };
      const debounced = yield* Source.debounce(source, 0);
      const throttled = yield* Source.throttle(source, 0);
      yield* yieldFibers;

      expect(yield* debounced.get).toBe(2);
      expect(yield* throttled.get).toBe(2);
    }),
  );
});

describe("Effect-derived sources", () => {
  it.scoped("starts loading, cancels old work, carries stale data, and fails", () =>
    Effect.gen(function* () {
      const initialGate = yield* Deferred.make<string>();
      const firstGate = yield* Deferred.make<string>();
      const secondGate = yield* Deferred.make<string>();
      const initialStarted = yield* Deferred.make<void>();
      const firstStarted = yield* Deferred.make<void>();
      const secondStarted = yield* Deferred.make<void>();
      const calls = yield* Ref.make<ReadonlyArray<number>>([]);
      const released = yield* Ref.make<ReadonlyArray<number>>([]);
      const cell = yield* Cell.make(0);

      const waitFor = (
        id: number,
        started: Deferred.Deferred<void>,
        gate: Deferred.Deferred<string>,
      ): Effect.Effect<string, never, Scope.Scope> =>
        Effect.acquireRelease(Deferred.succeed(started, void 0), () =>
          Ref.update(released, (seen) => [...seen, id]),
        ).pipe(Effect.flatMap(() => Deferred.await(gate)));

      const evaluate = (value: number): Effect.Effect<string, string, Scope.Scope> =>
        Effect.gen(function* () {
          yield* Ref.update(calls, (seen) => [...seen, value]);
          if (value === 0) {
            return yield* waitFor(0, initialStarted, initialGate);
          }
          if (value === 1) {
            return yield* waitFor(1, firstStarted, firstGate);
          }
          if (value === 2) {
            return yield* waitFor(2, secondStarted, secondGate);
          }
          return yield* Effect.fail("invalid");
        });

      const derived = yield* Source.load(cell.state, evaluate);
      const observed = yield* Stream.take(derived.changes, 6).pipe(
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* yieldFibers;
      expect(yield* derived.get).toEqual(QueryState.Loading());

      yield* Deferred.await(initialStarted);
      yield* Deferred.succeed(initialGate, "zero");
      yield* yieldFibers;
      expect(yield* derived.get).toEqual(QueryState.Ready("zero", false));

      yield* cell.set(1);
      yield* Deferred.await(firstStarted);
      yield* yieldFibers;
      expect(yield* derived.get).toEqual(QueryState.Ready("zero", true));

      yield* cell.set(2);
      yield* Deferred.await(secondStarted);
      yield* yieldFibers;
      expect(yield* derived.get).toEqual(QueryState.Ready("zero", true));

      yield* Deferred.succeed(firstGate, "ignored");
      yield* yieldFibers;
      expect(yield* Ref.get(released)).toContain(1);
      expect(yield* derived.get).toEqual(QueryState.Ready("zero", true));

      yield* Deferred.succeed(secondGate, "two");
      yield* yieldFibers;
      expect(yield* derived.get).toEqual(QueryState.Ready("two", false));

      yield* cell.set(3);
      yield* yieldFibers;
      expect(yield* derived.get).toEqual(QueryState.Failed("invalid"));

      expect(yield* Ref.get(calls)).toEqual([0, 1, 2, 3]);
      expect(Array.from(yield* Fiber.join(observed))).toEqual([
        QueryState.Loading<string, string>(),
        QueryState.Ready("zero", false),
        QueryState.Ready("zero", true),
        QueryState.Ready("two", false),
        QueryState.Ready("two", true),
        QueryState.Failed("invalid"),
      ] satisfies ReadonlyArray<QueryStateValue<string, string>>);
    }),
  );

  it.scoped("closes an in-flight computation with its owner scope", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<string>();
      const started = yield* Deferred.make<void>();
      const released = yield* Ref.make(false);
      const owner = yield* Scope.make();
      const cell = yield* Cell.make(0);
      const derived = yield* Source.load(cell.state, () =>
        Effect.acquireRelease(Effect.as(Deferred.succeed(started, void 0), "value"), () =>
          Ref.set(released, true),
        ).pipe(Effect.flatMap(() => Deferred.await(gate))),
      ).pipe(Scope.provide(owner));

      yield* Deferred.await(started);
      yield* Scope.close(owner, Exit.void);

      expect(yield* Ref.get(released)).toBe(true);
      expect(yield* derived.get).toEqual(QueryState.Loading());
    }),
  );
});

describe("composed sources", () => {
  it.effect("succeed reads its value and emits it once", () =>
    Effect.gen(function* () {
      const fixed = Source.succeed("only");
      expect(yield* fixed.get).toBe("only");
      expect(Array.from(yield* Stream.runCollect(fixed.changes))).toEqual(["only"]);
    }),
  );

  it.scoped("fromSubscriptionRef reads the value now, then every set", () =>
    Effect.gen(function* () {
      const ref = yield* SubscriptionRef.make(0);
      const source = Source.fromSubscriptionRef(ref);
      const seen = yield* Stream.take(source.changes, 2).pipe(Stream.runCollect, Effect.forkScoped);
      yield* yieldFibers;
      yield* SubscriptionRef.set(ref, 1);
      expect(Array.from(yield* Fiber.join(seen))).toEqual([0, 1]);
      expect(yield* source.get).toBe(1);
    }),
  );

  it.scoped("switchMap follows the inner source the latest value names", () =>
    Effect.gen(function* () {
      const left = yield* SubscriptionRef.make("left 0");
      const right = yield* SubscriptionRef.make("right 0");
      const side = yield* SubscriptionRef.make<"left" | "right">("left");
      const refs = { left, right };
      const followed = Source.switchMap(Source.fromSubscriptionRef(side), (name) =>
        Source.fromSubscriptionRef(refs[name]),
      );
      const seen = yield* Stream.take(followed.changes, 3).pipe(
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* yieldFibers;
      expect(yield* followed.get).toBe("left 0");

      yield* SubscriptionRef.set(side, "right");
      yield* yieldFibers;
      // The dropped inner source no longer reaches the followed one.
      yield* SubscriptionRef.set(left, "left 1");
      yield* yieldFibers;
      yield* SubscriptionRef.set(right, "right 1");
      expect(Array.from(yield* Fiber.join(seen))).toEqual(["left 0", "right 0", "right 1"]);
      expect(yield* followed.get).toBe("right 1");
    }),
  );

  it.scoped("flatten follows the source the outer source holds now", () =>
    Effect.gen(function* () {
      const inner = yield* SubscriptionRef.make(1);
      const outer = yield* SubscriptionRef.make(Source.fromSubscriptionRef(inner));
      const flat = Source.flatten(Source.fromSubscriptionRef(outer));
      expect(yield* flat.get).toBe(1);
      yield* SubscriptionRef.set(outer, Source.succeed(7));
      expect(yield* flat.get).toBe(7);
    }),
  );

  it.scoped("dedupe drops a change equal to the one before it", () =>
    Effect.gen(function* () {
      const ref = yield* SubscriptionRef.make("a");
      const deduped = Source.dedupe(
        Source.fromSubscriptionRef(ref),
        (left: string, right: string) => left === right,
      );
      const seen = yield* Stream.take(deduped.changes, 2).pipe(
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* yieldFibers;
      yield* SubscriptionRef.set(ref, "a");
      yield* yieldFibers;
      yield* SubscriptionRef.set(ref, "b");
      expect(Array.from(yield* Fiber.join(seen))).toEqual(["a", "b"]);
    }),
  );

  it.scoped("mapEffect runs the Effect on a read and on each change, in order", () =>
    Effect.gen(function* () {
      const ref = yield* SubscriptionRef.make(1);
      const runs = yield* Ref.make<ReadonlyArray<number>>([]);
      const doubled = Source.mapEffect(Source.fromSubscriptionRef(ref), (value) =>
        Effect.as(
          Ref.update(runs, (all) => [...all, value]),
          value * 2,
        ),
      );
      expect(yield* doubled.get).toBe(2);
      const seen = yield* Stream.take(doubled.changes, 2).pipe(
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* yieldFibers;
      yield* SubscriptionRef.set(ref, 5);
      expect(Array.from(yield* Fiber.join(seen))).toEqual([2, 10]);
      expect(yield* Ref.get(runs)).toEqual([1, 1, 5]);
    }),
  );
});
