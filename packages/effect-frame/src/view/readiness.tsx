import { Source, isFailed, isReady, select } from "effect-frame/actor/client";
import {
  Context as ServiceMap,
  Effect,
  Match as EffectMatch,
  Option,
  Stream,
  SubscriptionRef,
} from "effect";
import type { Scope } from "effect";
import { advance, followedChanges } from "../actor/advance.js";
import { Match } from "./control.js";
import type { Node, RetainedNode } from "./jsx-runtime.js";
import type { QueryState } from "./query-state.js";

/**
 * Readiness through context (#16).
 *
 * A readiness scope is a region of a view that shows a fallback until every
 * query it was given has a first value, and afterwards keeps showing content
 * while values refresh. The scope is a service in the view's Effect context:
 * `ready` requires it, `Loading` provides it. A `ready` call with no `Loading`
 * above it is a missing service, which is a compile error, not a runtime one.
 *
 * Nothing is thrown and nothing is caught. Solid's `NotReadyError` and React's
 * Suspense both signal readiness by throwing; here the signal is a type.
 */

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * What one registered query contributes to its scope: whether it has
 * produced the kind of value this scope is waiting for, and the failure it
 * carries when it has failed. A loading registration never fails; its
 * `failure` is a constant `None`.
 */
interface Registration {
  readonly settled: Source<boolean>;
  readonly failure: Source<Option.Option<unknown>>;
}

/** One registration's current contribution, read when the scope recomputes. */
interface Contribution {
  readonly settled: boolean;
  readonly failure: Option.Option<unknown>;
}

const noFailure: Source<Option.Option<unknown>> = {
  get: Effect.succeed(Option.none()),
  changes: Stream.empty,
};

/**
 * The shared machinery behind both scopes. A scope holds the registrations
 * made under it and publishes a revision whenever the set changes, so the
 * derived pending source recomputes when a query registers or leaves after
 * first paint.
 */
interface Registry {
  /** The caller's Scope owns the registration and removes it on close. */
  readonly register: (registration: Registration) => Effect.Effect<void, never, Scope.Scope>;
  /** Every live registration, republished whenever one is added or removed. */
  readonly entries: Source<ReadonlyArray<Registration>>;
}

/** The registry a `Loading` builds for itself: it can also report a hold. */
interface OwnRegistry extends Registry {
  /**
   * Hears, synchronously and before `register` returns, each registration
   * that arrives unsettled. The retained runtime node uses it to leave the
   * document before the registering view writes (#16). Returns the
   * unsubscribe.
   */
  readonly onPending: (listener: () => void) => () => void;
}

