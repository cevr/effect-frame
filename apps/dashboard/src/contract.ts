import { contract } from "effect-frame/actor/client";
import { Schema } from "effect";
import { Event, Machine, State } from "effect-machine";

/**
 * The Dashboard's actor contracts (#25 §4). Browser safe: it imports only
 * `effect` and the client entry of the actor package. Every key carries the
 * tenant, so one policy, `tenantMember`, reads the same field off an actor
 * address, a query key, and a route's params (#20 §6 rule 3).
 */

/** A tenant's id as a route param. It prints as itself. */
export const TenantId = Schema.String.pipe(Schema.brand("TenantId"));
export type TenantId = Schema.Schema.Type<typeof TenantId>;

/** Every actor on the dashboard is one per tenant. */
export const TenantKey = Schema.Struct({ tenant: TenantId });
export type TenantKey = Schema.Schema.Type<typeof TenantKey>;

// ---------------------------------------------------------------------------
// Orders: the order book. Fulfil and Cancel commit to it.
// ---------------------------------------------------------------------------

export const OrderStatus = Schema.Literals(["open", "fulfilled", "cancelled"]);
export type OrderStatus = Schema.Schema.Type<typeof OrderStatus>;

/** One order. `day` counts back from today: 0 is today, 29 is thirty days ago. */
export const Order = Schema.Struct({
  id: Schema.String,
  amount: Schema.Finite,
  day: Schema.Finite,
  status: OrderStatus,
});
export type Order = Schema.Schema.Type<typeof Order>;

/**
 * The book: how many orders are open, and every order. The queries read the
 * rows through this snapshot, as a client would, so a commit here is what
 * makes them stale.
 */
export const OrdersSnapshot = Schema.Struct({ open: Schema.Finite, orders: Schema.Array(Order) });
export type OrdersSnapshot = Schema.Schema.Type<typeof OrdersSnapshot>;

export const Fulfil = Schema.TaggedStruct("Fulfil", { id: Schema.String });
export const Cancel = Schema.TaggedStruct("Cancel", { id: Schema.String });
export const OrdersMessage = Schema.Union([Fulfil, Cancel]);
export type OrdersMessage = Schema.Schema.Type<typeof OrdersMessage>;

export const Orders = contract("Orders", {
  version: 1,
  policy: "tenantMember",
  key: TenantKey,
  snapshot: OrdersSnapshot,
  message: OrdersMessage,
});

// ---------------------------------------------------------------------------
// Alerts: the one live stream. Ack commits to it.
// ---------------------------------------------------------------------------

export const Alert = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  acked: Schema.Boolean,
});
export type Alert = Schema.Schema.Type<typeof Alert>;

/**
 * The alerts are a machine (#25 §4). One state, `Watching`, and one event,
 * `Ack`. A machine never predicts: a client cannot run its transitions, so
 * the page writes its guess of an `Ack`'s effect through `override` on the
 * query that shows it (#17, #19 §4).
 */
export const AlertsState = State({ Watching: { items: Schema.Array(Alert) } });
export const AlertsEvent = Event({ Ack: { id: Schema.String } });

export const alertsMachine = Machine.make({
  state: AlertsState,
  event: AlertsEvent,
  initial: AlertsState.Watching({
    items: [
      { id: "a1", text: "refund rate above 5%", acked: false },
      { id: "a2", text: "checkout p95 over 2s", acked: false },
      { id: "a3", text: "card processor degraded", acked: false },
    ],
  }),
}).on(AlertsState.Watching, AlertsEvent.Ack, ({ state, event }) =>
  AlertsState.Watching({
    items: state.items.map((item) => {
      if (item.id === event.id) {
        return { ...item, acked: true };
      }
      return item;
    }),
  }),
);

export type AlertsSnapshot = typeof alertsMachine.stateSchema.Type;
export type AlertsMessage = typeof alertsMachine.eventSchema.Type;

/** The alert an operator may not ack: the host refuses it (`alerts.server.ts`). */
export const pinnedAlert = "a3";

export const Alerts = contract("Alerts", {
  version: 1,
  policy: "tenantMember",
  key: TenantKey,
  snapshot: alertsMachine.stateSchema,
  message: alertsMachine.eventSchema,
});

// ---------------------------------------------------------------------------
// Memo: the team's one-line note. No query depends on it.
// ---------------------------------------------------------------------------

export const MemoSnapshot = Schema.Struct({ text: Schema.String });
export type MemoSnapshot = Schema.Schema.Type<typeof MemoSnapshot>;

export const Write = Schema.TaggedStruct("Write", { text: Schema.String });
export const MemoMessage = Schema.Union([Write]);
export type MemoMessage = Schema.Schema.Type<typeof MemoMessage>;

/**
 * A commit here refreshes nothing: no query names `Memo` in its `depends`
 * (#17). It is the actor the single-flight arithmetic needs for its zero.
 */
export const Memo = contract("Memo", {
  version: 1,
  policy: "tenantMember",
  key: TenantKey,
  snapshot: MemoSnapshot,
  message: MemoMessage,
});

/** The tenant the demo opens, and the only one its fixture member belongs to. */
export const demoTenant: TenantId = Schema.decodeSync(TenantId)("acme");
