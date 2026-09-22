import type { Layer as LayerType } from "effect";
import {
  Clock,
  Context,
  Deferred,
  Effect,
  Equal,
  Exit,
  Hash,
  Layer,
  Option,
  Request,
  RequestResolver,
  RcMap,
  Schema,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import * as Inspection from "../inspection.js";
import type { AnyQuery, ArgsOf, QueryFailure, QueryKey, QueryState, ResultOf } from "./query.js";
import { Failed, Loading, Ready, canonicalize, keyOf, markStale } from "./query.js";
import type { Source } from "./source.js";
import type { Refreshed, TransportService } from "./transport.js";
import { ActorTransport } from "./transport.js";
import { Unreachable } from "./vocabulary.js";

interface BatchedQueryRequest extends Request.Request<string, QueryFailure> {
  readonly _tag: "BatchedQueryRequest";
  readonly key: QueryKey;
  /** Completes when the owning cache read closes, so a fully abandoned batch can abort. */
  readonly released: Deferred.Deferred<void>;
}

const BatchedQueryRequest = Request.tagged<BatchedQueryRequest>("BatchedQueryRequest");
type BatchedQueryResolver = RequestResolver.RequestResolver<BatchedQueryRequest>;

/**
 * RequestResolver collects requests until `Effect.yieldNow`, so every open
 * made in one scheduler turn joins one `/query/batch` call. The resolver is
 * keyed by transport below: a cache that serves more than one client runtime
 * must never send a later batch through the first runtime's transport.
 */
const makeBatchedQueryResolver = (transport: ActorTransport["Service"]): BatchedQueryResolver =>
  RequestResolver.make((entries) =>
    Effect.raceFirst(
      transport.queryBatch(entries.map((entry) => entry.request.key)).pipe(
        Effect.flatMap((results) =>
          Effect.sync(() => {
            const byKey = new Map(results.map((result) => [keyOf(result.key), result]));
            for (const entry of entries) {
              const result = Option.fromNullishOr(byKey.get(keyOf(entry.request.key)));
              if (Option.isNone(result)) {
                entry.completeUnsafe(
                  Exit.fail(
                    Unreachable.make({ reason: `query batch omitted ${keyOf(entry.request.key)}` }),
                  ),
                );
              } else if (result.value._tag === "Refreshed") {
                entry.completeUnsafe(Exit.succeed(result.value.result));
              } else {
                entry.completeUnsafe(Exit.fail(result.value.error));
              }
            }
          }),
        ),
      ),
      Effect.andThen(
        Effect.forEach(entries, (entry) => Deferred.await(entry.request.released), {
          concurrency: 16,
          discard: true,
        }),
        Effect.interrupt,
      ),
    ).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          for (const entry of entries) {
            entry.completeUnsafe(Exit.fail(error));
          }
        }),
      ),
    ),
  );

/**
 * The client half of the Query primitive (#17, lifetime per #28): a cache
 * keyed by encoded arguments, a `QueryState` source per entry, and the
 * declaration of which entries are active so a command reply can refresh
 * them. Client-safe: it holds the contract and a transport, never a handler.
 *
 * An entry exists exactly while something declares it. `open` acquires a
 * declaration in the caller's `Scope` and the Scope closing releases it;
 * the entry, and any read it has in flight, go when the last declaration
 * does. `active` is therefore the on-screen set by construction, which is
 * what lets a command's `active` list derive from the cache.
 */

/** One live cache entry. The `Source` is what a view binds to. */
export interface QueryEntry<A, E> {
  readonly key: QueryKey;
  readonly state: Source<QueryState<A, E>>;
  /**
   * Reads the current value from the server again. A read already in flight
   * is joined rather than repeated. Ready content stays on screen, marked
   * stale, until the new value lands; the fallback never returns.
   */
  readonly refresh: Effect.Effect<void>;
  /**
   * Shows a value the caller supplies, marked stale, until the next refresh
   * lands. The escape hatch for optimistic values the dependency graph
   * cannot derive: an actor commit refreshes automatically, and this is for
   * everything else.
   */
  readonly override: (value: A) => Effect.Effect<void>;
}

