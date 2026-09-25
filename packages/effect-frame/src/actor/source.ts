import type { Duration, Equivalence, Scope } from "effect";
import { Effect, Function, Option, Sink, Stream, SubscriptionRef } from "effect";
import { Failed, Loading, Ready } from "./query.js";
import type { QueryState } from "./query.js";

/**
 * A read-only reactive source. A view binds to it. A selector projects it.
 * A source never owns a mailbox.
 *
 * `changes` emits the current value first, then every later value, as
 * `SubscriptionRef.changes` does. A combinator that merges sources relies
 * on this: it knows each side's first element is a read, not a change.
 */
export interface Source<A> {
  readonly get: Effect.Effect<A>;
  readonly changes: Stream.Stream<A>;
}

/**
 * A source over a `SubscriptionRef`: its value now, then every set.
 *
 * ```ts
 * const ref = yield* SubscriptionRef.make(0);
 * const count = Source.fromSubscriptionRef(ref);
 * ```
 */
export const fromSubscriptionRef = <A>(ref: SubscriptionRef.SubscriptionRef<A>): Source<A> => ({
  get: SubscriptionRef.get(ref),
  changes: SubscriptionRef.changes(ref),
});

/**
 * Project a source through a pure function. The projection runs on every
 * read and every change.
 *
 * ```ts
 * const title = Source.select(post.state, (post) => post.title);
 * ```
 */
export const select = <A, B>(source: Source<A>, project: (value: A) => B): Source<B> => ({
  get: Effect.map(source.get, project),
  changes: Stream.map(source.changes, project),
});

/**
 * A source that never changes: its value, then nothing.
 *
 * ```ts
 * const none = Source.succeed<ReadonlyArray<Note>>([]);
 * ```
 */
export const succeed = <A>(value: A): Source<A> => ({
  get: Effect.succeed(value),
  changes: Stream.succeed(value),
});

/**
 * Drop a change equal to the one before it, by `equivalence`. The first
 * element is still the current value.
 *
 * ```ts
 * const query = Source.dedupe(Source.select(params, (p) => p.q), Equivalence.String);
 * ```
 */
export const dedupe = <A>(
  source: Source<A>,
  equivalence: Equivalence.Equivalence<A>,
): Source<A> => ({
  get: source.get,
  changes: Stream.changesWith(source.changes, equivalence),
});

/**
 * Run each value through an Effect, as `Stream.mapEffect` does: a read runs
 * it on the value now, and each change runs it in order. It is not a load:
 * `f` cannot fail, and there is no Loading state (see `load`).
 *
 * ```ts
 * const opened = Source.mapEffect(noteId, (id) => Actor.remote(Note, { id }));
 * ```
 */
export const mapEffect = <A, B>(
  source: Source<A>,
  f: (value: A) => Effect.Effect<B>,
): Source<B> => ({
  get: Effect.flatMap(source.get, f),
  changes: Stream.mapEffect(source.changes, f),
});

/**
 * Follow the source that the latest value names. A change of the outer
 * source drops the inner source it named before and follows the new one,
 * whose first element is its current value.
 *
 * ```ts
 * const snapshot = Source.switchMap(binding, (current) => current.state);
 * ```
 */
export const switchMap = <A, B>(source: Source<A>, f: (value: A) => Source<B>): Source<B> => ({
  get: Effect.flatMap(source.get, (value) => f(value).get),
  changes: Stream.switchMap(source.changes, (value) => f(value).changes),
});

/**
 * Follow the source the outer source holds now: `switchMap` with no
 * projection.
 *
 * ```ts
 * const state = Source.flatten(Source.select(entry, (current) => current.state));
 * ```
 */
export const flatten = <A>(source: Source<Source<A>>): Source<A> =>
  switchMap(source, (inner) => inner);

/**
 * One source from two. It reads both when either changes, so a change to
 * one side is always seen beside the other's current value; the combined
 * source never holds a pair older than what either side would answer alone.
 *
 * The first read waits until both sides are followed: each side's first
 * element is its current value (see `Source`), and the combined stream
 * reads once when both have arrived, then once per later element. A read
 * taken before the subscriptions would lose a change that landed between
 * the two, as `derive` explains.
 */
export const zip = <A, B, C>(
  left: Source<A>,
  right: Source<B>,
  combine: (left: A, right: B) => C,
): Source<C> => {
  const get = Effect.map(Effect.all([left.get, right.get]), ([a, b]) => combine(a, b));
  return {
    get,
    changes: Stream.mapEffect(
      Stream.zipLatestWith(left.changes, right.changes, Function.constVoid),
      () => get,
    ),
  };
};

/** The value type of one source. */
export type ValueOf<S> = S extends Source<infer A> ? A : never;

/** The value type of a struct or tuple of sources, field by field. */
export type AllValues<Sources> = { readonly [K in keyof Sources]: ValueOf<Sources[K]> };

/**
 * One source from a struct or a tuple of them. As with `zip`, a change on
 * any side reads every side again, so the product never holds a member
 * older than that member would answer alone. A three-way product is one
 * call, not two nested ones.
 */
export const all = <
  const Sources extends
    | { readonly [key: string]: Source<unknown> }
    | ReadonlyArray<Source<unknown>>,
