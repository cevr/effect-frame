import { Array as Arr, Context, Effect, Option, Result, Schema } from "effect";
import type { Address, AnyContract, KeyOf } from "./contract.js";
import type { Authenticated, Principal } from "./principal.js";
import type { AnyQuery, ArgsOf, QueryKey } from "./query.js";
import { Unauthorized } from "./vocabulary.js";

/**
 * Authorization. One policy model for actors and queries: a policy
 * is a function over a principal, a subject, and an action, registered by
 * name in one table that the root host requires. There is no default table
 * and no default rule. Allow-all exists only where it is written by name.
 *
 * This module is server-only, like the host that reads it. The client entry
 * never imports it: a client bundle can name a policy and never holds one.
 * `tests/actor/boundary.test.ts` builds the client entry and proves it.
 */

/** What is being reached for. A query has no identity; an actor does. */
export type Subject =
  | { readonly _tag: "Actor"; readonly address: Address }
  | { readonly _tag: "Query"; readonly key: QueryKey };

/** What is being done to it. `read` covers snapshot and changes; `send` covers send and call. */
export type Action = "read" | "send";

/**
 * One rule. It sees who is asking, what they reach for, and what they want
 * to do. A policy that needs data reads an actor or a query through its own
 * context, exactly as a query handler does.
 */
export interface Policy {
  readonly check: (
    principal: Principal,
    subject: Subject,
    action: Action,
  ) => Effect.Effect<void, Unauthorized>;
}

/** Name to rule. The root host requires one, and there is no default. */
export interface PolicyTable {
  readonly [name: string]: Policy;
}

/**
 * The table. A `Context.Service` and not a `Context.Reference`, because a
 * reference must have a default and every default here is wrong: with no
 * table in context, a host does not compile.
 */
export class Policies extends Context.Service<Policies, PolicyTable>()(
  "effect-frame/src/actor/policy/Policies",
) {}

/** One declared name the host's table does not hold. */
export const MissingPolicy = Schema.Struct({
  subject: Schema.Literals(["actor", "query"]),
  /** The contract or query name that declared it. */
  name: Schema.String,
  /** The policy name it declared. */
  policy: Schema.String,
});
export type MissingPolicy = Schema.Schema.Type<typeof MissingPolicy>;

/**
 * A contract or a query names a policy the host's table does not hold. The
 * host fails to build with every miss listed, so one wiring pass fixes all.
 */
export class PolicyNamesMissing extends Schema.TaggedError<PolicyNamesMissing>()(
  "PolicyNamesMissing",
  { missing: Schema.Array(MissingPolicy) },
) {}

/** The name a refusal carries: the contract or the query reached for. */
export const nameOf = (subject: Subject): string => {
  if (subject._tag === "Actor") {
    return subject.address.contract;
  }
  return subject.key.query;
};

const refuse = (subject: Subject): Effect.Effect<never, Unauthorized> =>
  Effect.fail(Unauthorized.make({ contract: nameOf(subject) }));

const allowAll: Policy = { check: () => Effect.void };

const authenticated: Policy = {
  check: (principal, subject) => {
    if (principal._tag === "Authenticated") {
      return Effect.void;
    }
    return refuse(subject);
  },
};

/** Runs `check` on what `decode` reads from the subject; nothing read refuses. */
const decided = <P, A>(
  principal: P,
  subject: Subject,
  action: Action,
  decode: (subject: Subject) => Option.Option<A>,
  check: (principal: P, value: A, action: Action) => Effect.Effect<boolean>,
): Effect.Effect<void, Unauthorized> =>
  Option.match(decode(subject), {
    onNone: () => refuse(subject),
    onSome: (value) =>
      Effect.flatMap(check(principal, value, action), (allowed) => {
        if (allowed) {
          return Effect.void;
        }
        return refuse(subject);
      }),
  });

/**
 * Narrows to an authenticated principal and a decoded subject. An anonymous
 * caller, or a subject `decode` does not recognize, is refused before
 * `check` runs.
 */
const of = <A>(
  decode: (subject: Subject) => Option.Option<A>,
  check: (principal: Authenticated, value: A, action: Action) => Effect.Effect<boolean>,
): Policy => ({
  check: (principal, subject, action) => {
    if (principal._tag !== "Authenticated") {
      return refuse(subject);
    }
    return decided(principal, subject, action, decode, check);
  },
});

/** The subjects a `forSubjects` rule reads: contracts by their key, queries by their arguments. */
export interface PolicySubjects<
  Contracts extends ReadonlyArray<AnyContract>,
  Queries extends ReadonlyArray<AnyQuery>,
> {
  readonly contracts: Contracts;
  readonly queries: Queries;
}

/** The decoded key of a named contract, or the decoded arguments of a named query. */
export type PolicySubjectKey<
  Contracts extends ReadonlyArray<AnyContract>,
  Queries extends ReadonlyArray<AnyQuery>,
