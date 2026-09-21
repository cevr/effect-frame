import { Match, Schema } from "effect";
import { dual } from "effect/Function";
import type { Pure } from "./contract.js";
import { Unauthorized, Unreachable } from "./vocabulary.js";

export { canonicalize } from "./canonical-json.js";

/**
 * The client-safe half of the Query primitive (#17): the
 * contract, the cache key, and the wire vocabulary a command reply needs.
 * This module must stay safe to ship to a browser. It never imports a host,
 * a store, or an implementation. `tests/boundary.test.ts` proves that.
 *
 * A query is a named server read over arguments. It has no identity and no
 * mailbox, so nothing here resembles an address. What it does have, and an
 * actor contract does not, is a declared dependency list: the actor
 * contracts whose commits make its cached values stale.
 */

/**
 * What a client may know about a query: its name, protocol version, the
 * shape of its arguments and its result, the authorization policy the host
 * must find, and the actor contract names a commit to which marks it stale.
 * Schemas only.
 */
export interface QueryContract<
  Name extends string,
  Args extends Pure,
  Result extends Pure,
  Policy extends string,
  Mode extends QueryMode = "single",
> {
  readonly name: Name;
  /** Bumped when `args` or `result` changes incompatibly. */
  readonly version: number;
  /** Whether the host reads one key or resolves a declared batch of keys. */
  readonly mode: Mode;
  readonly args: Schema.fromJsonString<Args>;
  readonly result: Schema.fromJsonString<Result>;
  /**
   * The policy the host resolves before serving this query. `"public"` is
   * built into every host and allows every read; any other name must be
   * found in the host's `QueryPolicies` table, or the host refuses the
   * query. A contract that names no policy is public.
   */
  readonly policy: Policy;
  /** Actor contract names. A commit to any of them marks this query stale. */
  readonly depends: ReadonlyArray<string>;
  /** The schemas as given, for embedding inside a larger document. */
  readonly raw: { readonly args: Args; readonly result: Result };
}

export interface QueryOptions<
  Args extends Pure,
  Result extends Pure,
  Policy extends string = "public",
> {
  /** Defaults to 1. */
  readonly version?: number;
  /** Selects one cached value. Include the tenant so a policy can read it. */
  readonly args: Args;
  readonly result: Result;
  /**
   * Named, never inline: the host owns the rule, the contract owns the name.
   * Defaults to `"public"`, the one policy every host resolves.
   */
  readonly policy?: Policy;
  /**
   * The actor contracts this query reads from, as contracts rather than
   * strings, so a rename cannot silently break the dependency edge. Defaults
   * to none: no commit marks the query stale.
   */
  readonly depends?: ReadonlyArray<{ readonly name: string }>;
}

/** The policy name every host resolves: it allows every read. */
export const publicPolicy = "public";

export type QueryMode = "single" | "batched";

export type SingleQuery = QueryContract<string, Pure, Pure, string, "single">;
export type BatchedQuery = QueryContract<string, Pure, Pure, string, "batched">;
export type AnyQuery = QueryContract<string, Pure, Pure, string, QueryMode>;

export type ArgsOf<Q extends AnyQuery> = Q["args"]["Type"];
export type ResultOf<Q extends AnyQuery> = Q["result"]["Type"];

/**
 * Two signatures, so the contract's `Policy` is exactly what was written:
 * `"public"` when nothing was, and the given name otherwise. One signature
 * with a default type parameter would need a cast to say the same thing.
 */
const makeQuery = <
  const Name extends string,
  Args extends Pure,
  Result extends Pure,
  const Mode extends QueryMode,
>(
  name: Name,
  options: QueryOptions<Args, Result, string>,
  mode: Mode,
): QueryContract<Name, Args, Result, string, Mode> => ({
  name,
  version: options.version ?? 1,
  mode,
  args: Schema.fromJsonString(options.args),
  result: Schema.fromJsonString(options.result),
  policy: options.policy ?? publicPolicy,
  depends: (options.depends ?? []).map((dependency) => dependency.name),
  raw: { args: options.args, result: options.result },
});

