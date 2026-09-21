import { Context, Effect, Option, Result, Schema, Scope } from "effect";
import type {
  AnyQuery,
  ArgsOf,
  BatchedQuery,
  QueryFailure,
  QueryKey,
  ResultOf,
  SingleQuery,
} from "./query.js";
import {
  InvalidQueryArgs,
  PolicyMissing,
  QueryFailed,
  QueryVersionMismatch,
  UnknownQuery,
  canonicalize,
  publicPolicy,
} from "./query.js";
import type { Refreshed, TransportService } from "./transport.js";
import { ActorTransport } from "./transport.js";
import type { Unauthorized } from "./vocabulary.js";

/**
 * The server half of the Query primitive (#17). This module is server-only:
 * it holds handlers and the policy table. It never reaches the client entry.
 */

/** Marker for the import-boundary test: this string must never reach a client bundle. */
export const queryServerOnly = "effect-frame/actor:query-server-only";

/** One result slot produced by a declared batched implementation. */
export type QueryBatchResult =
  | { readonly _tag: "Result"; readonly result: string }
  | { readonly _tag: "Failure"; readonly error: QueryFailure };

/**
 * The server half of a single query contract. The implementation owns every
 * codec, exactly as an actor implementation does.
 */
export interface QueryImplementation<Q extends SingleQuery, R> {
  readonly contract: Q;
  readonly mode: "single";
  /** Decoded args in, encoded result out. Type-erased for the host. */
  readonly run: (args: string) => Effect.Effect<string, QueryFailed | InvalidQueryArgs, R>;
}

/**
 * A batched implementation first loads all decoded arguments and then returns
 * one Effect-producing function. The outer Effect is one backend operation;
 * the inner Effect keeps failures independent for each argument.
 */
