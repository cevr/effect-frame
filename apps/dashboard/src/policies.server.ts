import { Policies, Unauthorized } from "effect-frame/actor";
import type { Policy, Principal, Subject } from "effect-frame/actor";
import { Effect, Layer, Option, Predicate, Schema } from "effect";

/**
 * The one policy table (#20). One name, `tenantMember`, guards every actor
 * and every query on the dashboard. Each subject carries its tenant in the
 * same field: an actor's key is `{tenant}`, and every query's arguments hold
 * `tenant`. The rule reads it there and checks it against the tenants the
 * principal's claims name. There is no allow-all in this table.
 *
 * The principal comes from a fixture header (`server.ts`), not a session
 * actor: Auth proves the session half, and Dashboard does not prove it
 * again (#25 §4).
 */

const Tenanted = Schema.fromJsonString(Schema.Struct({ tenant: Schema.String }));
const decodeTenant = Schema.decodeUnknownOption(Tenanted);

/** The tenant a subject names: an actor key's, or a query's arguments'. */
const tenantOf = (subject: Subject): Option.Option<string> => {
  if (subject._tag === "Actor") {
    return Option.map(decodeTenant(subject.address.key), (key) => key.tenant);
  }
  return Option.map(decodeTenant(subject.key.args), (args) => args.tenant);
};

/** The tenants a principal's claims name. Anonymous names none. */
export const tenantsOf = (principal: Principal): ReadonlyArray<string> => {
  if (principal._tag === "Anonymous") {
    return [];
  }
  const claimed = principal.claims["tenants"];
  if (!Array.isArray(claimed)) {
    return [];
  }
  return claimed.filter(Predicate.isString);
};

const nameOf = (subject: Subject): string => {
  if (subject._tag === "Actor") {
    return subject.address.contract;
  }
  return subject.key.query;
};

export const tenantMember: Policy = {
  check: (principal, subject) => {
    const tenant = tenantOf(subject);
    if (Option.isSome(tenant) && tenantsOf(principal).includes(tenant.value)) {
      return Effect.void;
    }
    return Effect.fail(Unauthorized.make({ contract: nameOf(subject) }));
  },
};

export const policies = Layer.succeed(Policies, Policies.of({ tenantMember }));