export function query<const Name extends string, Args extends Pure, Result extends Pure>(
  name: Name,
  options: Omit<QueryOptions<Args, Result, never>, "policy">,
): QueryContract<Name, Args, Result, "public", "single">;
export function query<
  const Name extends string,
  Args extends Pure,
  Result extends Pure,
  const Policy extends string,
>(
  name: Name,
  options: QueryOptions<Args, Result, Policy> & { readonly policy: Policy },
): QueryContract<Name, Args, Result, Policy, "single">;
export function query<const Name extends string, Args extends Pure, Result extends Pure>(
  name: Name,
  options: QueryOptions<Args, Result, string>,
): QueryContract<Name, Args, Result, string, "single"> {
  return makeQuery(name, options, "single");
}

/**
 * Declares that this query is served by one resolver for a collected set of
 * arguments. The server implementation is still supplied separately with
 * `Query.batched`; keeping the marker on the client contract makes the
 * transport choice visible to a reader and to the cache.
 */
export namespace query {
  export function batched<const Name extends string, Args extends Pure, Result extends Pure>(
    name: Name,
    options: Omit<QueryOptions<Args, Result, never>, "policy">,
  ): QueryContract<Name, Args, Result, "public", "batched">;
  export function batched<
    const Name extends string,
    Args extends Pure,
    Result extends Pure,
    const Policy extends string,
  >(
    name: Name,
    options: QueryOptions<Args, Result, Policy> & { readonly policy: Policy },
  ): QueryContract<Name, Args, Result, Policy, "batched">;
  export function batched<const Name extends string, Args extends Pure, Result extends Pure>(
    name: Name,
    options: QueryOptions<Args, Result, string>,
  ): QueryContract<Name, Args, Result, string, "batched"> {
    return makeQuery(name, options, "batched");
  }
}

// ---------------------------------------------------------------------------
// Cache key
// ---------------------------------------------------------------------------

/**
 * Where one cached query value lives. Every field is a string, like an
 * `Address`, but a key is a value and not a place: two clients that encode
 * the same arguments name the same cache entry.
 */
export interface QueryKey {
  readonly query: string;
  readonly version: number;
  readonly args: string;
}

/**
 * The cache key as one string. `args` is already canonical JSON, so the
 * identity of a key is the identity of its encoded arguments.
 */
export const keyOf = (key: QueryKey): string => `${key.query}@${key.version}/${key.args}`;

// ---------------------------------------------------------------------------
// Query state
// ---------------------------------------------------------------------------

/**
 * What a client can observe about a query at one moment. Never two of these
 * at once. Ticket #16 builds readiness over this same union; the tags and
 * the field names are the coordination point and must not drift.
 */
export type QueryState<A, E> = QueryLoading | QueryReady<A> | QueryFailedState<E>;

export interface QueryLoading {
  readonly _tag: "Loading";
}

export interface QueryReady<A> {
  readonly _tag: "Ready";
  readonly value: A;
  readonly stale: boolean;
}

export interface QueryFailedState<E> {
  readonly _tag: "Failed";
  readonly error: E;
}

export const isLoading = <A, E>(state: QueryState<A, E>): state is QueryLoading =>
  state._tag === "Loading";

export const isReady = <A, E>(state: QueryState<A, E>): state is QueryReady<A> =>
  state._tag === "Ready";

export const isFailed = <A, E>(state: QueryState<A, E>): state is QueryFailedState<E> =>
  state._tag === "Failed";

/**
 * The case table `match` folds: one function per tag, each given its own
 * member. It is the shape of Effect's `Match.tagsExhaustive`, so a view
 * writes the same table for a query it writes for an actor's state.
 */
export interface QueryStateCases<A, E, Out> {
  readonly Loading: (state: QueryLoading) => Out;
  readonly Ready: (state: QueryReady<A>) => Out;
  readonly Failed: (state: QueryFailedState<E>) => Out;
}

/**
 * Fold the three states. Exhaustive: a fourth state cannot be added quietly.
 *
 * `match(cases)` builds the matcher once and returns the fold; use that form
 * where the fold runs on every update. `match(state, cases)` is the one-shot
 * form and builds a matcher per call: a built matcher costs about a fifth
 * of one built per call and allocates nothing (`tests/perf/match.bench.ts`).
 */