export interface BatchedQueryImplementation<Q extends BatchedQuery, R> {
  readonly contract: Q;
  readonly mode: "batched";
  readonly runBatch: (
    args: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<QueryBatchResult>, never, R>;
}

export type AnyQueryImplementation<R> =
  | QueryImplementation<SingleQuery, R | ActorTransport | Scope.Scope>
  | BatchedQueryImplementation<BatchedQuery, R | ActorTransport | Scope.Scope>;

/**
 * `ActorTransport` and `Scope` are supplied by the host, so they leave the
 * implementation's requirements: a handler may open an actor reference, and
 * the reference lives exactly as long as the one read. That is what lets one
 * host own both halves with no cycle and no second instance set.
 */
export const implementQuery = <Q extends SingleQuery, E, R>(
  contract: Q,
  handler: (args: ArgsOf<Q>) => Effect.Effect<ResultOf<Q>, E, R>,
): QueryImplementation<Q, R> => {
  const decodeArgs = Schema.decodeEffect(contract.args);
  const encodeResult = Schema.encodeEffect(contract.result);
  return {
    contract,
    mode: "single",
    run: (args) =>
      decodeArgs(args).pipe(
        // Arguments that do not decode are the caller's fault, not a defect
        // in the host: a typed refusal the client can show.
        Effect.mapError((error) =>
          InvalidQueryArgs.make({ query: contract.name, detail: error.message }),
        ),
        Effect.flatMap((decoded) =>
          handler(decoded).pipe(
            // The handler's own error is the author's; the host reports it as
            // one typed failure so a bad read never breaks the protocol.
            Effect.mapError((error) =>
              QueryFailed.make({ query: contract.name, detail: String(error) }),
            ),
          ),
        ),
        Effect.flatMap((result) => Effect.orDie(encodeResult(result))),
      ),
  };
};

export interface BatchedQueryOptions<Q extends BatchedQuery, E, R> {
  /**
   * Receives every valid, authorized argument in one collected request. The
   * returned function may fail one argument without failing its neighbors.
   */
  readonly resolve: (
    args: ReadonlyArray<ArgsOf<Q>>,
  ) => Effect.Effect<(arg: ArgsOf<Q>) => Effect.Effect<ResultOf<Q>, E, R>, E, R>;
}

const failed = <E>(contract: AnyQuery, error: E): QueryFailed =>
  QueryFailed.make({ query: contract.name, detail: String(error) });

/**
 * Builds a declared batched query. `Query.batched(contract, { resolve })` is
 * the server spelling; the contract itself carries the client-side marker
 * made by `query.batched(...)`.
 */
export const batched = <Q extends BatchedQuery, E, R>(
  contract: Q,
  options: BatchedQueryOptions<Q, E, R>,
): BatchedQueryImplementation<Q, R> => {
  const decodeArgs = Schema.decodeEffect(contract.args);
  const encodeResult = Schema.encodeEffect(contract.result);

  const runBatch = (encoded: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const decoded = yield* Effect.forEach(encoded, (value, index) =>
        Effect.map(Effect.result(decodeArgs(value)), (result) => ({ index, result })),
      );
      const results = new Map<number, QueryBatchResult>();
      const valid: Array<{ readonly index: number; readonly value: ArgsOf<Q> }> = [];

      for (const item of decoded) {
        if (Result.isFailure(item.result)) {
          results.set(item.index, {
            _tag: "Failure",
            error: InvalidQueryArgs.make({
              query: contract.name,
              detail: item.result.failure.message,
            }),
          });
        } else {
          valid.push({ index: item.index, value: item.result.success });
        }
      }

      if (valid.length > 0) {
        const resolved = yield* Effect.result(options.resolve(valid.map((item) => item.value)));
        if (Result.isFailure(resolved)) {
          const error = failed(contract, resolved.failure);
          for (const item of valid) {
            results.set(item.index, { _tag: "Failure", error });
          }
        } else {
          const resolveOne = resolved.success;
          const values = yield* Effect.forEach(
            valid,
            (item) =>
              Effect.map(
                Effect.result(
                  resolveOne(item.value).pipe(
                    Effect.mapError((error) => failed(contract, error)),
                    Effect.flatMap((result) => Effect.orDie(encodeResult(result))),
                  ),
                ),
                (result) => ({ index: item.index, result }),
              ),
            { concurrency: 16 },
          );
          for (const item of values) {
            if (Result.isFailure(item.result)) {
              results.set(item.index, { _tag: "Failure", error: item.result.failure });
            } else {
              results.set(item.index, { _tag: "Result", result: item.result.success });
            }
          }
        }
      }

      return encoded.map((_, index) =>
        Option.getOrElse(
          Option.fromNullishOr(results.get(index)),
          () =>
            ({
              _tag: "Failure",
              error: QueryFailed.make({
                query: contract.name,
                detail: "batch resolver omitted an argument",
              }),
            }) satisfies QueryBatchResult,
        ),
      );
    });

  return { contract, mode: "batched", runBatch };
};

/** The server-facing namespace named by issue #54. */
export const Query = { batched };

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** Decides whether the caller may read one query with these arguments. */
export interface QueryPolicy {
  readonly check: (key: QueryKey) => Effect.Effect<void, Unauthorized>;
}

/**
 * The policy table. `"public"` is resolved by every host and allows every
 * read; a table entry of that name replaces it. Every other name a query uses
 * must be in the table, or the host refuses the query.
 */
export interface PolicyTable {
  readonly [name: string]: QueryPolicy;
}

const noPolicies: PolicyTable = {};

/** The built-in `"public"` policy: every read is allowed. */
export const allowAll: QueryPolicy = { check: () => Effect.void };

export const QueryPolicies = Context.Reference<PolicyTable>(
  "effect-frame/src/actor/query-host/QueryPolicies",
  { defaultValue: () => noPolicies },
);

// ---------------------------------------------------------------------------
// The query host
// ---------------------------------------------------------------------------

/**
 * Serves queries and answers which of a caller's active keys a commit to one
 * actor contract made stale. The host batches only implementations that
 * declared batching; the endpoint itself remains one request.
 */
