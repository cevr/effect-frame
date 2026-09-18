import type { Layer as LayerType } from "effect";
import { Context, Effect, Layer, Option, Schema, SubscriptionRef } from "effect";
import type { AnyQuery, ArgsOf, QueryFailure, QueryKey, QueryState, ResultOf } from "./query.js";
import { Failed, Loading, Ready, canonicalize, keyOf, markStale } from "./query.js";
import type { Source } from "./source.js";
import { fromSubscriptionRef } from "./source.js";
import type { Refreshed } from "./transport.js";
import { ActorTransport } from "./transport.js";

/**
 * PROTOTYPE (ticket #17). The client half of the Query primitive: a cache
 * keyed by encoded arguments, a `QueryState` source per entry, and the
 * declaration of which entries are active so a command reply can refresh
 * them. Client-safe: it holds the contract and a transport, never a handler.
 */

/** One live cache entry. The `Source` is what a view binds to. */
export interface QueryEntry<A, E> {
  readonly key: QueryKey;
  readonly state: Source<QueryState<A, E>>;
  /** Reads the current value from the server and replaces the entry. */
  readonly refresh: Effect.Effect<void>;
  /**
   * Shows a value the caller supplies, marked stale, until the next refresh
   * lands. The escape hatch for optimistic values the dependency graph
   * cannot derive: an actor commit refreshes automatically, and this is for
   * everything else.
   */
  readonly override: (value: A) => Effect.Effect<void>;
}

/** Erased entry, for the cache's own bookkeeping across query types. */
interface CacheSlot {
  readonly key: QueryKey;
  /** Marks the entry stale in place. Used when a dependency commits. */
  readonly markStale: Effect.Effect<void>;
  /** Replaces the entry from an encoded result the wire delivered. */
  readonly accept: (encoded: string) => Effect.Effect<void>;
  /** Records a refresh that the server could not serve. */
  readonly reject: (error: QueryFailure) => Effect.Effect<void>;
}

/**
 * The client's query cache. One per client runtime, wired centrally: a view
 * never constructs one, and `ref` reads this same service to learn which
 * keys to declare active. There is exactly one place that knows what is on
 * screen, so `active` is derived from the cache and never synced beside it.
 */
export interface QueryCacheService {
  readonly open: <Q extends AnyQuery>(
    contract: Q,
    args: ArgsOf<Q>,
  ) => Effect.Effect<QueryEntry<ResultOf<Q>, QueryFailure>, never, ActorTransport>;
  /** Every key the cache currently holds. This is what a command declares active. */
  readonly active: Effect.Effect<ReadonlyArray<QueryKey>>;
  /** Applies the refreshes a command reply carried. */
  readonly apply: (refreshed: ReadonlyArray<Refreshed>) => Effect.Effect<void>;
  /**
   * Marks every cached entry whose query depends on this contract stale.
   * The client does this the moment a command is sent, so the view shows
   * stale content before the reply arrives rather than after it.
   */
  readonly invalidate: (contractName: string) => Effect.Effect<void>;
}

export class QueryCache extends Context.Service<QueryCache, QueryCacheService>()(
  "@effect-frame/actor/src/query-client/QueryCache",
) {}

const encodeKey = <Q extends AnyQuery>(contract: Q, args: ArgsOf<Q>): Effect.Effect<QueryKey> =>
  Effect.map(Effect.orDie(Schema.encodeEffect(contract.args)(args)), (encoded) => ({
    query: contract.name,
    version: contract.version,
    // Canonical from the start: two callers who spell the same arguments in
    // a different field order must land on one entry, not two.
    args: canonicalize(encoded),
  }));

const makeSlot = <Q extends AnyQuery>(
  contract: Q,
  key: QueryKey,
  state: SubscriptionRef.SubscriptionRef<QueryState<ResultOf<Q>, QueryFailure>>,
): CacheSlot => {
  const decodeResult = Schema.decodeEffect(contract.result);
  return {
    key,
    markStale: SubscriptionRef.update(state, markStale),
    accept: (encoded) =>
      Effect.flatMap(Effect.orDie(decodeResult(encoded)), (value) =>
        SubscriptionRef.set(state, Ready(value, false)),
      ),
    reject: (error) => SubscriptionRef.set(state, Failed(error)),
  };
};

const make = (): Effect.Effect<QueryCacheService> =>
  Effect.sync(() => {
    const slots = new Map<string, CacheSlot>();

    const open = <Q extends AnyQuery>(contract: Q, args: ArgsOf<Q>) =>
      Effect.gen(function* () {
        const transport = yield* ActorTransport;
        const key = yield* encodeKey(contract, args);
        const id = keyOf(key);
        const state = yield* SubscriptionRef.make<QueryState<ResultOf<Q>, QueryFailure>>(Loading());
        const slot = makeSlot(contract, key, state);
        // An entry that already exists keeps its value; a second view binding
        // to the same key must not restart it as Loading.
        const existing = Option.fromNullishOr(slots.get(id));
        if (Option.isNone(existing)) {
          slots.set(id, slot);
        }

        const load = transport.query(key).pipe(
          Effect.flatMap(slot.accept),
          Effect.catch((error) => slot.reject(error)),
        );
        yield* load;

        const entry: QueryEntry<ResultOf<Q>, QueryFailure> = {
          key,
          state: fromSubscriptionRef(state),
          refresh: load,
          override: (value) => SubscriptionRef.set(state, Ready(value, true)),
        };
        return entry;
      });

    const active = Effect.sync(() => Array.from(slots.values(), (slot) => slot.key));

    const apply = (refreshed: ReadonlyArray<Refreshed>) =>
      Effect.forEach(
        refreshed,
        (one) =>
          Option.match(Option.fromNullishOr(slots.get(keyOf(one.key))), {
            onNone: () => Effect.void,
            onSome: (slot) => {
              if (one._tag === "Refreshed") {
                return slot.accept(one.result);
              }
              return slot.reject(one.error);
            },
          }),
        { discard: true },
      );

    /**
     * The client cannot read a query's `depends` list from a key alone, so
     * the contracts it has opened are remembered here by name.
     */
    const dependsByQuery = new Map<string, ReadonlyArray<string>>();

    const remember = (contract: AnyQuery) => {
      dependsByQuery.set(contract.name, contract.depends);
    };

    const invalidate = (contractName: string) =>
      Effect.forEach(
        Array.from(slots.values()).filter((slot) =>
          Option.match(Option.fromNullishOr(dependsByQuery.get(slot.key.query)), {
            onNone: () => false,
            onSome: (depends) => depends.includes(contractName),
          }),
        ),
        (slot) => slot.markStale,
        { discard: true },
      );

    const service: QueryCacheService = {
      open: <Q extends AnyQuery>(contract: Q, args: ArgsOf<Q>) => {
        remember(contract);
        return open(contract, args);
      },
      active,
      apply,
      invalidate,
    };
    return service;
  });

export const layer: LayerType.Layer<QueryCache> = Layer.effect(QueryCache, make());

/**
 * Binds one query and returns its state source. The view-facing name; it is
 * `useQuery` in a React-shaped runtime and `ref`-shaped here, but it is the
 * same call: open the entry, get a `Source<QueryState<T>>`.
 */
export const useQuery = Effect.fn("useQuery")(function* <Q extends AnyQuery>(
  contract: Q,
  args: ArgsOf<Q>,
) {
  const cache = yield* QueryCache;
  return yield* cache.open(contract, args);
});
