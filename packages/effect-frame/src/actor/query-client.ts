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
  Predicate,
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
import { Failed, Loading, Ready, StreamEnded, canonicalize, keyOf, markStale } from "./query.js";
import type { Source } from "./source.js";
import type { ActorSeed } from "./streaming.js";
import type { Projection, Refreshed, TransportService } from "./transport.js";
import { ActorTransport } from "./transport.js";
import { Unreachable } from "./vocabulary.js";
import { advance, advancedChanges } from "./advance.js";

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
 * One state and the principal generation it was written under. The cache
 * counts its principals: each change of principal is the next generation.
 * A state from an older generation was read for somebody else.
 */
interface Stamped<S> {
  readonly state: S;
  readonly principal: number;
}

type SlotState = Stamped<QueryState<string, QueryFailure>>;

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
  /** Completes when `scope` closes: the last declaration of the key is gone. */
  readonly released: Effect.Effect<void>;
  /**
   * Begin a read that arrives by another path: a document seed still open
   * when the slot opened (#22). The returned function publishes its result
   * only when no read has started and no value has landed since, so a late
   * seed never replaces a newer read's value.
   */
  readonly outsideRead: () => (publish: Effect.Effect<void>) => Effect.Effect<void>;
  /**
   * The state a view sees: the slot's own read state, shown stale while an
   * unresolved command owns a contract this entry depends on.
   */
  readonly state: SubscriptionRef.SubscriptionRef<SlotState>;
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
  /**
   * Drops the value and any read in flight, shows `Loading`, and reads
   * again. Used when the principal the value was read under is gone.
   */
  readonly forget: Effect.Effect<void>;
  /** Replaces the entry from an encoded result a command reply delivered. */
  readonly accept: (encoded: string) => Effect.Effect<void>;
  /**
   * Shows a value this client has not confirmed: a prerendered page's baked
   * value (#23 §3.2). It lands `Ready{stale: true}`; the next read confirms it.
   */
  readonly acceptStale: (encoded: string) => Effect.Effect<void>;
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
   * Marks every cached entry whose query depends on this contract stale.
   * The client does this the moment a command is sent, so the view shows
   * stale content before the reply arrives rather than after it.
   */
  readonly invalidate: (contractName: string) => Effect.Effect<void>;
  /**
   * The principal every held value was read under is gone (#20, #30): a
   * sign-out, a sign-in as someone else, or a revoked session. Every live
   * entry drops its value and any read in flight, shows `Loading`, and reads
   * again under the new principal. No entry keeps a value the new principal
   * was not authorized to read. A reference whose change stream ends with
   * `Unauthorized` calls this for the cache it reads.
   */
  readonly principalChanged: Effect.Effect<void>;
}

/**
 * Source-private: what a reference and `followQuery` need from a cache built
 * here and nowhere else. It is not part of `QueryCacheService`, so a custom
 * cache implements only the public surface, and no public entry exports it.
 */
export interface CacheInternals {
  /**
   * Registers one command's ownership of a contract's dependents in the
   * current Scope. Every live entry that depends on the contract, and every
   * entry mounted later, shows stale until the Scope closes. Register before
   * the command's work starts; close the Scope on terminal settlement or
   * when the command's owner closes. Uncertain keeps the ownership.
   */
  readonly claim: (contractName: string) => Effect.Effect<CommandClaim, never, Scope.Scope>;
  /**
   * Opens one entry, and its states stamped with the principal generation
   * each was written under. `followQuery` carries a value across a key
   * change only within one generation.
   */
  readonly openStamped: <Q extends AnyQuery>(
    contract: Q,
    args: ArgsOf<Q>,
  ) => Effect.Effect<StampedEntry<Q>, never, ActorTransport | Scope.Scope>;
}

interface StampedEntry<Q extends AnyQuery> {
  readonly entry: QueryEntry<ResultOf<Q>, QueryFailure>;
  /** The entry's state now, with its stamp. */
  readonly get: Effect.Effect<Stamped<QueryState<ResultOf<Q>, QueryFailure>>>;
  readonly changes: Stream.Stream<Stamped<QueryState<ResultOf<Q>, QueryFailure>>>;
}