>(
  sources: Sources,
): Source<AllValues<Sources>> => {
  const keys = Object.keys(sources);
  const members: ReadonlyArray<Source<unknown>> = Object.values(sources);
  // A tuple's value is its members' values in order, which `Object.values`
  // kept; a struct's is the same values under the same keys.
  const assemble = (values: ReadonlyArray<unknown>): unknown => {
    if (Array.isArray(sources)) {
      return values;
    }
    return Object.fromEntries(keys.map((key, index) => [key, values[index]]));
  };
  // The product is `zip` folded over the members from the first one: each
  // step reads its whole left side again on either side's change, so the
  // innermost change still reaches the outermost read. An empty product is
  // a constant, and never touches a merge.
  const values = Option.match(Option.fromNullishOr(members[0]), {
    onNone: (): Source<ReadonlyArray<unknown>> => succeed([]),
    onSome: (first) =>
      members.slice(1).reduce<Source<ReadonlyArray<unknown>>>(
        // oxlint-disable-next-line oxc/no-accumulating-spread -- the reduce accumulates sources, and each read's tuple is as long as the product.
        (left, member) => zip(left, member, (known, value) => [...known, value]),
        select(first, (value) => [value]),
      ),
  });
  // The mapped type says field by field what `assemble` builds key by key;
  // no cast-free spelling of that exists at the value level.
  // oxlint-disable-next-line effect/noAs -- a tuple of sources has no cast-free product type at the value level.
  return select(values, (product) => assemble(product) as AllValues<Sources>);
};

/**
 * Run `f` for the current value and then for every change, on a fiber that
 * lives in the current scope. A view calls this in its setup to follow a
 * source with work that is not a binding; the follower ends with the view.
 */
export const on = <A, X>(
  source: Source<A>,
  f: (value: A) => Effect.Effect<X>,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.asVoid(Effect.forkScoped(Stream.runForEach(source.changes, f)));

/**
 * Build a source whose state is the last value emitted by a Stream operator.
 * The source's first changes value is its current value, so it seeds the
 * derived state and does not run through a time operator as a new change.
 */
const derive = <A>(
  source: Source<A>,
  transform: (changes: Stream.Stream<A>) => Stream.Stream<A>,
): Effect.Effect<Source<A>, never, Scope.Scope> =>
  Effect.gen(function* () {
    // `Stream.peel` may receive several values in one chunk. Rechunk first so
    // pulling the seed leaves every later value in the returned stream.
    const [first, rest] = yield* Stream.peel(
      source.changes.pipe(Stream.rechunk(1)),
      Sink.head<A>(),
    );
    // `Source.changes` is required to emit its current value first. Peeling
    // keeps the initial read and the later subscription on one pull, so an
    // update cannot land between a separate `get` and `changes` subscription.
    const initial = Option.getOrThrow(first);
    const state = yield* SubscriptionRef.make(initial);
    const changes = transform(rest);
    yield* Effect.asVoid(
      Effect.forkScoped(Stream.runForEach(changes, (value) => SubscriptionRef.set(state, value))),
    );
    return fromSubscriptionRef(state);
  });

/**
 * Publish a source change after it has been quiet for the duration.
 *
 * ```ts
 * const typed = yield* Source.debounce(input.state, "300 millis");
 * ```
 */
export const debounce = <A>(
  source: Source<A>,
  duration: Duration.Input,
): Effect.Effect<Source<A>, never, Scope.Scope> =>
  derive(source, (changes) => Stream.debounce(changes, duration));

/**
 * Rate-limit changes without conflation: later values remain queued.
 *
 * ```ts
 * const shaped = yield* Source.throttle(position, "100 millis");
 * ```
 */
export const throttle = <A>(
  source: Source<A>,
  duration: Duration.Input,
): Effect.Effect<Source<A>, never, Scope.Scope> =>
  derive(source, (changes) =>
    changes.pipe(
      Stream.rechunk(1),
      Stream.throttle({
        cost: () => 1,
        duration,
        strategy: "shape",
        units: 1,
      }),
    ),
  );

/**
 * Load the latest source value through an Effect that may fail, as a
 * `QueryState`. A new input interrupts the previous load. The source starts
 * Loading, carries a Ready value as stale while the next load runs, and
 * turns an expected failure into Failed. The loads run on a fiber in the
 * current scope.
 *
 * ```ts
 * const results = yield* Source.load(query, (q) => search(q));
 * ```
 */
export const load = <A, B, E, R>(
  source: Source<A>,
  f: (value: A) => Effect.Effect<B, E, R>,
): Effect.Effect<Source<QueryState<B, E>>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const state = yield* SubscriptionRef.make<QueryState<B, E>>(Loading());
    const changes = source.changes.pipe(
      Stream.switchMap((value) =>
        Stream.fromEffect(
          Effect.gen(function* () {
            const previous = yield* SubscriptionRef.get(state);
            if (previous._tag === "Ready" && !previous.stale) {
              yield* SubscriptionRef.set(state, Ready(previous.value, true));
            } else if (previous._tag === "Failed") {
              yield* SubscriptionRef.set(state, Loading());
            }
            return yield* Effect.scoped(f(value)).pipe(
              Effect.map((result) => Ready<B, E>(result, false)),
              Effect.catch((error) => Effect.succeed(Failed<B, E>(error))),
            );
          }),
        ),
      ),
    );
    yield* Effect.asVoid(
      Effect.forkScoped(Stream.runForEach(changes, (next) => SubscriptionRef.set(state, next))),
    );
    return fromSubscriptionRef(state);
  });

/**
 * The combinators under the type's own name: `Source.select` beside
 * `Source<A>`, as `Stream.map` sits beside `Stream<A>`. Each takes the
 * source first.
 */
export const Source = {
  all,
  debounce,
  dedupe,
  flatten,
  fromSubscriptionRef,
  load,
  mapEffect,
  on,
  select,
  succeed,
  switchMap,
  throttle,
  zip,
};
