import { Context, Effect, Equal, Schema, Stream } from "effect";
import type { Source } from "./source.js";

/**
 * Who is asking (#20 §1). This module is client-safe: a value, a schema,
 * and a comparison, with no I/O. A browser may know what a principal is. It
 * never holds the rules that judge one: those are in `policy.ts`.
 */

/** What a session published about its subject. Never private state. */
export const Claims = Schema.Record(Schema.String, Schema.Json);
export type Claims = Schema.Schema.Type<typeof Claims>;

/**
 * Nobody in particular. It carries no fields, so no policy can read a
 * subject off an unauthenticated caller by accident.
 */
export class Anonymous extends Schema.TaggedClass<Anonymous>()("Anonymous", {}) {}

/** A named subject and the claims its session published. */
export class Authenticated extends Schema.TaggedClass<Authenticated>()("Authenticated", {
  /** Stable identity of the caller: a user id, a session subject. */
  subject: Schema.String,
  claims: Claims,
}) {}

export type Principal = Anonymous | Authenticated;

/**
 * Who is asking, for the life of one request. The default is `Anonymous`.
 * That default grants nothing: every contract and query names a policy, and
 * a policy that does not name `Anonymous` refuses it.
 */
export const CurrentPrincipal = Context.Reference<Principal>(
  "effect-frame/src/actor/principal/CurrentPrincipal",
  { defaultValue: (): Principal => Anonymous.make({}) },
);

/**
 * One principal a source published, and its number. The first value a
 * source emits has some number; every later change has a larger one. Two
 * equal principals in a row are one revision, not two.
 */
export interface PrincipalRevision {
  readonly principal: Principal;
  readonly revision: number;
}

/**
 * Who is asking, over time (#30 §4). A request reads `get` once and is
 * done. A live connection watches `changes` and ends at the first revision
 * after the one it connected under. `changes` emits the current principal
 * first. A consumer that falls behind may skip revisions, but a later
 * revision still has a larger number, so a change and a change back
 * (A, B, A) can never look like no change at all.
 */
export interface PrincipalSource {
  readonly get: Effect.Effect<Principal>;
  readonly changes: Stream.Stream<PrincipalRevision>;
}

/**
 * Structural equality. Two principals are equal when they are both
 * anonymous, or when they name the same subject with the same claims. A
 * session revision that changes neither is not a change of principal.
 */
const equals = (left: Principal, right: Principal): boolean => Equal.equals(left, right);

/**
 * Numbers a principal over time: each value that is not equal to the one
 * before it is the next revision. A session revision that leaves the
 * principal equal, such as a `Touch`, gets no number.
 */
const revisions = <E, R>(
  changes: Stream.Stream<Principal, E, R>,
): Stream.Stream<PrincipalRevision, E, R> =>
  changes.pipe(
    Stream.changesWith(equals),
    Stream.mapAccum(
      () => 0,
      (revision, principal): readonly [number, ReadonlyArray<PrincipalRevision>] => [
        revision + 1,
        [{ principal, revision }],
      ],
    ),
  );

/** A source from a principal's current value and its changes. */
const fromSource = (source: Source<Principal>): PrincipalSource => ({
  get: source.get,
  changes: revisions(source.changes),
});

/**
 * A principal that never changes: a derivation with no session behind it.
 * Its `changes` is the one current value and then the end, so a connection
 * that watches it holds no subscription and is never ended by it.
 */
const constant = (principal: Principal): PrincipalSource => ({
  get: Effect.succeed(principal),
  changes: Stream.succeed({ principal, revision: 0 }),
});

/** The one anonymous source. A host with no sessions serves every request with it. */
const anonymous: PrincipalSource = constant(Anonymous.make({}));

const isAuthenticated = (principal: Principal): principal is Authenticated =>
  principal._tag === "Authenticated";

export const Principal = { anonymous, constant, equals, fromSource, isAuthenticated, revisions };