/**
 * One entry as the cache holds it: the value stays encoded, and each typed
 * `QueryEntry` decodes it through its own contract. Two declarations of one
 * key share this one state, so they can never diverge, and the cache needs
 * no cast to hand a typed view of an erased slot.
 */
interface CacheSlot {
  readonly key: QueryKey;
  /** The contract's `depends`, so `invalidate` needs no registry beside the slots. */
  readonly depends: ReadonlyArray<string>;
  /** Owns the read in flight. Closing it interrupts the read. */
  /** Scope owned by the RcMap entry. Closing the last declaration closes it. */
  readonly scope: Scope.Scope;
  /**
   * The state a view sees: the slot's own read state, shown stale while an
   * unresolved command owns a contract this entry depends on.
   */
  readonly state: SubscriptionRef.SubscriptionRef<QueryState<string, QueryFailure>>;
  /** Changes the slot's own read state. The displayed state follows. */
  readonly write: (
    update: (own: QueryState<string, QueryFailure>) => QueryState<string, QueryFailure>,
  ) => Effect.Effect<void>;
  /** Counts the unresolved dependent commands again, at the moment it runs. */
  readonly recount: (count: () => number) => Effect.Effect<void>;
  readonly refresh: Effect.Effect<void>;
  /**
   * A settled command's demand on this entry. In one step it marks the entry
   * stale and makes any read that started at or before `sequence` land
   * stale; then it makes sure a read started after this point. It returns
   * once the entry is stale, before that read runs, so a settlement can
   * release its ownership without the old value ever showing as fresh.
   */
  readonly readAfter: (sequence: number) => Effect.Effect<void>;
  /** Marks the entry stale in place. Used when a dependency commits. */
  readonly markStale: Effect.Effect<void>;
  /** Replaces the entry from an encoded result a command reply delivered. */
  readonly accept: (encoded: string) => Effect.Effect<void>;
  /** Records a refresh that the server could not serve. */
  readonly reject: (error: QueryFailure) => Effect.Effect<void>;
}

/**
 * RcMap installs a resource before its lookup starts. The key therefore keeps
 * the first declaration's contract and transport beside its canonical id, so
 * lookup never needs a second descriptor map or a cache-wide lock.
 */
class QueryCacheKey implements Equal.Equal {
  readonly id: string;

  constructor(
    readonly key: QueryKey,
    readonly contract: Option.Option<AnyQuery>,
    readonly transport: Option.Option<ActorTransport["Service"]>,
  ) {
    this.id = keyOf(key);
  }

  [Equal.symbol](that: Equal.Equal): boolean {
    return that instanceof QueryCacheKey && this.id === that.id;
  }

  [Hash.symbol](): number {
    return Hash.string(this.id);
  }

  static acquired(
    contract: AnyQuery,
    key: QueryKey,
    transport: ActorTransport["Service"],
  ): QueryCacheKey {
    return new QueryCacheKey(key, Option.some(contract), Option.some(transport));
  }

  static lookup(key: QueryKey): QueryCacheKey {
    return new QueryCacheKey(key, Option.none(), Option.none());
  }
}

/**
 * The client's query cache. One per client runtime, wired centrally: a view
 * never constructs one, and `ref` reads this same service to learn which
 * keys to declare active. There is exactly one place that knows what is on
 * screen, so `active` is derived from the cache and never synced beside it.
 */