export interface QueryServing {
  /** Reads one query. Resolves the policy first. */
  readonly get: (key: QueryKey) => Effect.Effect<string, QueryFailure>;
  /** Resolves several keys, preserving one result or failure per key. */
  readonly batch: (keys: ReadonlyArray<QueryKey>) => Effect.Effect<ReadonlyArray<Refreshed>, never>;
  /**
   * Of the caller's active keys, the ones whose query declares a dependency
   * on this actor contract name. Pure: it reads the contracts, not a registry
   * of live subscriptions.
   */
  readonly dependents: (
    contractName: string,
    active: ReadonlyArray<QueryKey>,
  ) => ReadonlyArray<QueryKey>;
}

export interface QueryHostOptions<R> {
  readonly queries: ReadonlyArray<AnyQueryImplementation<R>>;
}

/**
 * Why the query host is built inside the actor host rather than beside it.
 *
 * A query handler reads actors, so it needs `ActorTransport`. The actor host
 * needs the query host to answer a command's single-flight refresh. Two layers
 * would be a cycle, and a second `ActorHost.layer` to break it would open a
 * second set of instances: the query would read state the command never
 * touched. So there is one host.
 */

const resolve = <R>(
  byName: Map<string, AnyQueryImplementation<R>>,
  key: QueryKey,
): Effect.Effect<AnyQueryImplementation<R>, UnknownQuery | QueryVersionMismatch> =>
  Option.match(Option.fromNullishOr(byName.get(key.query)), {
    onNone: () => Effect.fail(UnknownQuery.make({ query: key.query })),
    onSome: (implementation) => {
      if (implementation.contract.version !== key.version) {
        return Effect.fail(
          QueryVersionMismatch.make({
            query: key.query,
            expected: implementation.contract.version,
            actual: key.version,
          }),
        );
      }
      return Effect.succeed(implementation);
    },
  });

interface Prepared {
  readonly index: number;
  readonly key: QueryKey;
}

const omittedQueryRefresh = (key: QueryKey): Refreshed => ({
  _tag: "RefreshFailed",
  key,
  error: QueryFailed.make({ query: key.query, detail: "query batch omitted a key" }),
});

