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

      const derived = yield* Source.mapEffect(cell.state, evaluate);
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
      const derived = yield* Source.mapEffect(cell.state, () =>
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