export interface QueryCacheService {
  /**
   * Declare one query. The entry lives as long as the `Scope`; the release
   * is the Scope closing, so nothing can forget it. The first read is
   * started, not awaited: the entry comes back `Loading` and settles on its
   * own, which is what a readiness scope waits for.
   */
  readonly open: <Q extends AnyQuery>(
    contract: Q,
    args: ArgsOf<Q>,
  ) => Effect.Effect<QueryEntry<ResultOf<Q>, QueryFailure>, never, ActorTransport | Scope.Scope>;
  /** Every key with a live declaration. This is what a command declares active. */
  readonly active: Effect.Effect<ReadonlyArray<QueryKey>>;
  /** Applies the refreshes a command reply carried. */
  readonly apply: (refreshed: ReadonlyArray<Refreshed>) => Effect.Effect<void>;
  /**
   * Registers one command's ownership of a contract's dependents in the
   * current Scope. Every live entry that depends on the contract, and every
   * entry mounted later, shows stale until the Scope closes. Register before
   * the command's work starts; close the Scope on terminal settlement or
   * when the command's owner closes. Uncertain keeps the ownership.
   */
  readonly claim: (contractName: string) => Effect.Effect<CommandClaim, never, Scope.Scope>;
  /**
   * Marks every cached entry whose query depends on this contract stale.
   * The client does this the moment a command is sent, so the view shows
   * stale content before the reply arrives rather than after it.
   */
  readonly invalidate: (contractName: string) => Effect.Effect<void>;
}

/** One command's ownership of cache entries. */
export interface CommandClaim {
  /**
   * Accepts the refreshes an Applied command's settlement carried, then
   * reads again every live dependent those refreshes did not cover and
   * whose last read started before this settlement. A failed refresh stays
   * a Failed query; it never changes the command.
   */
  readonly settle: (refreshed: ReadonlyArray<Refreshed>) => Effect.Effect<void>;
}

export class QueryCache extends Context.Service<QueryCache, QueryCacheService>()(
  "effect-frame/src/actor/query-client/QueryCache",
) {}

const encodeKey = <Q extends AnyQuery>(contract: Q, args: ArgsOf<Q>): Effect.Effect<QueryKey> =>
  Effect.map(Effect.orDie(Schema.encodeEffect(contract.args)(args)), (encoded) => ({
    query: contract.name,
    version: contract.version,
    // Canonical from the start: two callers who spell the same arguments in
    // a different field order must land on one entry, not two.
    args: canonicalize(encoded),
  }));

/** The cache's command ownership, as one slot sees it. */
interface SlotOwnership {
  /** The next number in the cache's read and settlement sequence. */
  readonly next: () => number;
  /** Adds the slot to the live set and counts the claims that cover it. */
  readonly join: (slot: CacheSlot) => Effect.Effect<void, never, Scope.Scope>;
}

/** A Ready value shows stale while a dependent command is unresolved. */
const display = (
  state: QueryState<string, QueryFailure>,
  pending: number,
): QueryState<string, QueryFailure> => {
  if (state._tag === "Ready" && pending > 0 && !state.stale) {
    return Ready(state.value, true);
  }
  return state;
};

