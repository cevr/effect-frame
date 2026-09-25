import type { FollowedQuery, RemoteActorRef, Source } from "effect-frame/actor/client";
import { Effect } from "effect";
import { AlertsEvent } from "./contract.js";
import type { Alert, Alerts } from "./contract.js";

/**
 * The ack, the one send that writes a guess first, and the header value
 * every view shares. The page draws one actor, `Alerts`: its route binding
 * is the only live stream on the page (#25 §4). The order book and the memo
 * are only commanded: each is a `Route.commandRef` binding, which sends and
 * reads no snapshot, and a view sends through it directly. The framework
 * mints the command id, declares the page's active keys, and applies the
 * refreshes the reply carries; nothing here can fail, and a refusal is a
 * state of the returned handle.
 */

export type AlertsRef = RemoteActorRef<typeof Alerts>;

/** The tenant's header: its name, plan, and how many alerts wait for an ack. */
export interface TenantInfoValue {
  readonly name: string;
  readonly plan: string;
  readonly alerts: number;
}

/**
 * Ack one alert. The alerts are a machine, so nothing predicts the ack; the
 * page writes its guess, one fewer alert waiting, through `override` on the
 * header's `TenantInfo` entry, and then sends (#17, #19 §4). The override
 * shows at once, marked stale. Any authoritative value replaces it: the
 * ack's own refresh, or any other read. A `Rejected` ack does not roll it
 * back; the next authoritative value does.
 */
export const ack = Effect.fn("Dashboard.ack")(function* (
  alerts: Source<AlertsRef>,
  tenant: FollowedQuery<TenantInfoValue, unknown>,
  alert: Alert,
) {
  // An acked alert is no longer waiting: its ack changes no count. The
  // guess derives from the entry the tenant names now, never from the
  // header on screen, which during a tenant switch is still the old
  // tenant's. With no value of its own yet, nothing is written.
  if (!alert.acked) {
    yield* tenant.override((info) => ({ ...info, alerts: Math.max(0, info.alerts - 1) }));
  }
  const current = yield* alerts.get;
  return yield* current.send(AlertsEvent.Ack({ id: alert.id }));
});