export const make = <R>(
  options: QueryHostOptions<R>,
  transport: TransportService,
): Effect.Effect<QueryServing, never, R> =>
  Effect.gen(function* () {
    const captured = yield* Effect.context<R>();
    // The host owns both services. Keep the per-read scope fresh as well, so
    // a resolver's resources end when this batch finishes.
    const context = captured.pipe(Context.omit(Scope.Scope), Context.omit(ActorTransport));
    // oxlint-disable-next-line effect/noAs -- host keys were removed at this boundary.
    const applicationContext = context as Context.Context<R>;
    const policies = yield* QueryPolicies;
    const byName = new Map(
      options.queries.map((implementation) => [implementation.contract.name, implementation]),
    );

    const authorize = (
      implementation: AnyQueryImplementation<R>,
      key: QueryKey,
    ): Effect.Effect<void, PolicyMissing | Unauthorized> => {
      const named = implementation.contract.policy;
      const found = Option.orElse(Option.fromNullishOr(policies[named]), () =>
        Option.filter(Option.some(allowAll), () => named === publicPolicy),
      );
      return Option.match(found, {
        onNone: () => Effect.fail(PolicyMissing.make({ query: key.query, policy: named })),
        onSome: (policy) => policy.check(key),
      });
    };

    const provide = <A, E extends QueryFailure>(
      effect: Effect.Effect<A, E, R | ActorTransport | Scope.Scope>,
    ): Effect.Effect<A, E, Scope.Scope> =>
      Effect.provideService(
        Effect.provideContext(effect, applicationContext),
        ActorTransport,
        transport,
      );

    const runSingle = (
      implementation: QueryImplementation<SingleQuery, R | ActorTransport | Scope.Scope>,
      key: QueryKey,
    ): Effect.Effect<string, QueryFailure> =>
      Effect.scoped(provide(implementation.run(canonicalize(key.args))));

    const runBatched = (
      implementation: BatchedQueryImplementation<BatchedQuery, R | ActorTransport | Scope.Scope>,
      keys: ReadonlyArray<Prepared>,
    ): Effect.Effect<ReadonlyArray<QueryBatchResult>, never> =>
      Effect.scoped(
        provide(implementation.runBatch(keys.map((entry) => canonicalize(entry.key.args)))),
      );

    const batch = (keys: ReadonlyArray<QueryKey>): Effect.Effect<ReadonlyArray<Refreshed>, never> =>
      Effect.gen(function* () {
        const results = new Map<number, Refreshed>();
        const groups = new Map<AnyQueryImplementation<R>, Array<Prepared>>();
        const checked = yield* Effect.forEach(keys, (key, index) =>
          Effect.map(
            Effect.result(
              Effect.gen(function* () {
                const implementation = yield* resolve(byName, key);
                yield* authorize(implementation, key);
                return { implementation, prepared: { index, key } };
              }),
            ),
            (result) => ({ index, key, result }),
          ),
        );

        for (const item of checked) {
          if (Result.isFailure(item.result)) {
            results.set(item.index, {
              _tag: "RefreshFailed",
              key: item.key,
              error: item.result.failure,
            });
          } else {
            const success = item.result.success;
            const implementation = success.implementation;
            const prepared = success.prepared;
            Option.match(Option.fromNullishOr(groups.get(implementation)), {
              onNone: () => groups.set(implementation, [prepared]),
              onSome: (entries) => entries.push(prepared),
            });
          }
        }

        const runGroup = ([implementation, entries]: [
          AnyQueryImplementation<R>,
          Array<Prepared>,
        ]) =>
          Effect.gen(function* () {
            if (implementation.mode === "single") {
              const single = implementation;
              const values = yield* Effect.forEach(
                entries,
                (entry) =>
                  Effect.map(Effect.result(runSingle(single, entry.key)), (result) => ({
                    entry,
                    result,
                  })),
                { concurrency: 16 },
              );
              for (const value of values) {
                if (Result.isFailure(value.result)) {
                  results.set(value.entry.index, {
                    _tag: "RefreshFailed",
                    key: value.entry.key,
                    error: value.result.failure,
                  });
                } else {
                  results.set(value.entry.index, {
                    _tag: "Refreshed",
                    key: value.entry.key,
                    result: value.result.success,
                  });
                }
              }
            } else {
              const batchedImplementation = implementation;
              const values = yield* runBatched(batchedImplementation, entries);
              entries.forEach((entry, index) => {
                const value = Option.fromNullishOr(values[index]);
                Option.match(value, {
                  onNone: () =>
                    results.set(entry.index, {
                      _tag: "RefreshFailed",
                      key: entry.key,
                      error: QueryFailed.make({
                        query: entry.key.query,
                        detail: "batch resolver omitted an argument",
                      }),
                    }),
                  onSome: (result) => {
                    if (result._tag === "Result") {
                      results.set(entry.index, {
                        _tag: "Refreshed",
                        key: entry.key,
                        result: result.result,
                      });
                    } else {
                      results.set(entry.index, {
                        _tag: "RefreshFailed",
                        key: entry.key,
                        error: result.error,
                      });
                    }
                  },
                });
              });
            }
          });

        yield* Effect.forEach(Array.from(groups.entries()), runGroup, {
          concurrency: 16,
          discard: true,
        });
        return keys.map((key, index) =>
          Option.getOrElse(Option.fromNullishOr(results.get(index)), () =>
            omittedQueryRefresh(key),
          ),
        );
      });

    const get = (key: QueryKey): Effect.Effect<string, QueryFailure> =>
      Effect.gen(function* () {
        const result = yield* batch([key]);
        const first = Option.fromNullishOr(result[0]);
        if (Option.isNone(first)) {
          return yield* QueryFailed.make({ query: key.query, detail: "query batch omitted a key" });
        }
        if (first.value._tag === "RefreshFailed") {
          return yield* first.value.error;
        }
        return first.value.result;
      });

    const dependents = (contractName: string, active: ReadonlyArray<QueryKey>) =>
      active.filter((key) =>
        Option.match(Option.fromNullishOr(byName.get(key.query)), {
          onNone: () => false,
          onSome: (implementation) => implementation.contract.depends.includes(contractName),
        }),
      );

    const serving: QueryServing = { get, batch, dependents };
    return serving;
  });