const makeSlot = Effect.fn("QueryCache.makeSlot")(function* (
  contract: AnyQuery,
  key: QueryKey,
  transport: ActorTransport["Service"],
  batchResolver: Option.Option<BatchedQueryResolver>,
  clock: Clock.Clock,
  registry: Option.Option<Inspection.RegistryService>,
  owner: Option.Option<Inspection.OwnerToken>,
  ownership: SlotOwnership,
) {
  const scope = yield* Effect.scope;
  const state = yield* SubscriptionRef.make<QueryState<string, QueryFailure>>(Loading());
  // The slot's own read state and its dependent command count. Every change
  // to either recomputes the displayed state inside one serialized update,
  // so the last update to run always reflects both current values.
  let own: QueryState<string, QueryFailure> = Loading();
  let pending = 0;
  const write = (
    update: (current: QueryState<string, QueryFailure>) => QueryState<string, QueryFailure>,
  ) =>
    SubscriptionRef.update(state, () => {
      own = update(own);
      return display(own, pending);
    });
  const recount = (count: () => number) =>
    SubscriptionRef.update(state, () => {
      pending = count();
      return display(own, pending);
    });
  // The sequence number at which the latest read started.
  let readStarted = -1;
  // A read must start after this number to count as fresh. A settled command
  // raises it; a read that started earlier still lands, marked stale.
  let freshAfter = -1;
  const openedAt = clock.monotonicTimeNanosUnsafe();

  // A read in flight, so a second `refresh` joins it instead of repeating it.
  let inflight: Option.Option<Deferred.Deferred<void>> = Option.none();
  // Bumped by a value that arrived by another path. A read that started
  // before the bump is older than what the entry now holds, and is dropped.
  let generation = 0;

  const land = (encoded: string, stale: boolean) =>
    Effect.suspend(() => {
      generation += 1;
      return write(() => Ready(encoded, stale));
    });
  const accept = (encoded: string) => land(encoded, false);
  const reject = (error: QueryFailure) =>
    Effect.suspend(() => {
      generation += 1;
      return write(() => Failed(error));
    });

  // The latch clears before the value is published, never after: a caller
  // that sees the new value and asks again must start a new read, not join
  // the one that just ended.
  const clear = Effect.sync(() => {
    inflight = Option.none();
  });

  const read = Effect.suspend(() => {
    const started = generation;
    const startedAt = ownership.next();
    readStarted = startedAt;
    const commit = (publish: Effect.Effect<void>) =>
      Effect.suspend(() => {
        if (started === generation) {
          return Effect.andThen(clear, publish);
        }
        return clear;
      });
    const request = Option.match(batchResolver, {
      onNone: () => transport.query(key),
      onSome: (resolver) =>
        Effect.gen(function* () {
          const released = yield* Deferred.make<void>();
          return yield* Effect.ensuring(
            Effect.request(BatchedQueryRequest({ key, released }), resolver),
            Deferred.succeed(released, void 0),
          );
        }),
    });
    return request.pipe(
      Effect.flatMap((encoded) =>
        commit(Effect.suspend(() => land(encoded, startedAt <= freshAfter))),
      ),
      Effect.catch((error) => reject(error).pipe(commit)),
    );
  });

  const refresh = Effect.gen(function* () {
    if (Option.isSome(inflight)) {
      return yield* Deferred.await(inflight.value);
    }
    const done = yield* Deferred.make<void>();
    inflight = Option.some(done);
    yield* write(markStale);
    const settle = Effect.andThen(clear, Deferred.succeed(done, void 0));
    // The read belongs to the slot, not to the caller: the caller may be a
    // view that unmounts first, and the slot closing is what interrupts it.
    // The read gets a child scope, and the waiters are woken by that scope's
    // finalizer rather than by the fiber: a fiber forked into a scope that
    // has already closed never runs, so nothing it carries would run either,
    // while a finalizer added to a closed scope runs at once.
    const reading = yield* Scope.fork(scope);
    yield* Scope.addFinalizer(reading, settle);
    yield* Effect.forkIn(Effect.ensuring(read, Scope.close(reading, Exit.void)), reading);
    return yield* Deferred.await(done);
  });

  const refreshSince = (sequence: number): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (readStarted > sequence) {
        return Effect.void;
      }
      return Option.match(inflight, {
        onNone: () => refresh,
        onSome: (running) => Effect.andThen(Deferred.await(running), refreshSince(sequence)),
      });
    });

  const readAfter = (sequence: number): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (readStarted > sequence) {
        return Effect.void;
      }
      freshAfter = Math.max(freshAfter, sequence);
      // The read belongs to the slot; the settlement only waits for stale.
      return Effect.andThen(
        write(markStale),
        Effect.asVoid(Effect.forkIn(refreshSince(sequence), scope)),
      );
    });

  const slot: CacheSlot = {
    key,
    depends: contract.depends,
    scope,
    state,
    write,
    recount,
    refresh,
    readAfter,
    markStale: write(markStale),
    accept,
    reject,
  };

  if (Option.isSome(registry) && Option.isSome(owner)) {
    yield* Scope.provide(
      registry.value.register(owner.value, (id) =>
        Effect.map(SubscriptionRef.get(state), (current) => {
          let stale = Option.none<boolean>();
          let value: Inspection.QueryValue = { _tag: "Absent" };
          let failure = Option.none<unknown>();
          if (current._tag === "Ready") {
            stale = Option.some(current.stale);
            value = { _tag: "Encoded", encoding: "json", value: current.value };
          } else if (current._tag === "Failed") {
            failure = Option.some(current.error);
          }
          return {
            _tag: "Query",
            id,
            ownerId: owner.value.id,
            parentOwnerId: owner.value.parentId,
            cacheId: owner.value.id,
            key: keyOf(key),
            state: current._tag,
            stale,
            ageMs: Number(clock.monotonicTimeNanosUnsafe() - openedAt) / 1_000_000,
            value,
            failure,
          };
        }),
      ),
      scope,
    );
  }
  // Join the live set, then count the claims that exist now. A claim made
  // after the join updates this slot itself, so none is missed.
  yield* ownership.join(slot);
  yield* Effect.forkIn(slot.refresh, scope);
  return slot;
});

