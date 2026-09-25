import { QueryState, Source } from "effect-frame/actor/client";
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
import { readAhead } from "../actor/read-ahead.js";
import { Match } from "./control.js";
import type { Node, RetainedNode } from "./jsx-runtime.js";

/**
 * Readiness through context (#16).
 *
 * A readiness scope is a region of a view that shows a fallback until every
 * query it was given has a first value, and afterwards keeps showing content
 * while values refresh. The scope is a service in the view's Effect context:
 * `View.ready` requires it, `View.loading` provides it. A `View.ready` call
 * with no `View.loading` above it is a missing service in `R`, which the
 * application must provide, so it does not run by accident.
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

/** The registry a `loading` boundary builds for itself: it can also report a hold. */
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
    entries: Source.fromSubscriptionRef(ref),
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

const noAhead = (): boolean => false;

/**
 * Streamed documents (#22): whether `ready`, `readyWithStale` and
 * `orErrored` may read a settle the document holds back until hydration is
 * done (`read-ahead.ts`). Outside every boundary it is false, so a node the
 * client claims shows what the server drew. A boundary gives its children
 * true until it starts, so it can see that the settle changes its branch;
 * then true only if it drew its branch fresh over the server's other one.
 */
const ReadAhead = ServiceMap.Reference<() => boolean>("effect-frame/src/view/readiness/ReadAhead", {
  defaultValue: () => noAhead,
});

/** A boundary's own `ReadAhead`, under the one its parent gives. */
const boundaryAhead = Effect.gen(function* () {
  const parent = yield* ReadAhead;
  let fresh = true;
  return {
    ahead: (): boolean => fresh || parent(),
    started: (drewFresh: boolean): void => {
      fresh = drewFresh;
    },
  };
});

// ---------------------------------------------------------------------------
// ready
// ---------------------------------------------------------------------------

/**
 * Turn a query's state source into a synchronous-looking source of its value,
 * and register it with the nearest `LoadingScope`.
 *
 * The returned source holds the last Ready value. Before the first one
 * arrives it reports `fallback`, and the surrounding `View.loading`
 * guarantees nothing built from it is on screen yet. That is the whole
 * trick: the value source never has to represent absence, because the scope
 * removes the consumer from the tree until absence is over.
 *
 * `R` carries `LoadingScope`, so a call outside a `View.loading` leaves it in
 * the mount's `R`. Pair it with `View.orErrored` to route the failure as well.
 *
 * ```ts
 * const title = yield* View.ready(post.state, "");
 * return <h1>{View.bind(title)}</h1>;
 * ```
 */
export const ready: <Value, Error>(
  state: Source<QueryState<Value, Error>>,
  fallback: Value,
) => Effect.Effect<Source<Value>, never, LoadingScope | Scope.Scope> = Effect.fn("Readiness.ready")(
  function* <Value, Error>(state: Source<QueryState<Value, Error>>, fallback: Value) {
    const shared = yield* registerLoading(state);
    return yield* holdSome(fallback, Source.select(shared, valueOf));
  },
);

/**
 * Also route this query's failure to the nearest `ErroredScope`.
 *
 * It is a separate call, not a second thing `ready` does, because the two
 * requirements are not the same promise. `ready` alone says "this view does
 * not draw until a value exists", which a `View.loading` can keep by itself.
 * Only a query whose failure someone must show needs a `View.errored` above
 * it, and making that the caller's word keeps `View.loading` usable with no
 * `View.errored` in the tree.
 *
 * ```ts
 * const counts = yield* View.ready(yield* View.orErrored(entry.state), zero);
 * ```
 */
export const orErrored: <Value, Error>(
  state: Source<QueryState<Value, Error>>,
) => Effect.Effect<Source<QueryState<Value, Error>>, never, ErroredScope | Scope.Scope> = Effect.fn(
  "Readiness.orErrored",
)(function* <Value, Error>(state: Source<QueryState<Value, Error>>) {
  const erroredScope = yield* ErroredScope;
  const read = readAhead(state, yield* ReadAhead);
  yield* erroredScope.register({
    settled: Source.select(read, isNotFailed),
    failure: Source.select(read, errorOf),
  });
  return read;
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
  const read = readAhead(state, yield* ReadAhead);
  yield* loadingScope.register({
    settled: Source.select(read, hasSettled),
    failure: noFailure,
  });
  return read;
});

/**
 * `ready`, keeping the stale flag. The Refetch row says stale content stays
 * on screen and the flag is available; a view that wants to dim itself binds
 * this instead of losing the information.
 *
 * ```ts
 * const shown = yield* View.readyWithStale(results.state, []);
 * const dim = View.bind(shown, (one) => one.stale);
 * ```
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
    Source.select(shared, readyValueOf),
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
const isNotFailed = <Value, Error>(state: QueryState<Value, Error>): boolean =>
  !QueryState.isFailed(state);

/** One member narrowed, so a predicate and not a table. */
const valueOf = <Value, Error>(state: QueryState<Value, Error>): Option.Option<Value> =>
  Option.map(Option.liftPredicate(state, QueryState.isReady), (found) => found.value);

const readyValueOf = <Value, Error>(
  state: QueryState<Value, Error>,
): Option.Option<ReadyValue<Value>> =>
  Option.map(Option.liftPredicate(state, QueryState.isReady), (found) => ({
    value: found.value,
    stale: found.stale,
  }));