const makeRegistry: Effect.Effect<OwnRegistry> = Effect.gen(function* () {
  const ref = yield* SubscriptionRef.make<ReadonlyArray<Registration>>([]);
  const listeners = new Set<() => void>();
  const announce = (registration: Registration) =>
    Effect.flatMap(registration.settled.get, (settled) =>
      Effect.sync(() => {
        if (settled) {
          return;
        }
        for (const listener of listeners) {
          listener();
        }
      }),
    );
  // Registration and its release are one scoped acquisition. A branch or
  // owner scope that disappears cannot leave a stale pending contribution.
  const remove = (registration: Registration) =>
    SubscriptionRef.update(ref, (all) => all.filter((entry) => entry !== registration));
  return {
    register: (registration) =>
      Effect.acquireRelease(
        Effect.andThen(
          SubscriptionRef.update(ref, (all) => [...all, registration]),
          announce(registration),
        ),
        () => remove(registration),
      ),
    entries: { get: SubscriptionRef.get(ref), changes: SubscriptionRef.changes(ref) },
    onPending: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
});

/**
 * The scope a `ready` call registers with. `LoadingScope` waits for a first
 * Ready; `ErroredScope` waits for the absence of a Failed. Two services, not
 * one with a flag, so a view that only handles errors does not silently
 * become a loading boundary as well.
 */
export class LoadingScope extends ServiceMap.Service<LoadingScope, Registry>()(
  "effect-frame/src/view/readiness/LoadingScope",
) {}

export class ErroredScope extends ServiceMap.Service<ErroredScope, Registry>()(
  "effect-frame/src/view/readiness/ErroredScope",
) {}

// ---------------------------------------------------------------------------
// ready
// ---------------------------------------------------------------------------

/**
 * Turn a query's state source into a synchronous-looking source of its value,
 * and register it with the nearest `LoadingScope`.
 *
 * The returned source holds the last Ready value. Before the first one
 * arrives it reports `fallback`, and the surrounding `Loading` guarantees
 * nothing built from it is on screen yet. That is the whole trick: the value
 * source never has to represent absence, because the scope removes the
 * consumer from the tree until absence is over.
 *
 * `R` carries `LoadingScope`, so calling this outside a `Loading` does not
 * compile. Pair it with `orErrored` to route the failure as well.
 */
export const ready: <Value, Error>(
  state: Source<QueryState<Value, Error>>,
  fallback: Value,
) => Effect.Effect<Source<Value>, never, LoadingScope | Scope.Scope> = Effect.fn("Readiness.ready")(
  function* <Value, Error>(state: Source<QueryState<Value, Error>>, fallback: Value) {
    const shared = yield* registerLoading(state);
    return yield* holdSome(fallback, select(shared, valueOf));
  },
);

/**
 * Also route this query's failure to the nearest `ErroredScope`.
 *
 * It is a separate call, not a second thing `ready` does, because the two
 * requirements are not the same promise. `ready` alone says "this view does
 * not draw until a value exists", which a `Loading` can keep by itself. Only
 * a query whose failure someone must show needs an `Errored` above it, and
 * making that the caller's word keeps `Loading` usable with no `Errored` in
 * the tree. The alternative — `ready` requiring both — made every `Loading`
 * leak `ErroredScope` to its own caller, which the compiler caught.
 */
export const orErrored: <Value, Error>(
  state: Source<QueryState<Value, Error>>,
) => Effect.Effect<Source<QueryState<Value, Error>>, never, ErroredScope | Scope.Scope> = Effect.fn(
  "Readiness.orErrored",
)(function* <Value, Error>(state: Source<QueryState<Value, Error>>) {
  const erroredScope = yield* ErroredScope;
  yield* erroredScope.register({
    settled: select(state, isNotFailed),
    failure: select(state, errorOf),
  });
  return state;
});

/**
 * Register a query with the nearest `LoadingScope`.
 *
 * The loading scope settles on Ready *or* Failed, not on Ready alone. A
 * failed query is never going to produce a value, so a loading fallback that
 * waited for one would hang forever, and it would hang underneath the error
 * fallback that is already on screen: two fallbacks for one query, which is
 * the state this whole design exists to rule out. "Settled" means the query
 * has stopped being in flight; which of the two scopes then draws is the
 * scopes' business, not this registration's.
 */
const registerLoading = Effect.fn("Readiness.registerLoading")(function* <Value, Error>(
  state: Source<QueryState<Value, Error>>,
) {
  const loadingScope = yield* LoadingScope;
  yield* loadingScope.register({
    settled: select(state, hasSettled),
    failure: noFailure,
  });
  return state;
});

/**
 * `ready`, keeping the stale flag. The Refetch row says stale content stays
 * on screen and the flag is available; a view that wants to dim itself binds
 * this instead of losing the information.
 */
export const readyWithStale: <Value, Error>(
  state: Source<QueryState<Value, Error>>,
  fallback: Value,
) => Effect.Effect<Source<ReadyValue<Value>>, never, LoadingScope | Scope.Scope> = Effect.fn(
  "Readiness.readyWithStale",
)(function* <Value, Error>(state: Source<QueryState<Value, Error>>, fallback: Value) {
  const shared = yield* registerLoading(state);
  return yield* holdSome<ReadyValue<Value>>(
    { value: fallback, stale: false },
    select(shared, readyValueOf),
  );
});

export interface ReadyValue<Value> {
  readonly value: Value;
  readonly stale: boolean;
}

/**
 * Hold the last present value, starting from `initial`. Absent updates are
 * dropped rather than represented: the consumer of this source is only in
 * the tree while a value exists, so it never has to read absence.
 *
 * The last value is one state, moved only by `advance`: a read and each
 * delivery from `source` take the same step over `source` now. So `get` is
 * never older than `source` (a server render reads it beside the seed,
 * #22), a delivery that arrives late never puts back an older value, and
 * `changes` holds every value `get` returned, in order.
 */
const holdSome = <A,>(initial: A, source: Source<Option.Option<A>>): Effect.Effect<Source<A>> =>
  Effect.map(SubscriptionRef.make(initial), (last) => {
    const step = (held: A): Effect.Effect<A> =>
      Effect.map(source.get, (now) => Option.getOrElse(now, () => held));
    return { get: advance(last, step), changes: followedChanges(last, step, source.changes) };
  });

/**
 * `true` once the query has stopped being in flight, either way. A case
 * table over every tag, so it is a matcher; built once, since it runs on
 * every state change (`tests/perf/match.bench.ts`).
 */
const hasSettled: (state: QueryState<unknown, unknown>) => boolean = EffectMatch.type<
  QueryState<unknown, unknown>
>().pipe(
  EffectMatch.withReturnType<boolean>(),
  EffectMatch.tagsExhaustive({ Loading: () => false, Ready: () => true, Failed: () => true }),
);

/**
 * `true` while the query has not failed. `ErroredScope` reads this to decide
 * whether to show its own fallback. One tag is the exception, so it is a
 * predicate, not a table.
 */
const isNotFailed = <Value, Error>(state: QueryState<Value, Error>): boolean => !isFailed(state);

/** One member narrowed, so a predicate and not a table. */
const valueOf = <Value, Error>(state: QueryState<Value, Error>): Option.Option<Value> =>
  Option.map(Option.liftPredicate(state, isReady), (found) => found.value);

const readyValueOf = <Value, Error>(
  state: QueryState<Value, Error>,
): Option.Option<ReadyValue<Value>> =>
  Option.map(Option.liftPredicate(state, isReady), (found) => ({
    value: found.value,
    stale: found.stale,
  }));

const errorOf = <Value, Error>(state: QueryState<Value, Error>): Option.Option<Error> =>
  Option.map(Option.liftPredicate(state, isFailed), (found) => found.error);

/** The first failure among the contributions, in registration order. */
const firstFailure = (contributions: ReadonlyArray<Contribution>): Option.Option<unknown> =>
  Option.flatMap(
    Option.fromNullishOr(contributions.find((one) => Option.isSome(one.failure))),
    (one) => one.failure,
  );

// ---------------------------------------------------------------------------
// Deriving pending
// ---------------------------------------------------------------------------

/**
 * `true` while any registration is unsettled, and `true` as well when there
 * is no registration yet.
 *
 * The empty case is what makes this work under setup-once semantics. A view's
 * setup runs once, and a child's `ready` registers during that run, so the
 * scope cannot know when registration is "complete". It never asks. It starts
 * pending, and it leaves pending only once it holds at least one settled
 * registration and no unsettled one. A query that registers later simply
 * flips it back.
 */
const pendingOf = (registry: Registry): Effect.Effect<Source<boolean>> =>
  derive(registry, (all) => all.length === 0 || all.some((one) => !one.settled));

/**
 * Derive one source from every registration under a scope.
 *
 * `fold` sees each registration's current contribution, in registration
 * order. The result recomputes on two triggers: a new registration, and any
 * registered query changing state. `switchMap` re-subscribes to the whole
 * set whenever the set itself changes, so a query that registers after
 * first paint is picked up without anyone writing a flag.
 */
const derive = <A,>(
  registry: Registry,
  fold: (contributions: ReadonlyArray<Contribution>) => A,
): Effect.Effect<Source<A>> =>
  Effect.sync(() => {
    const contribution = (entry: Registration): Effect.Effect<Contribution> =>
      Effect.map(Effect.all([entry.settled.get, entry.failure.get]), ([settled, failure]) => ({
        settled,
        failure,
      }));
    const compute = (entries: ReadonlyArray<Registration>): Effect.Effect<A> =>
      Effect.map(Effect.forEach(entries, contribution, { concurrency: 1 }), fold);

    // One element per trigger. It carries nothing: the registrations it was
    // raised over may already have grown by a late registration.
    const triggers = Stream.switchMap(registry.entries.changes, (entries) =>
      Stream.merge(
        Stream.succeed(void 0),
        Stream.mergeAll(
          entries.flatMap((entry): ReadonlyArray<Stream.Stream<void>> => [
            Stream.map(entry.settled.changes, () => void 0),
            Stream.map(entry.failure.changes, () => void 0),
          ]),
          { concurrency: "unbounded" },
        ),
      ),
    );

    // Read now on every `get`: a server render reads it beside the seed (#22).
    // Each trigger reads now as well, over the registrations there are now.
    const current = Effect.flatMap(registry.entries.get, compute);
    return {
      get: current,
      changes: Stream.mapEffect(triggers, () => current),
    } satisfies Source<A>;
  });

// ---------------------------------------------------------------------------
// The scope views
// ---------------------------------------------------------------------------

const retained = (
  kind: RetainedNode["kind"],
  when: Source<boolean>,
  fallback: Node,
  content: Node,
  hold: Option.Option<NonNullable<RetainedNode["hold"]>>,
): RetainedNode => {
  const node: RetainedNode = { _tag: "Retained", kind, when, fallback, content };
  return Option.match(hold, {
    onNone: () => node,
    onSome: (found) => ({ ...node, hold: found }),
  });
};

/**
 * Provide a `LoadingScope` to the children and show `fallback` until every
 * query registered under it has a first value. Afterwards the content stays,
 * whatever the queries do next.
 *
 * The runtime retains the content owner while a fallback is presented. Its
 * host writes are staged until the content is visible, so setup, keyed rows,
 * and their registrations can begin without leaking hidden output.
 */
export const Loading = <E, R>(
  props: LoadingProps<E, R>,
): Effect.Effect<Node, E, Exclude<R, LoadingScope>> =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry;
    const content = yield* Effect.provideService(props.children, LoadingScope, registry);
    // The immediate children Effect runs before this snapshot, so registrations
    // made there contribute at once. Deferred producers register through the
    // retained runtime node and still drive this source after mount.
    const pending = yield* pendingOf(registry);
    return retained(
      "Loading",
      select(pending, (value) => !value),
      props.fallback,
      content,
      Option.some(registry.onPending),
    );
  });