/** The typed face of a slot. Decodes through the contract the caller holds. */
const entryOf = <Q extends AnyQuery>(
  contract: Q,
  slot: CacheSlot,
): QueryEntry<ResultOf<Q>, QueryFailure> => {
  const decode = Schema.decodeEffect(contract.result);
  const encode = Schema.encodeEffect(contract.result);
  const decodeState = (
    state: QueryState<string, QueryFailure>,
  ): Effect.Effect<QueryState<ResultOf<Q>, QueryFailure>> => {
    if (state._tag === "Ready") {
      return Effect.map(Effect.orDie(decode(state.value)), (value) => Ready(value, state.stale));
    }
    return Effect.succeed(state);
  };
  return {
    key: slot.key,
    state: {
      get: Effect.flatMap(SubscriptionRef.get(slot.state), decodeState),
      changes: Stream.mapEffect(SubscriptionRef.changes(slot.state), decodeState),
    },
    refresh: slot.refresh,
    override: (value) =>
      Effect.flatMap(Effect.orDie(encode(value)), (encoded) =>
        slot.write(() => Ready(encoded, true)),
      ),
  };
};

const make = (): Effect.Effect<QueryCacheService, never, Scope.Scope> =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const registry = yield* Effect.serviceOption(Inspection.Registry);
    let owner = Option.none<Inspection.OwnerToken>();
    if (Option.isSome(registry)) {
      owner = Option.some(yield* Inspection.ownerFor(registry.value));
    }
    // Command ownership: each live claim names one contract. `live` holds
    // the slots that exist now; a slot leaves it when its scope closes.
    const claims = new Map<symbol, string>();
    const live = new Set<CacheSlot>();
    let sequence = 0;
    const next = () => {
      sequence += 1;
      return sequence;
    };
    const covering = (slot: CacheSlot) => {
      let count = 0;
      for (const contractName of claims.values()) {
        if (slot.depends.includes(contractName)) {
          count += 1;
        }
      }
      return count;
    };
    // Each update counts the claims at the moment it runs, so the last
    // update to run always leaves the current count.
    const recount = (slot: CacheSlot) => slot.recount(() => covering(slot));
    const dependents = (contractName: string) =>
      Array.from(live).filter((slot) => slot.depends.includes(contractName));
    const ownership: SlotOwnership = {
      next,
      join: (slot) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            live.add(slot);
          }),
          () =>
            Effect.sync(() => {
              live.delete(slot);
            }),
        ).pipe(Effect.andThen(recount(slot))),
    };

    const batchResolvers = new Map<
      AnyQuery,
      Map<ActorTransport["Service"], BatchedQueryResolver>
    >();

    const batchResolverFor = (contract: AnyQuery, transport: ActorTransport["Service"]) => {
      if (contract.mode === "single") {
        return Option.none<BatchedQueryResolver>();
      }
      const byTransport = Option.getOrElse(
        Option.fromNullishOr(batchResolvers.get(contract)),
        () => {
          const created = new Map<ActorTransport["Service"], BatchedQueryResolver>();
          batchResolvers.set(contract, created);
          return created;
        },
      );
      const existing = Option.fromNullishOr(byTransport.get(transport));
      if (Option.isSome(existing)) {
        return existing;
      }
      const created = makeBatchedQueryResolver(transport);
      byTransport.set(transport, created);
      return Option.some(created);
    };

    const slots = yield* RcMap.make<QueryCacheKey, CacheSlot, never, Scope.Scope>({
      lookup: (cacheKey) =>
        Option.match(cacheKey.contract, {
          onNone: () => Effect.die("query cache lookup key has no contract"),
          onSome: (contract) =>
            Option.match(cacheKey.transport, {
              onNone: () => Effect.die("query cache lookup key has no transport"),
              onSome: (transport) =>
                makeSlot(
                  contract,
                  cacheKey.key,
                  transport,
                  batchResolverFor(contract, transport),
                  clock,
                  registry,
                  owner,
                  ownership,
                ),
            }),
        }),
    });

    const withCachedSlot = (
      key: QueryKey,
      use: (slot: CacheSlot) => Effect.Effect<void>,
    ): Effect.Effect<void> =>
      Effect.scoped(
        Effect.flatMap(RcMap.getOption(slots, QueryCacheKey.lookup(key)), (entry) =>
          Option.match(entry, {
            onNone: () => Effect.void,
            onSome: use,
          }),
        ),
      );

    const open = <Q extends AnyQuery>(contract: Q, args: ArgsOf<Q>) =>
      Effect.gen(function* () {
        const key = yield* encodeKey(contract, args);
        const transport = yield* ActorTransport;
        const slot = yield* RcMap.get(slots, QueryCacheKey.acquired(contract, key, transport));
        return entryOf(contract, slot);
      });

    const active = Effect.map(RcMap.keys(slots), (keys) =>
      Array.from(keys, (cacheKey) => cacheKey.key),
    );

    const apply = (refreshed: ReadonlyArray<Refreshed>) =>
      Effect.forEach(
        refreshed,
        (one) =>
          withCachedSlot(one.key, (slot) => {
            if (one._tag === "Refreshed") {
              return slot.accept(one.result);
            }
            return slot.reject(one.error);
          }),
        { discard: true },
      );

    const invalidate = (contractName: string) =>
      Effect.flatMap(RcMap.keys(slots), (keys) =>
        Effect.forEach(
          Array.from(keys).filter((cacheKey) =>
            Option.exists(cacheKey.contract, (contract) => contract.depends.includes(contractName)),
          ),
          (cacheKey) => withCachedSlot(cacheKey.key, (slot) => slot.markStale),
          { discard: true },
        ),
      );

    const claim = (contractName: string) =>
      Effect.gen(function* () {
        const token = Symbol(contractName);
        yield* Effect.acquireRelease(
          Effect.andThen(
            Effect.sync(() => {
              claims.set(token, contractName);
            }),
            Effect.forEach(dependents(contractName), recount, { discard: true }),
          ),
          () =>
            Effect.andThen(
              Effect.sync(() => {
                claims.delete(token);
              }),
              Effect.forEach(dependents(contractName), recount, { discard: true }),
            ),
        );
        const settle = (refreshed: ReadonlyArray<Refreshed>) =>
          Effect.gen(function* () {
            const settledAt = next();
            yield* apply(refreshed);
            const covered = new Set(refreshed.map((one) => keyOf(one.key)));
            // Each uncovered dependent is stale before this returns, and the
            // owner releases the claim only after it returns: the value from
            // before the command never shows as fresh in between.
            for (const slot of dependents(contractName)) {
              if (!covered.has(keyOf(slot.key))) {
                yield* slot.readAfter(settledAt);
              }
            }
          });
        const commandClaim: CommandClaim = { settle };
        return commandClaim;
      });

    const service: QueryCacheService = { open, active, apply, claim, invalidate };
    return service;
  });

