import { Policies, Policy } from "effect-frame/actor";
import type { Principal } from "effect-frame/actor";
import { Effect, Layer, Predicate } from "effect";
import { Alerts, Memo, Orders } from "./contract.js";
import { Funnel, OrderDetail, OrderList, Revenue, Slowest, TenantInfo } from "./queries.js";

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

/** Every actor and query this app declares carries its tenant; the rule reads it typed. */
export const tenantMember = Policy.forSubjects(
  {
    contracts: [Orders, Alerts, Memo],
    queries: [TenantInfo, Revenue, OrderList, Funnel, Slowest, OrderDetail],
  },
  (principal, key) => Effect.succeed(tenantsOf(principal).includes(key.tenant)),
);

export const policies = Layer.succeed(Policies, Policies.of({ tenantMember }));