export interface LoadingProps<E, R> {
  readonly fallback: Node;
  readonly children: Effect.Effect<Node, E, R>;
}

export interface ErroredProps<E, R> {
  /**
   * The fallback reads the first failure among the queries routed here, in
   * registration order. It is `unknown` because one scope may hold queries
   * with different error types; the fallback narrows what it shows.
   */
  readonly fallback: (error: Source<Option.Option<unknown>>) => Node;
  readonly children: Effect.Effect<Node, E, R>;
}

/**
 * Provide an `ErroredScope`. Symmetric with `Loading`: it shows its fallback
 * once a registered query has failed, and unlike `Loading` it stays showing
 * it, because a failure does not resolve itself.
 */
export const Errored = <E, R>(
  props: ErroredProps<E, R>,
): Effect.Effect<Node, E, Exclude<R, ErroredScope>> =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry;
    const content = yield* Effect.provideService(props.children, ErroredScope, registry);
    // The immediate children Effect runs before this snapshot, so an already
    // Failed registration contributes at once. Deferred producers register
    // through the retained runtime node and still drive this source later.
    const failure = yield* derive(registry, firstFailure);
    const failed = select(failure, Option.isSome);
    return retained(
      "Errored",
      select(failed, (value) => !value),
      props.fallback(failure),
      content,
      Option.none(),
    );
  });

