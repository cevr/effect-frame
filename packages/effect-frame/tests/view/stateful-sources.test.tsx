import { View } from "effect-frame/view";
import { registerDom } from "./dom-setup.js";

registerDom();

import { QueryCache, followQuery } from "effect-frame/actor";
import type { QueryCacheService, QueryFailure, ResultOf, Source } from "effect-frame/actor";
import { QueryState } from "effect-frame/actor/client";
import { Effect, Equal, Match, Option, Queue, Schema, Stream, SubscriptionRef } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { Label, makeControl, sideOf } from "./streaming-fixture.js";

/**
 * Stateful sources (#22, review round 1). `followQuery` carries the value
 * shown last, and `ready` holds the last value. Each keeps one state that
 * a read and a delivery move by the same step over the upstream now. The
 * proofs hold deliveries back by hand, so a read gets ahead of them, and
 * check three things: a newer value is never undone by a late delivery,
 * the last value shown stays on screen stale, and `changes` emits every
 * value `get` returned, in order, with no equal value twice.
 */

type Labelled = QueryState<{ readonly label: string }, QueryFailure>;

const readyOf = (label: string): Labelled => ({ _tag: "Ready", value: { label }, stale: false });
const loading: Labelled = { _tag: "Loading" };

/** One upstream whose deliveries the test sends: `get` reads `current` at once. */
interface Held {
  current: Labelled;
  readonly deliveries: Queue.Queue<Labelled>;
}

const heldOf = (current: Labelled): Effect.Effect<Held> =>
  Effect.map(Queue.unbounded<Labelled>(), (deliveries) => ({ current, deliveries }));

const sourceOf = (held: Held): Source<Labelled> => ({
  get: Effect.sync(() => held.current),
  changes: Stream.fromQueue(held.deliveries),
});

/** A cache whose entries answer from `cells`, and deliver only what the test sends. */
const cacheOf = (cells: ReadonlyMap<string, Held>): QueryCacheService => ({
  open: (contract, args) =>
    Effect.sync(() => {
      const id = decodeArgs(args).id;
      const cell = Option.getOrThrow(Option.fromNullishOr(cells.get(id)));
      // Each value goes through the contract's own result codec, as the cache does.
      const decode = Schema.decodeUnknownEffect(contract.result);
      const typed = (state: Labelled) =>
        Match.value(state).pipe(
          Match.tagsExhaustive({
            Loading: () =>
              Effect.succeed(QueryState.Loading<ResultOf<typeof contract>, QueryFailure>()),
            Ready: (found) =>
              Effect.map(Effect.orDie(decode(`{"label":"${found.value.label}"}`)), (value) =>
                QueryState.Ready<ResultOf<typeof contract>, QueryFailure>(value, found.stale),
              ),
            Failed: (failed) =>
              Effect.succeed(
                QueryState.Failed<ResultOf<typeof contract>, QueryFailure>(failed.error),
              ),
          }),
        );
      const source = sourceOf(cell);
      return {
        key: { query: contract.name, version: contract.version, args: `{"id":"${id}"}` },
        state: {
          get: Effect.flatMap(source.get, typed),
          changes: Stream.mapEffect(source.changes, typed),
        },
        refresh: Effect.void,
        override: () => Effect.succeed(false),
      };
    }),
  active: Effect.succeed([]),
  apply: () => Effect.void,
  invalidate: () => Effect.void,
  principalChanged: Effect.void,
});

const decodeArgs = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }));

/** Every element a stream emits, as it emits them. */
const recording = <A,>(stream: Stream.Stream<A>) =>
  Effect.gen(function* () {
    const seen: Array<A> = [];
    yield* Effect.forkScoped(
      Stream.runForEach(stream, (value) => Effect.sync(() => void seen.push(value))),
    );
    // `changes` emits the current value first: wait for it, so the
    // subscription is open before the test goes on.
    for (let attempt = 0; attempt < 1000 && seen.length === 0; attempt += 1) {
      yield* Effect.sleep("1 millis");
    }
    return seen;
  });

