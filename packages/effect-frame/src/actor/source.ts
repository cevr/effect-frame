import type { Scope } from "effect";
import { Effect, Function, Option, Stream, SubscriptionRef } from "effect";

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

export const fromSubscriptionRef = <A>(ref: SubscriptionRef.SubscriptionRef<A>): Source<A> => ({
  get: SubscriptionRef.get(ref),
  changes: SubscriptionRef.changes(ref),
});

export const select: {
  <A, B>(project: (value: A) => B): (source: Source<A>) => Source<B>;
  <A, B>(source: Source<A>, project: (value: A) => B): Source<B>;
} = Function.dual(2, <A, B>(source: Source<A>, project: (value: A) => B): Source<B> => ({
  get: Effect.map(source.get, project),
  changes: Stream.map(source.changes, project),
}));

/** A source that never changes: its current value, then nothing. */
const constant = <A>(value: A): Source<A> => ({
  get: Effect.succeed(value),
  changes: Stream.succeed(value),
});

/** Every element after the first, which is the current value (see `Source`). */
const later = <A>(source: Source<A>): Stream.Stream<void> =>
  Stream.map(Stream.drop(source.changes, 1), Function.constVoid);

/**
 * One source from two. It reads both when either changes, so a change to
 * one side is always seen beside the other's current value; the combined
 * source never holds a pair older than what either side would answer alone.
 * Each side's first element is its current value (see `Source`), so the
 * combined stream reads once up front and then follows only later changes.
 */
export const zip = <A, B, C>(
  left: Source<A>,
  right: Source<B>,
  combine: (left: A, right: B) => C,
): Source<C> => {
  const get = Effect.map(Effect.all([left.get, right.get]), ([a, b]) => combine(a, b));
  return {
    get,
    changes: Stream.concat(
      Stream.fromEffect(get),
      Stream.mapEffect(Stream.merge(later(left), later(right)), () => get),
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
    onNone: (): Source<ReadonlyArray<unknown>> => constant([]),
    onSome: (first) =>
      members.slice(1).reduce<Source<ReadonlyArray<unknown>>>(
        (left, member) => zip(left, member, (known, value) => [...known, value]),
        select(first, (value) => [value]),
      ),
  });
  // The mapped type says field by field what `assemble` builds key by key;
  // no cast-free spelling of that exists at the value level.
  // oxlint-disable-next-line effect/noAs
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
 * The combinators under the type's own name, so a reader writes
 * `Source.all` and `Source.on` beside `Source<A>`.
 */
export const Source = { all, on, select, zip };
