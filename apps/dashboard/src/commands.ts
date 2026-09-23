import { commandRef } from "effect-frame/actor/client";
import type {
  ActorTransport,
  AnyContract,
  FollowedQuery,
  KeyOf,
  RemoteActorRef,
  RemoteCommandRef,
  Source,
} from "effect-frame/actor/client";
import { Effect, Option, Semaphore, Stream } from "effect";
import type { Scope } from "effect";
import { AlertsEvent } from "./contract.js";
import type { Alert, Alerts, Memo, Orders, TenantId } from "./contract.js";

/**
 * The four sends the dashboard makes, and the one reading every view
 * shares. The page draws one actor, `Alerts`: its route binding is the only
 * live stream on the page (#25 §4). The order book and the memo are only
 * commanded, so a view holds a `commandRef` to each: it sends, and it reads
 * no snapshot and follows no stream. The framework mints the command id,
 * declares the page's active keys, and applies the refreshes the reply
 * carries; nothing here can fail, and a refusal is a state of the returned
 * handle.
 */

export type AlertsRef = RemoteActorRef<typeof Alerts>;
export type OrdersCommands = Sender<typeof Orders>;
export type MemoCommands = Sender<typeof Memo>;

/** The page's params, as far as a sender reads them. */
interface Tenanted {
  readonly tenant: TenantId;
}

/**
 * A send-only reference that follows the page's tenant. A view outlives a
 * move between tenants, so each send reads the params it has now and uses
 * that tenant's reference, opened once in the view's Scope.
 */
export interface Sender<C extends AnyContract> {
  readonly current: Effect.Effect<RemoteCommandRef<C>>;
}

export const sender = Effect.fn("Dashboard.sender")(function* <
  C extends AnyContract,
  P extends Tenanted,
>(contract: C, params: Source<P>, keyOf: (params: P) => KeyOf<C>) {
  const context = yield* Effect.context<ActorTransport | Scope.Scope>();
  const opening = yield* Semaphore.make(1);
  const opened = new Map<TenantId, RemoteCommandRef<C>>();
  const current = opening.withPermit(
    Effect.gen(function* () {
      const now = yield* params.get;
      const known = Option.fromNullishOr(opened.get(now.tenant));
      if (Option.isSome(known)) {
        return known.value;
      }
      const fresh = yield* commandRef(contract, keyOf(now)).pipe(Effect.provideContext(context));
      opened.set(now.tenant, fresh);
      return fresh;
    }),
  );
  const made: Sender<C> = { current };
  return made;
});

export const fulfil = Effect.fn("Dashboard.fulfil")(function* (book: OrdersCommands, id: string) {
  const current = yield* book.current;
  return yield* current.send({ _tag: "Fulfil", id });
});

export const cancel = Effect.fn("Dashboard.cancel")(function* (book: OrdersCommands, id: string) {
  const current = yield* book.current;
  return yield* current.send({ _tag: "Cancel", id });
});

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

export const writeMemo = Effect.fn("Dashboard.writeMemo")(function* (
  memo: MemoCommands,
  text: string,
) {
  const current = yield* memo.current;
  return yield* current.send({ _tag: "Write", text });
});

/** The snapshot of whichever reference a route binding holds now. */
export const snapshotOf = <S>(binding: Source<{ readonly state: Source<S> }>): Source<S> => ({
  get: Effect.flatMap(binding.get, (current) => current.state.get),
  changes: Stream.switchMap(binding.changes, (current) => current.state.changes),
});