/** One command's ownership of cache entries. */
export interface CommandClaim {
  /**
   * Accepts the refreshes an Applied command's settlement carried, then
   * reads again every live dependent those refreshes did not cover and
   * whose last read started before this settlement. A failed refresh stays
   * a Failed query; it never changes the command. When the principal changed
   * after the claim was made, the refreshes were read for the principal that
   * is gone: nothing lands, and the entries read again on their own.
   */
  readonly settle: (refreshed: ReadonlyArray<Refreshed>) => Effect.Effect<void>;
}

export class QueryCache extends Context.Service<QueryCache, QueryCacheService>()(
  "effect-frame/src/actor/query-client/QueryCache",
) {}

/**
 * The ownership each real cache built here carries, keyed by that exact
 * service. A claim therefore always lands in the cache the reference reads,
 * and a cache built elsewhere has none: its commands own nothing.
 */
const internals = new WeakMap<QueryCacheService, CacheInternals>();

/** Source-private: the internals of a cache built by `layer`. */
export const internalsOf = (cache: QueryCacheService): Option.Option<CacheInternals> =>
  Option.fromNullishOr(internals.get(cache));

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
  /** The cache's principal generation now. */
  readonly principal: () => number;
  /** The principal is gone: the next generation, and every live entry forgets. */
  readonly principalGone: Effect.Effect<void>;
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
  seeds: Seeds,
) {
  const scope = yield* Effect.scope;
  const ended = yield* Deferred.make<void>();
  yield* Scope.addFinalizer(scope, Deferred.succeed(ended, void 0));
  const state = yield* SubscriptionRef.make<SlotState>({
    state: Loading(),
    principal: ownership.principal(),
  });
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
      return { state: display(own, pending), principal: ownership.principal() };
    });
  const recount = (count: () => number) =>
    SubscriptionRef.update(state, () => {
      pending = count();
      return { state: display(own, pending), principal: ownership.principal() };
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
  // The principal generation under which the server last granted this key.
  // A refusal of a key the same principal was granted proves that the
  // principal changed. A refusal of a key it was never granted proves
  // nothing: it is the answer for that principal.
  let granted = Option.none<number>();

  const land = (encoded: string, stale: boolean) =>
    Effect.suspend(() => {
      generation += 1;
      granted = Option.some(ownership.principal());
      return write(() => Ready(encoded, stale));
    });
  const accept = (encoded: string) => land(encoded, false);
  const acceptStale = (encoded: string) => land(encoded, true);
  const reject = (error: QueryFailure) =>
    Effect.suspend(() => {
      generation += 1;
      const revoked =
        Predicate.isTagged(error, "Unauthorized") &&
        Option.contains(granted, ownership.principal());
      granted = Option.none();
      const failed = write(() => Failed(error));
      if (revoked) {
        return Effect.andThen(failed, ownership.principalGone);
      }
      return failed;
    });

  // The latch clears before the value is published, never after: a caller
  // that sees the new value and asks again must start a new read, not join
  // the one that just ended.
  const clear = Effect.sync(() => {
    inflight = Option.none();
  });

  const read = Effect.suspend(() => {
    // The read's stamp. A change of principal bumps it on every live entry
    // (`forget`), so a result read for a principal that is gone never lands.
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

  // Reads once the read in flight, if any, has ended: a new read never joins
  // one that started under the principal that is gone.
  const reread: Effect.Effect<void> = Effect.suspend(() =>
    Option.match(inflight, {
      onNone: () => refresh,
      onSome: (running) => Effect.andThen(Deferred.await(running), reread),
    }),
  );

  // Bumping the generation drops whatever the read in flight brings back.
  const forget = Effect.suspend(() => {
    generation += 1;
    granted = Option.none();
    return Effect.andThen(
      write(() => Loading()),
      Effect.asVoid(Effect.forkIn(reread, scope)),
    );
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

  const outsideRead = () => {
    const started = generation;
    const lastRead = readStarted;
    return (publish: Effect.Effect<void>) =>
      Effect.suspend(() => {
        if (started === generation && lastRead === readStarted) {
          return publish;
        }
        return Effect.void;
      });
  };

  const slot: CacheSlot = {
    key,
    depends: contract.depends,
    scope,
    released: Deferred.await(ended),
    outsideRead,
    state,
    write,
    recount,
    refresh,
    readAfter,
    markStale: write(markStale),
    forget,
    accept,
    acceptStale,
    reject,
  };

  if (Option.isSome(registry) && Option.isSome(owner)) {
    yield* Scope.provide(
      registry.value.register(owner.value, (id) =>
        Effect.map(SubscriptionRef.get(state), ({ state: current }) => {
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
  yield* begin(slot, seeds.take(keyOf(key)), seeds.hydrated);
  return slot;
});

/**
 * Start a new slot. With no seed it reads, as it always has. A seed the
 * document already settled lands before the slot is returned, so the first
 * `get` a view makes sees it: that is what lets a hydrating client present
 * content the server patched ahead of it. A seed still open is awaited in
 * the slot's scope, as a read: a read the client starts meanwhile, or a
 * value that lands by another path, supersedes it. `StreamEnded` lands, and
 * the slot reads again at once. `published` completes once the seed has
 * landed, was superseded, or the slot closed.
 */
const begin = (
  slot: CacheSlot,
  seed: Option.Option<Seed>,
  hydrated: Effect.Effect<void>,
): Effect.Effect<void> =>
  Option.match(seed, {
    onNone: () => Effect.asVoid(Effect.forkIn(slot.refresh, slot.scope)),
    onSome: (found) => {
      const published = Deferred.succeed(found.published, void 0);
      return Option.match(found.current, {
        onSome: (state) => Effect.andThen(landSeed(slot, state, hydrated), published),
        onNone: () => {
          const commit = slot.outsideRead();
          return Effect.andThen(
            Scope.addFinalizer(slot.scope, published),
            Effect.forkIn(
              Effect.flatMap(Deferred.await(found.settled), (state) =>
                commit(landSeed(slot, state, hydrated)),
              ).pipe(Effect.ensuring(published)),
              slot.scope,
            ),
          );
        },
      });
    },
  });

/**
 * Land a seed's state. The seed is what the server drew, so it stays on
 * screen until hydration is done: a read the seed calls for starts only
 * then (review round 2). A reply that came before the client's first
 * drawing would draw a newer value than the server's markup.
 */
const landSeed = (
  slot: CacheSlot,
  state: SeedState,
  hydrated: Effect.Effect<void>,
): Effect.Effect<void> => {
  const readAfterHydration = Effect.asVoid(
    Effect.forkIn(Effect.andThen(hydrated, slot.refresh), slot.scope),
  );
  // A prerendered page's value, or one the server showed stale: shown at
  // once, marked unconfirmed, and read again once hydration is done. The
  // reply lands `Ready{stale: false}` in its place (#23 §3.2).
  if (state._tag === "Ready" && state.stale) {
    return Effect.andThen(slot.acceptStale(state.value), readAfterHydration);
  }
  if (state._tag === "Ready") {
    return slot.accept(state.value);
  }
  if (state._tag === "Failed" && isFinalSeed(state.error)) {
    return slot.reject(state.error);
  }
  if (state._tag === "Failed") {
    return Effect.andThen(slot.reject(state.error), readAfterHydration);
  }
  return readAfterHydration;
};

/**
 * Only the query's own failure is final on the client. Every other failure
 * in a seed is about the server's read (its transport, its caller, the
 * document), not about the query, so the client reads again at once.
 */
const isFinalSeed = (error: QueryFailure): boolean => error._tag === "QueryFailed";

// ---------------------------------------------------------------------------
// Streamed documents (#22)
// ---------------------------------------------------------------------------

type SeedState = QueryState<string, QueryFailure>;

/**
 * What a streamed document holds for one key. `current` is set once, by the
 * first patch or by the end of the document; `settled` wakes a slot that
 * opened while the key was still open. `taken` is set when a slot consumes
 * the seed, so a later declaration of the key reads fresh. `published`
 * completes when the slot that took it has put its state in the slot, or
 * closed first.
 */
interface Seed {
  current: Option.Option<SeedState>;
  readonly settled: Deferred.Deferred<SeedState>;
  readonly published: Deferred.Deferred<void>;
  taken: boolean;
}

interface Seeds {
  /** The seed for a key, if the document holds one no slot has consumed. */
  readonly take: (id: string) => Option.Option<Seed>;
  /**
   * Completes when hydration is done (`Resumed.hydrated`), or when the
   * principal changed. A read a seed calls for waits for it.
   */
  readonly hydrated: Effect.Effect<void>;
}

/** One live entry as the server's streamed render reads it. */
export interface DocumentEntry {
  readonly key: QueryKey;
  /** The entry's displayed state. `Loading` until its first read lands. */
  readonly state: Source<QueryState<string, QueryFailure>>;
  /** Completes when the render releases the entry: no view declares it now. */
  readonly released: Effect.Effect<void>;
}

/**
 * Source-private: how the streamed document reaches a cache built by
 * `layer`. The server reads `entries`; the client writes the rest.
 */
export interface DocumentAccess {
  /** Every entry declared now, in the order the entries opened. */
  readonly entries: Effect.Effect<ReadonlyArray<DocumentEntry>>;
  /** The document opened `id`. A second placeholder for one id changes nothing. */
  readonly placeholder: (id: string) => Effect.Effect<void>;
  /** The document settled `id`. The first settle wins; a duplicate changes nothing. */
  readonly settle: (id: string, state: SeedState) => Effect.Effect<void>;
  /**
   * The document ended. Every id still open fails `StreamEnded`, and this
   * returns once every slot that took a seed has published it or closed.
   */
  readonly end: Effect.Effect<void>;
  /**
   * Hydration is done. A seed no slot took is dropped: a key declared from
   * now on reads over the query path, never from the document. A read a
   * landed seed called for (a stale value, a failure that is not final)
   * starts now, not before: until then the entry shows what the server drew.
   * An actor seed no route took is dropped too.
   */
  readonly expire: Effect.Effect<void>;
  /**
   * Server: the route actors the render holds now, each at its committed
   * snapshot, in the order they were held. A route actor is written with
   * the drawing: see `Streaming.ActorSeed`.
   */
  readonly actors: Effect.Effect<ReadonlyArray<ActorSeed>>;
  /**
   * Server: hold one route actor's committed projection for the document
   * while the current Scope is open. `projection` is read again at each
   * write, so the seed and the drawing agree at one instant.
   */
  readonly holdActor: (
    id: string,
    projection: Effect.Effect<Projection>,
  ) => Effect.Effect<void, never, Scope.Scope>;
  /** Client: the document carried this route actor's projection. The first one wins. */
  readonly seedActor: (id: string, projection: Projection) => Effect.Effect<void>;
  /**
   * Client: the projection the document carried for this route actor. Every
   * route that opens the actor while the page hydrates starts from it, at
   * the revision the drawing shows. None once hydration is done: a route
   * then reads the actor, never a snapshot the page has held since it loaded.
   */
  readonly actorSeed: (id: string) => Effect.Effect<Option.Option<Projection>>;
}

const documents = new WeakMap<QueryCacheService, DocumentAccess>();

/** Source-private: the document access of a cache built by `layer`. */
export const documentOf = (cache: QueryCacheService): Option.Option<DocumentAccess> =>
  Option.fromNullishOr(documents.get(cache));

/** One cache's document: what the streamed render reads, and what new slots take. */
interface CacheDocument {
  readonly access: DocumentAccess;
  readonly seeds: Seeds;
}

const makeDocument = (live: ReadonlySet<CacheSlot>): CacheDocument => {
  const table = new Map<string, Seed>();
  // Server: the route actors held now. Client: the snapshots the document carried.
  const held = new Map<
    symbol,
    { readonly id: string; readonly projection: Effect.Effect<Projection> }
  >();
  const actorSeeds = new Map<string, Projection>();
  let expired = false;
  const hydrated = Deferred.makeUnsafe<void>();
  const seedFor = (id: string): Seed =>
    Option.getOrElse(Option.fromNullishOr(table.get(id)), () => {
      const created: Seed = {
        current: Option.none(),
        settled: Deferred.makeUnsafe(),
        published: Deferred.makeUnsafe(),
        taken: false,
      };
      table.set(id, created);
      return created;
    });
  const settle = (id: string, state: SeedState) =>
    Effect.suspend(() => {
      const seed = seedFor(id);
      if (Option.isSome(seed.current)) {
        return Effect.void;
      }
      seed.current = Option.some(state);
      return Effect.asVoid(Deferred.succeed(seed.settled, state));
    });
  const access: DocumentAccess = {
    entries: Effect.sync(() =>
      Array.from(live, (slot) => ({
        key: slot.key,
        // The render reads the displayed state. The principal stamp stays
        // inside this cache: a seed is stamped again by the client that takes it.
        state: {
          get: Effect.map(SubscriptionRef.get(slot.state), (stamped) => stamped.state),
          changes: Stream.map(SubscriptionRef.changes(slot.state), (stamped) => stamped.state),
        },
        released: slot.released,
      })),
    ),
    placeholder: (id) => Effect.sync(() => void seedFor(id)),
    settle,
    // Every open seed fails, then every taken seed is waited for: when `end`
    // returns, each live slot shows its seed's final state.
    end: Effect.andThen(
      Effect.suspend(() =>
        Effect.forEach(
          Array.from(table).filter(([, seed]) => Option.isNone(seed.current)),
          ([id]) => settle(id, Failed(StreamEnded.make({ key: id }))),
          { discard: true },
        ),
      ),
      Effect.suspend(() =>
        Effect.forEach(
          Array.from(table.values()).filter((seed) => seed.taken),
          (seed) => Deferred.await(seed.published),
          { discard: true },
        ),
      ),
    ),
    expire: Effect.andThen(
      Effect.sync(() => {
        expired = true;
        actorSeeds.clear();
      }),
      Deferred.succeed(hydrated, void 0),
    ),
    actors: Effect.suspend(() =>
      Effect.forEach(Array.from(held.values()), (one) =>
        Effect.map(one.projection, (projection): ActorSeed => ({
          _tag: "ActorSeed",
          id: one.id,
          ...projection,
        })),
      ),
    ),
    holdActor: (id, projection) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const token = Symbol(id);
          held.set(token, { id, projection });
          return token;
        }),
        (token) => Effect.sync(() => void held.delete(token)),
      ),
    seedActor: (id, projection) =>
      Effect.sync(() => {
        if (!expired && !actorSeeds.has(id)) {
          actorSeeds.set(id, projection);
        }
      }),
    actorSeed: (id) => Effect.sync(() => Option.fromNullishOr(actorSeeds.get(id))),
  };
  const seeds: Seeds = {
    take: (id) =>
      Option.filter(Option.fromNullishOr(table.get(id)), (seed) => {
        if (seed.taken || expired) {
          return false;
        }
        seed.taken = true;
        return true;
      }),
    hydrated: Deferred.await(hydrated),
  };
  const document: CacheDocument = { access, seeds };
  return document;
};

/** Decodes a slot's state through the contract the caller holds. */
const decoderOf = <Q extends AnyQuery>(contract: Q) => {
  const decode = Schema.decodeEffect(contract.result);
  return (
    state: QueryState<string, QueryFailure>,
  ): Effect.Effect<QueryState<ResultOf<Q>, QueryFailure>> => {
    if (state._tag === "Ready") {
      return Effect.map(Effect.orDie(decode(state.value)), (value) => Ready(value, state.stale));
    }
    return Effect.succeed(state);
  };
};

/** A slot's states with their principal generation, decoded. */
const stampedState = <Q extends AnyQuery>(
  contract: Q,
  slot: CacheSlot,
): Effect.Effect<Stamped<QueryState<ResultOf<Q>, QueryFailure>>> => {
  const decodeState = decoderOf(contract);
  return Effect.flatMap(SubscriptionRef.get(slot.state), (stamped) =>
    Effect.map(decodeState(stamped.state), (state) => ({ state, principal: stamped.principal })),
  );
};

const stampedChanges = <Q extends AnyQuery>(
  contract: Q,
  slot: CacheSlot,
): Stream.Stream<Stamped<QueryState<ResultOf<Q>, QueryFailure>>> => {
  const decodeState = decoderOf(contract);
  return Stream.mapEffect(SubscriptionRef.changes(slot.state), (stamped) =>
    Effect.map(decodeState(stamped.state), (state) => ({ state, principal: stamped.principal })),
  );
};

/** The typed face of a slot. Decodes through the contract the caller holds. */
const entryOf = <Q extends AnyQuery>(
  contract: Q,
  slot: CacheSlot,
): QueryEntry<ResultOf<Q>, QueryFailure> => {
  const encode = Schema.encodeEffect(contract.result);
  const decodeState = decoderOf(contract);
  return {
    key: slot.key,
    state: {
      get: Effect.flatMap(SubscriptionRef.get(slot.state), (stamped) => decodeState(stamped.state)),
      changes: Stream.mapEffect(SubscriptionRef.changes(slot.state), (stamped) =>
        decodeState(stamped.state),
      ),
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
    const document = makeDocument(live);
    let sequence = 0;
    const next = () => {
      sequence += 1;
      return sequence;
    };
    // The principal generation. Every held value and every read in flight
    // is stamped with the generation it started under.
    let principal = 0;
    // A streamed document was read for the principal of its request. A seed
    // that no slot took yet is dropped, so a key declared later reads for the
    // new principal; a seed a slot is still waiting for is dropped by that
    // slot's `forget`, which bumps its read stamp.
    const principalGone = Effect.suspend(() => {
      principal += 1;
      return Effect.andThen(
        document.access.expire,
        Effect.forEach(Array.from(live), (slot) => slot.forget, { discard: true }),
      );
    });
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
      principal: () => principal,
      principalGone,
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
                  document.seeds,
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

    const openSlot = <Q extends AnyQuery>(contract: Q, args: ArgsOf<Q>) =>
      Effect.gen(function* () {
        const key = yield* encodeKey(contract, args);
        const transport = yield* ActorTransport;
        return yield* RcMap.get(slots, QueryCacheKey.acquired(contract, key, transport));
      });

    const open = <Q extends AnyQuery>(contract: Q, args: ArgsOf<Q>) =>
      Effect.map(openSlot(contract, args), (slot) => entryOf(contract, slot));

    const openStamped = <Q extends AnyQuery>(contract: Q, args: ArgsOf<Q>) =>
      Effect.map(openSlot(contract, args), (slot): StampedEntry<Q> => ({
        entry: entryOf(contract, slot),
        get: stampedState(contract, slot),
        changes: stampedChanges(contract, slot),
      }));

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
        // The principal the command runs under. Its reply was read for it.
        const since = principal;
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
            if (principal !== since) {
              return;
            }
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

    const service: QueryCacheService = {
      open,
      active,
      apply,
      invalidate,
      principalChanged: principalGone,
    };
    internals.set(service, { claim, openStamped });
    documents.set(service, document.access);
    return service;
  });

export const layer: LayerType.Layer<QueryCache> = Layer.effect(QueryCache, make());

export namespace QueryCache {
  /**
   * Builds the real cache against an in-process host. The host owns all
   * handler behavior; this helper only composes the cache and transport.
   */
  export const layerTest = <E, R>(
    host: Effect.Effect<TransportService, E, R | Scope.Scope>,
  ): LayerType.Layer<QueryCache | ActorTransport, E, R> =>
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
  /**
   * `QueryEntry.override` on the entry the arguments name at the call: the
   * value shows at once, marked stale, stamped with the principal generation
   * of that moment, and any authoritative value replaces it. A command's
   * rejection does not take it back. With no arguments there is no entry,
   * and nothing is written.
   */
  readonly override: (value: A) => Effect.Effect<void>;
}

interface Following<A, E> {
  readonly key: QueryKey;
  readonly scope: Scope.Closeable;
  readonly refresh: Effect.Effect<void>;
  readonly override: (value: A) => Effect.Effect<void>;
  /** The followed entry's state now. */
  readonly get: Effect.Effect<Stamped<QueryState<A, E>>>;
}

/**
 * While the next key loads, the last value stays on screen marked stale.
 * A view that moved from one page of results to the next keeps the old page
 * dimmed instead of flashing its fallback; the fallback is for having
 * nothing, and it has something.
 *
 * Only within one principal generation. A `Loading` from a later generation
 * is an entry that forgot a value read for somebody else, and the view shows
 * it as it is. A state from an earlier generation is late, and is dropped.
 */
const carry = <A, E>(
  shown: Stamped<QueryState<A, E>>,
  incoming: Stamped<QueryState<A, E>>,
): Stamped<QueryState<A, E>> => {
  if (incoming.principal < shown.principal) {
    return shown;
  }
  if (
    incoming.state._tag === "Loading" &&
    shown.state._tag === "Ready" &&
    incoming.principal === shown.principal
  ) {
    return { state: Ready(shown.state.value, true), principal: shown.principal };
  }
  return incoming;
};

/**
 * Opens one entry with its stamped states. A cache not built here has no
 * generations: every state is stamped with the same one, and the carry
 * rule is the plain one.
 */
const openStamped = <Q extends AnyQuery>(
  cache: QueryCacheService,
  contract: Q,
  args: ArgsOf<Q>,
): Effect.Effect<StampedEntry<Q>, never, ActorTransport | Scope.Scope> =>
  Option.match(internalsOf(cache), {
    onSome: (found) => found.openStamped(contract, args),
    onNone: () =>
      Effect.map(cache.open(contract, args), (entry): StampedEntry<Q> => ({
        entry,
        get: Effect.map(entry.state.get, (state) => ({ state, principal: 0 })),
        changes: Stream.map(entry.state.changes, (state) => ({ state, principal: 0 })),
      })),
  });

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
  const output = yield* SubscriptionRef.make<Stamped<QueryState<ResultOf<Q>, QueryFailure>>>({
    state: Loading(),
    principal: 0,
  });
  let current: Option.Option<Following<ResultOf<Q>, QueryFailure>> = Option.none();
  type Shown = Stamped<QueryState<ResultOf<Q>, QueryFailure>>;
  // The one step that moves what the view is shown: the followed entry's
  // state now, carried over the state shown last. A read and a delivery
  // both take it (see `advance`), so a read never runs ahead of `changes`
  // and a late delivery never undoes a newer value.
  const step = (shown: Shown): Effect.Effect<Shown> =>
    Option.match(current, {
      onNone: () => Effect.succeed(shown),
      onSome: (following) => Effect.map(following.get, (incoming) => carry(shown, incoming)),
    });

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
      const opened = yield* Scope.provide(openStamped(cache, contract, next), child).pipe(
        Effect.provideService(ActorTransport, transport),
      );
      current = Option.some({
        key,
        scope: child,
        refresh: opened.entry.refresh,
        override: opened.entry.override,
        get: opened.get,
      });
      // A delivery only asks for a step: the step reads the entry now.
      yield* Effect.forkIn(
        Stream.runForEach(opened.changes, () => advance(output, step)),
        child,
      );
    });

  const follow = (next: Option.Option<ArgsOf<Q>>) =>
    Option.match(next, {
      onNone: () =>
        Effect.andThen(
          leave,
          advance(output, (shown) =>
            Effect.succeed<Shown>({ state: Loading(), principal: shown.principal }),
          ),
        ),
      onSome: enter,
    });

  yield* follow(yield* args.get);
  yield* Effect.forkScoped(Stream.runForEach(args.changes, follow));

  // A read steps first, so it is never older than the entry: a server
  // render reads it beside the seed and must see what the seed carries.
  const followed: FollowedQuery<ResultOf<Q>, QueryFailure> = {
    state: {
      get: Effect.map(advance(output, step), (shown) => shown.state),
      changes: Stream.map(advancedChanges(output, step), (shown) => shown.state),
    },
    refresh: Effect.suspend(() =>
      Option.match(current, {
        onNone: () => Effect.void,
        onSome: (following) => following.refresh,
      }),
    ),
    override: (value) =>
      Effect.suspend(() =>
        Option.match(current, {
          onNone: () => Effect.void,
          onSome: (following) => following.override(value),
        }),
      ),
  };
  return followed;
});