> = KeyOf<Contracts[number]> | ArgsOf<Queries[number]>;

/**
 * A rule over typed keys. It names the contracts and queries it reads, and
 * `check` gets the subject's key or arguments decoded by that contract's or
 * query's own codec, so a rule never parses the wire form. A subject it
 * does not name, of another version, or whose key does not decode is
 * refused before `check` runs. The principal is not narrowed: combine with
 * `Policy.authenticated` through `Policy.all` to refuse Anonymous.
 *
 * ```ts
 * const tenantMember = Policy.forSubjects(
 *   { contracts: [Ledger], queries: [Totals] },
 *   (who, key) => Effect.succeed(tenantsOf(who).includes(key.tenant)),
 * );
 * ```
 */
const forSubjects = <
  const Contracts extends ReadonlyArray<AnyContract>,
  const Queries extends ReadonlyArray<AnyQuery>,
>(
  subjects: PolicySubjects<Contracts, Queries>,
  check: (
    principal: Principal,
    key: PolicySubjectKey<Contracts, Queries>,
    action: Action,
  ) => Effect.Effect<boolean>,
): Policy => {
  const decode = (subject: Subject): Option.Option<PolicySubjectKey<Contracts, Queries>> => {
    if (subject._tag === "Actor") {
      return Option.flatMap(
        Arr.findFirst(
          subjects.contracts,
          (named) =>
            named.name === subject.address.contract && named.version === subject.address.version,
        ),
        (named): Option.Option<KeyOf<Contracts[number]>> =>
          Schema.decodeUnknownOption(named.key)(subject.address.key),
      );
    }
    return Option.flatMap(
      Arr.findFirst(
        subjects.queries,
        (named) => named.name === subject.key.query && named.version === subject.key.version,
      ),
      (named): Option.Option<ArgsOf<Queries[number]>> =>
        Schema.decodeUnknownOption(named.args)(subject.key.args),
    );
  };
  return {
    check: (principal, subject, action) => decided(principal, subject, action, decode, check),
  };
};

/** Allows only when every policy allows. No policies allow everything. */
const all = (...policies: ReadonlyArray<Policy>): Policy => ({
  check: (principal, subject, action) =>
    Effect.forEach(policies, (policy) => policy.check(principal, subject, action), {
      discard: true,
    }),
});

/** Allows when one policy allows. No policies refuse everything. */
const any = (...policies: ReadonlyArray<Policy>): Policy => ({
  check: (principal, subject, action) =>
    Effect.firstSuccessOf([
      ...policies.map((policy) => policy.check(principal, subject, action)),
      refuse(subject),
    ]),
});

/** Different rules per action. Both branches are required. */
const byAction = (rules: { readonly read: Policy; readonly send: Policy }): Policy => ({
  check: (principal, subject, action) => rules[action].check(principal, subject, action),
});

export const Policy = {
  /** Allows everything. The only way to write allow-all: by name, on purpose. */
  allowAll,
  /** Requires any authenticated principal. */
  authenticated,
  of,
  forSubjects,
  all,
  any,
  byAction,
};

/** One declaration a host resolves: who declared which name. */
export interface Declared {
  readonly subject: "actor" | "query";
  readonly name: string;
  readonly policy: string;
}

/** A declaration with the rule its policy name resolved to. */
export interface Resolved<A> {
  readonly entry: A;
  readonly policy: Policy;
}

/** The entries whose names the table holds, and every declaration it does not. */
export interface Resolution<A> {
  readonly resolved: ReadonlyArray<Resolved<A>>;
  readonly missing: ReadonlyArray<MissingPolicy>;
}

/**
 * Resolves each entry's policy name against the table once, before a host
 * serves anything. A resolved entry carries its rule, so a later check never
 * looks a name up and has no miss to handle.
 */
export const resolve = <A>(
  table: PolicyTable,
  entries: ReadonlyArray<A>,
  declare: (entry: A) => Declared,
): Resolution<A> => {
  const [missing, resolved] = Arr.partition(entries, (entry) => {
    const declared = declare(entry);
    return Option.match(
      Option.filter(Option.some(declared.policy), (name) => Object.hasOwn(table, name)).pipe(
        Option.flatMap((name) => Option.fromNullishOr(table[name])),
      ),
      {
        onNone: () => Result.fail(declared),
        onSome: (policy) => Result.succeed({ entry, policy }),
      },
    );
  });
  return { resolved, missing };
};

/**
 * Fails with every miss of every resolution at once, so one wiring pass
 * fixes all. Nothing missing: it succeeds.
 */
export const refuseMissing = (
  resolutions: ReadonlyArray<Resolution<unknown>>,
): Effect.Effect<void, PolicyNamesMissing> => {
  const missing = resolutions.flatMap((resolution) => resolution.missing);
  if (missing.length === 0) {
    return Effect.void;
  }
  return Effect.fail(PolicyNamesMissing.make({ missing }));
};