export const layer: LayerType.Layer<QueryCache> = Layer.effect(QueryCache, make());

export namespace QueryCache {
  /**
   * Builds the real cache against an in-process host. The host owns all
   * handler behavior; this helper only composes the cache and transport.
   */
  export const layerTest = <R>(
    host: Effect.Effect<TransportService, never, R | Scope.Scope>,
  ): LayerType.Layer<QueryCache | ActorTransport, never, R> =>
    Layer.merge(layer, ActorTransport.layerLocal(host));
}

/**
 * Declare one query and get its entry. The view-facing name; it is
 * `useQuery` in a React-shaped runtime and `ref`-shaped here, but it is the
 * same call: open the entry, get a `Source<QueryState<T>>`. The declaration
 * lasts as long as the enclosing `Scope`, which for a view is its setup.
 */
export const useQuery = Effect.fn("useQuery")(function* <Q extends AnyQuery>(
  contract: Q,
  args: ArgsOf<Q>,
) {
  const cache = yield* QueryCache;
  return yield* cache.open(contract, args);
});

// ---------------------------------------------------------------------------
// Following arguments that change
// ---------------------------------------------------------------------------

/** A query whose arguments move: one state source across every key. */
export interface FollowedQuery<A, E> {
  readonly state: Source<QueryState<A, E>>;
  /** Refreshes the entry the arguments currently name. */
  readonly refresh: Effect.Effect<void>;
}