/** Poll `read` until `check` holds, letting other fibers run between reads. */
const until = <A,>(read: Effect.Effect<A>, check: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const value = yield* read;
      if (check(value)) {
        return value;
      }
      yield* Effect.sleep("1 millis");
    }
    return yield* Effect.die(`timed out at ${String(yield* read)}`);
  });

/** Consecutive equal values collapsed: what a reader sees change. */
const distinct = <A,>(values: ReadonlyArray<A>): ReadonlyArray<A> =>
  values.filter((value, index) => index === 0 || !Equal.equals(value, values[index - 1]));

/** Every element of `part` appears in `whole`, in order. */
const inOrder = <A,>(part: ReadonlyArray<A>, whole: ReadonlyArray<A>): boolean => {
  let at = 0;
  for (const value of whole) {
    if (at < part.length && Equal.equals(value, part[at])) {
      at += 1;
    }
  }
  return at === part.length;
};

const labelOf = (state: Labelled): string => {
  if (state._tag === "Ready" && state.stale) {
    return `${state.value.label}:stale`;
  }
  if (state._tag === "Ready") {
    return state.value.label;
  }
  return state._tag;
};

describe("followQuery with deliveries held back", () => {
  it.scopedLive(
    "a value a read showed stays on screen stale when the next key loads, and changes emitted it",
    () =>
      Effect.gen(function* () {
        const side = yield* sideOf(makeControl({}));
        const cells = new Map([
          ["a", yield* heldOf(readyOf("A"))],
          ["b", yield* heldOf(readyOf("B"))],
          ["c", yield* heldOf(loading)],
        ]);
        const args = yield* SubscriptionRef.make(Option.some({ id: "a" }));
        const reads: Array<Labelled> = [];
        const result = yield* Effect.gen(function* () {
          const followed = yield* followQuery(Label, {
            get: SubscriptionRef.get(args),
            changes: SubscriptionRef.changes(args),
          });
          const seen = yield* recording(followed.state.changes);
          const read = Effect.tap(followed.state.get, (state) =>
            Effect.sync(() => void reads.push(state)),
          );
          yield* until(Effect.map(read, labelOf), (label) => label === "A");
          // B is cached, but its entry has delivered nothing yet.
          yield* SubscriptionRef.set(args, Option.some({ id: "b" }));
          yield* until(Effect.map(read, labelOf), (label) => label === "B");
          // C is loading: the value on screen, B, stays, marked stale.
          yield* SubscriptionRef.set(args, Option.some({ id: "c" }));
          const last = yield* until(read, (state) => labelOf(state) !== "B");
          yield* Effect.sleep("10 millis");
          return { last, seen: [...seen] };
        }).pipe(Effect.provideService(QueryCache, cacheOf(cells)), Effect.provideContext(side));
        expect(labelOf(result.last)).toBe("B:stale");
        expect(inOrder(distinct(reads), result.seen)).toBe(true);
        expect(distinct(result.seen)).toEqual(result.seen);
      }),
  );
});

describe("ready with deliveries held back", () => {
  const noScope = {
    register: () => Effect.void,
    entries: { get: Effect.succeed([]), changes: Stream.empty },
  };

  it.scopedLive("a late delivery never undoes a value a read showed", () =>
    Effect.gen(function* () {
      const upstream = yield* heldOf(readyOf("A"));
      const value = yield* View.ready(sourceOf(upstream), { label: "?" }).pipe(
        Effect.provideService(View.LoadingScope, noScope),
      );
      const seen = yield* recording(Stream.map(value.changes, (found) => found.label));
      expect((yield* value.get).label).toBe("A");
      upstream.current = readyOf("B");
      expect((yield* value.get).label).toBe("B");
      // The delivery of A arrives after a read showed B.
      yield* Queue.offer(upstream.deliveries, readyOf("A"));
      yield* Effect.sleep("10 millis");
      upstream.current = loading;
      yield* Queue.offer(upstream.deliveries, loading);
      yield* Effect.sleep("10 millis");
      expect((yield* value.get).label).toBe("B");
      expect(seen).toEqual(["A", "B"]);
    }),
  );
});
