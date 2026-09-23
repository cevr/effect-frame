import { Context, Effect, Option, Schema } from "effect";
import type { Address } from "./contract.js";
import type { Authenticated, Principal } from "./principal.js";
import type { QueryKey } from "./query.js";
import { Unauthorized } from "./vocabulary.js";

/**
 * Authorization (#20 §2). One policy model for actors and queries: a policy
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
    return Option.match(decode(subject), {
      onNone: () => refuse(subject),
      onSome: (value) =>
        Effect.flatMap(check(principal, value, action), (allowed) => {
          if (allowed) {
            return Effect.void;
          }
          return refuse(subject);
        }),
    });
  },
});

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
  all,
  any,
  byAction,
};

/** One declaration a host validates: who declared which name. */
export interface Declared {
  readonly subject: "actor" | "query";
  readonly name: string;
  readonly policy: string;
}

/**
 * Every declared name the table does not hold, or nothing. It runs before a
 * host serves anything and reports every miss at once.
 */
export const validate = (
  declared: ReadonlyArray<Declared>,
  table: PolicyTable,
): Effect.Effect<void, PolicyNamesMissing> => {
  const missing = declared.filter((entry) => !Object.hasOwn(table, entry.policy));
  if (missing.length === 0) {
    return Effect.void;
  }
  return Effect.fail(PolicyNamesMissing.make({ missing }));
};

/**
 * The rule a validated name resolves to. The host validated every name at
 * construction, so a miss here means a table assembled some other way.
 */
export const lookup = (table: PolicyTable, name: string): Option.Option<Policy> =>
  Option.filter(Option.some(name), (key) => Object.hasOwn(table, key)).pipe(
    Option.flatMap((key) => Option.fromNullishOr(table[key])),
  );