export const match: {
  <A, E, Out>(cases: QueryStateCases<A, E, Out>): (state: QueryState<A, E>) => Out;
  <A, E, Out>(state: QueryState<A, E>, cases: QueryStateCases<A, E, Out>): Out;
} = dual(2, <A, E, Out>(state: QueryState<A, E>, cases: QueryStateCases<A, E, Out>): Out =>
  matcher<A, E, Out>(cases)(state),
);

const matcher = <A, E, Out>(
  cases: QueryStateCases<A, E, Out>,
): ((state: QueryState<A, E>) => Out) => {
  const fold = Match.type<QueryState<A, E>>().pipe(Match.tagsExhaustive(cases));
  // `Match` types its result as `Unify<Out>`, which the checker cannot reduce
  // for a generic `Out`; at every call site `Out` is concrete and the two
  // are the same type.
  // oxlint-disable-next-line effect/noAs
  return fold as (state: QueryState<A, E>) => Out;
};

export const Loading = <A, E>(): QueryState<A, E> => ({ _tag: "Loading" });

export const Ready = <A, E>(value: A, stale: boolean): QueryState<A, E> => ({
  _tag: "Ready",
  value,
  stale,
});

export const Failed = <A, E>(error: E): QueryState<A, E> => ({ _tag: "Failed", error });

/** The constructors and guards under the type's own name. */
export const QueryState = { Loading, Ready, Failed, isLoading, isReady, isFailed, match };

/** Marks a ready value stale. Loading and Failed have nothing to hold. */
export const markStale = <A, E>(state: QueryState<A, E>): QueryState<A, E> => {
  if (state._tag === "Ready") {
    return Ready(state.value, true);
  }
  return state;
};

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/** No implementation is registered for this query name. */
export class UnknownQuery extends Schema.TaggedError<UnknownQuery>()("UnknownQuery", {
  query: Schema.String,
}) {}

/** The client and server query contracts differ in version. */
export class QueryVersionMismatch extends Schema.TaggedError<QueryVersionMismatch>()(
  "QueryVersionMismatch",
  { query: Schema.String, expected: Schema.Finite, actual: Schema.Finite },
) {}

/**
 * The query names a policy the host cannot resolve. The host refuses to
 * serve it. This is the removed allow-all default, made visible.
 */
export class PolicyMissing extends Schema.TaggedError<PolicyMissing>()("PolicyMissing", {
  query: Schema.String,
  policy: Schema.String,
}) {}

/** The query handler failed. The handler's own error, encoded by the host. */
export class QueryFailed extends Schema.TaggedError<QueryFailed>()("QueryFailed", {
  query: Schema.String,
  detail: Schema.String,
}) {}

/**
 * The arguments did not decode against the server's contract. A client
 * built from the same contract cannot send these; one built from a skewed
 * contract of the same name and version can, and the answer is a typed
 * refusal rather than a defect in the host.
 */
export class InvalidQueryArgs extends Schema.TaggedError<InvalidQueryArgs>()("InvalidQueryArgs", {
  query: Schema.String,
  detail: Schema.String,
}) {}

/**
 * Everything a query read can fail with, including the two failures a
 * transport raises. A query has no address, so `ContractMismatch` and
 * `UnknownContract` cannot apply: a query's own version mismatch is
 * `QueryVersionMismatch`.
 */
export type QueryFailure =
  | UnknownQuery
  | QueryVersionMismatch
  | PolicyMissing
  | InvalidQueryArgs
  | QueryFailed
  | Unauthorized
  | Unreachable;

/** The same union as a Schema, so a value from an untyped place can be narrowed. */
export const QueryFailure = Schema.Union([
  UnknownQuery,
  QueryVersionMismatch,
  PolicyMissing,
  InvalidQueryArgs,
  QueryFailed,
  Unauthorized,
  Unreachable,
]);

export const isQueryFailure = Schema.is(QueryFailure);