const errorOf = <Value, Error>(state: QueryState<Value, Error>): Option.Option<Error> =>
  Option.map(Option.liftPredicate(state, QueryState.isFailed), (found) => found.error);

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
 * `true` while any registration is unsettled. A scope with no registration
 * has nothing to wait for, so it shows its content.
 *
 * A view's setup runs once, and a child's `ready` registers during that run,
 * so the scope never asks whether registration is "complete". A query that
 * registers later, unsettled, flips it back to pending: the retained node
 * hears that registration before the registering view writes (`onPending`).
 */
const pendingOf = (registry: Registry): Effect.Effect<Source<boolean>> =>
  derive(registry, (all) => all.some((one) => !one.settled));

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
  started: RetainedNode["started"],
): RetainedNode => {
  const node: RetainedNode = { _tag: "Retained", kind, when, fallback, content, started };
  return Option.match(hold, {
    onNone: () => node,
    onSome: (found) => ({ ...node, hold: found }),
  });
};

/**
 * Provide a `LoadingScope` to `content` and show `fallback` until every
 * query registered under it has a first value. A boundary with no
 * registration has nothing to wait for and shows its content. Afterwards the
 * content stays, whatever the queries do next.
 *
 * The runtime retains the content owner while a fallback is presented. Its
 * host writes are staged until the content is visible, so setup, keyed rows,
 * and their registrations can begin without leaking hidden output.
 *
 * It is an Effect, not a tag: it runs `content`'s setup with the scope
 * provided and removes `LoadingScope` from `R`.
 *
 * ```ts
 * const body = yield* View.loading({
 *   fallback: <p>loading</p>,
 *   content: Effect.gen(function* () {
 *     const title = yield* View.ready(post.state, "");
 *     return <h1>{View.bind(title)}</h1>;
 *   }),
 * });
 * ```
 */
export const loading = <E, R>(
  props: LoadingProps<E, R>,
): Effect.Effect<Node, E, Exclude<R, LoadingScope>> =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry;
    const read = yield* boundaryAhead;
    const content = yield* props.content.pipe(
      Effect.provideService(LoadingScope, registry),
      Effect.provideService(ReadAhead, read.ahead),
    );
    // The immediate children Effect runs before this snapshot, so registrations
    // made there contribute at once. Deferred producers register through the
    // retained runtime node and still drive this source after mount.
    const pending = yield* pendingOf(registry);
    return retained(
      "Loading",
      Source.select(pending, (value) => !value),
      props.fallback,
      content,
      Option.some(registry.onPending),
      read.started,
    );
  });

export interface LoadingProps<E, R> {
  readonly fallback: Node;
  readonly content: Effect.Effect<Node, E, R>;
}

export interface ErroredProps<E, R> {
  /**
   * The fallback reads the first failure among the queries routed here, in
   * registration order. It is `unknown` because one scope may hold queries
   * with different error types; the fallback narrows what it shows.
   */
  readonly fallback: (error: Source<Option.Option<unknown>>) => Node;
  readonly content: Effect.Effect<Node, E, R>;
}

/**
 * Provide an `ErroredScope` to `content`. Symmetric with `loading`: it shows
 * its fallback once a registered query has failed, and unlike `loading` it
 * stays showing it, because a failure does not resolve itself.
 *
 * ```ts
 * const page = yield* View.errored({
 *   fallback: () => <p>could not load</p>,
 *   content: View.loading({ fallback: <p>loading</p>, content: body }),
 * });
 * ```
 */
export const errored = <E, R>(
  props: ErroredProps<E, R>,
): Effect.Effect<Node, E, Exclude<R, ErroredScope>> =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry;
    const read = yield* boundaryAhead;
    const content = yield* props.content.pipe(
      Effect.provideService(ErroredScope, registry),
      Effect.provideService(ReadAhead, read.ahead),
    );
    // The immediate children Effect runs before this snapshot, so an already
    // Failed registration contributes at once. Deferred producers register
    // through the retained runtime node and still drive this source later.
    const failure = yield* derive(registry, firstFailure);
    const failed = Source.select(failure, Option.isSome);
    return retained(
      "Errored",
      Source.select(failed, (value) => !value),
      props.fallback(failure),
      content,
      Option.none(),
      read.started,
    );
  });

// ---------------------------------------------------------------------------
// Await
// ---------------------------------------------------------------------------

export interface AwaitProps<Value, Error> {
  readonly state: Source<QueryState<Value, Error>>;
  readonly loading: Node;
  readonly failed: (error: Source<Error>) => Node;
  /** `stale` is `true` while a refresh is in flight and the value is the last one. */
  readonly ready: (value: Source<Value>, stale: Source<boolean>) => Node;
}

/**
 * The other half of the pair: match the union yourself, with no scope in
 * context and no registration. `View.ready` inside `View.loading` is the
 * facade for the common case, and `Await` is a tag for a view that wants all
 * three states in one place. It is one `Match` over the three tags, so each
 * branch reads a source that exists only while its state holds: no
 * placeholder value, no cast, and nothing to name for a state that has not
 * been reached.
 *
 * ```tsx
 * <Await
 *   state={entry.state}
 *   loading={<p>loading</p>}
 *   failed={() => <p>could not load</p>}
 *   ready={(value) => <p>{View.bind(value)}</p>}
 * />
 * ```
 */
export const Await = <Value, Error>(props: AwaitProps<Value, Error>): Node => (
  <Match
    on={props.state}
    cases={{
      Loading: () => props.loading,
      Ready: (found) =>
        props.ready(
          Source.select(found, (state) => state.value),
          Source.select(found, (state) => state.stale),
        ),
      Failed: (found) => props.failed(Source.select(found, (state) => state.error)),
    }}
  />
);