interface Following {
  readonly key: QueryKey;
  readonly scope: Scope.Closeable;
  readonly refresh: Effect.Effect<void>;
}

/**
 * While the next key loads, the last value stays on screen marked stale.
 * A view that moved from one page of results to the next keeps the old page
 * dimmed instead of flashing its fallback; the fallback is for having
 * nothing, and it has something.
 */
const carry = <A, E>(shown: QueryState<A, E>, incoming: QueryState<A, E>): QueryState<A, E> => {
  if (incoming._tag === "Loading" && shown._tag === "Ready") {
    return Ready(shown.value, true);
  }
  return incoming;
};

/**
 * Declare a query whose arguments are a source. Each new argument value
 * opens that key's entry in a child scope and releases the previous one, so
 * a read the old key had in flight is interrupted and `active` names only
 * the key on screen. `None` declares nothing: there is no question to ask,
 * and the state is `Loading` until there is one.
 */
export const followQuery = Effect.fn("followQuery")(function* <Q extends AnyQuery>(
  contract: Q,
  args: Source<Option.Option<ArgsOf<Q>>>,
) {
  const cache = yield* QueryCache;
  const transport = yield* ActorTransport;
  const scope = yield* Effect.scope;
  const output = yield* SubscriptionRef.make<QueryState<ResultOf<Q>, QueryFailure>>(Loading());
  let current: Option.Option<Following> = Option.none();

  const leave = Effect.suspend(() => {
    const previous = current;
    current = Option.none();
    return Option.match(previous, {
      onNone: () => Effect.void,
      onSome: (following) => Scope.close(following.scope, Exit.void),
    });
  });

  const enter = (next: ArgsOf<Q>) =>
    Effect.gen(function* () {
      const key = yield* encodeKey(contract, next);
      if (Option.exists(current, (following) => keyOf(following.key) === keyOf(key))) {
        return;
      }
      yield* leave;
      const child = yield* Scope.fork(scope);
      const entry = yield* Scope.provide(cache.open(contract, next), child).pipe(
        Effect.provideService(ActorTransport, transport),
      );
      current = Option.some({ key, scope: child, refresh: entry.refresh });
      yield* Effect.forkIn(
        Stream.runForEach(entry.state.changes, (state) =>
          SubscriptionRef.update(output, (shown) => carry(shown, state)),
        ),
        child,
      );
    });

  const follow = (next: Option.Option<ArgsOf<Q>>) =>
    Option.match(next, {
      onNone: () => Effect.andThen(leave, SubscriptionRef.set(output, Loading())),
      onSome: enter,
    });

  yield* follow(yield* args.get);
  yield* Effect.forkScoped(Stream.runForEach(args.changes, follow));

  const followed: FollowedQuery<ResultOf<Q>, QueryFailure> = {
    state: { get: SubscriptionRef.get(output), changes: SubscriptionRef.changes(output) },
    refresh: Effect.suspend(() =>
      Option.match(current, {
        onNone: () => Effect.void,
        onSome: (following) => following.refresh,
      }),
    ),
  };
  return followed;
});