// ---------------------------------------------------------------------------
// Query and Await
// ---------------------------------------------------------------------------

export interface QueryProps<Value, Error> {
  readonly state: Source<QueryState<Value, Error>>;
  readonly loading: Node;
  readonly failed: (error: Source<Error>) => Node;
  /** `stale` is `true` while a refresh is in flight and the value is the last one. */
  readonly ready: (value: Source<Value>, stale: Source<boolean>) => Node;
}

/**
 * The other half of the pair: match the union yourself, with no scope in
 * context and no registration. `ready` inside `Loading` is the facade for
 * the common case, and `Query` is for a view that wants all three states
 * in one place. It is one `Match` over the three tags, so each branch reads
 * a source that exists only while its state holds: no placeholder value, no
 * cast, and nothing to name for a state that has not been reached.
 */
export const Query = <Value, Error>(props: QueryProps<Value, Error>): Node => (
  <Match
    on={props.state}
    cases={{
      Loading: () => props.loading,
      Ready: (found) =>
        props.ready(
          select(found, (state) => state.value),
          select(found, (state) => state.stale),
        ),
      Failed: (found) => props.failed(select(found, (state) => state.error)),
    }}
  />
);

export interface AwaitProps<Value, Error> {
  readonly query: Source<QueryState<Value, Error>>;
  readonly loading: Node;
  readonly failed: (error: Source<Error>) => Node;
  readonly ready: (value: Source<ReadyValue<Value>>) => Node;
}

/**
 * `Query` as a view, with the value and the stale flag as one `ReadyValue`
 * source. It requires nothing, as `Query` does.
 */
export const Await = <Value, Error>(
  props: AwaitProps<Value, Error>,
): Effect.Effect<Node, never, never> =>
  Effect.succeed(
    <Query
      state={props.query}
      loading={props.loading}
      failed={props.failed}
      ready={(value, stale) =>
        props.ready(
          select(Source.all({ value, stale }), (both) => ({
            value: both.value,
            stale: both.stale,
          })),
        )
      }
    />,
  );
