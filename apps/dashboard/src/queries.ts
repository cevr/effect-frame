import { query } from "effect-frame/actor/client";
import { Option, Schema } from "effect";
import type { Order } from "./contract.js";
import { Alerts, Order as OrderRow, Orders, TenantId } from "./contract.js";

/**
 * The six queries Dashboard reads (#17, #25 §4). Browser safe: contracts
 * only. The handlers are in `queries.server.ts`.
 *
 * The `depends` lists are the point of the example. On `/d/acme` the page
 * declares five keys; a `Fulfil` refreshes the three that name `Orders`,
 * an `Ack` refreshes the one that names `Alerts`, and `Slowest` names
 * nothing, so only its own refresh ever reads it again.
 */

/** A time window. Absent: the last thirty days. */
export const Range = Schema.Literals(["7d", "30d", "all"]);
export type Range = Schema.Schema.Type<typeof Range>;

export const TenantArgs = Schema.Struct({ tenant: TenantId });

/** The tenant and a window. Absent `range` is its own key: `{tenant}`. */
export const RangeArgs = Schema.Struct({ tenant: TenantId, range: Schema.optionalKey(Range) });
export type RangeArgs = Schema.Schema.Type<typeof RangeArgs>;

/**
 * The tenant's name, plan, and how many alerts wait for an ack. The count
 * is why it names `Alerts`: an `Ack` changes it.
 */
export const TenantInfo = query("TenantInfo", {
  args: TenantArgs,
  result: Schema.Struct({ name: Schema.String, plan: Schema.String, alerts: Schema.Finite }),
  policy: "tenantMember",
  depends: [Alerts],
});

export const Point = Schema.Struct({ day: Schema.Finite, total: Schema.Finite });
export type Point = Schema.Schema.Type<typeof Point>;

/** Fulfilled revenue per day in the window. */
export const Revenue = query("Revenue", {
  args: RangeArgs,
  result: Schema.Struct({ points: Schema.Array(Point) }),
  policy: "tenantMember",
  depends: [Orders],
});

/**
 * Every order in the window. Named `Orders` on the wire, like the actor it
 * reads: a query and a contract are separate namespaces. The TypeScript name
 * differs so one module can import both.
 */
export const OrderList = query("Orders", {
  args: RangeArgs,
  result: Schema.Struct({ rows: Schema.Array(OrderRow) }),
  policy: "tenantMember",
  depends: [Orders],
});

export const Stage = Schema.Struct({ name: Schema.String, count: Schema.Finite });
export type Stage = Schema.Schema.Type<typeof Stage>;

/** How many orders in the window were placed, are open, fulfilled, cancelled. */
export const Funnel = query("Funnel", {
  args: RangeArgs,
  result: Schema.Struct({ stages: Schema.Array(Stage) }),
  policy: "tenantMember",
  depends: [Orders],
});

export const Latency = Schema.Struct({ endpoint: Schema.String, ms: Schema.Finite });
export type Latency = Schema.Schema.Type<typeof Latency>;

/**
 * The slowest endpoints. Deliberately slow, and deliberately dependent on
 * nothing: no actor owns latency, so no command refreshes it, and only its
 * own `refresh` reads it again.
 */
export const Slowest = query("Slowest", {
  args: TenantArgs,
  result: Schema.Struct({ rows: Schema.Array(Latency) }),
  policy: "tenantMember",
  depends: [],
});

/** The open orders, oldest first: the orders page's detail panel. */
export const OrderDetail = query("OrderDetail", {
  args: TenantArgs,
  result: Schema.Struct({ rows: Schema.Array(OrderRow) }),
  policy: "tenantMember",
  depends: [Orders],
});

// ---------------------------------------------------------------------------
// The rules the handlers and the views share
// ---------------------------------------------------------------------------

const days = { "7d": 7, "30d": 30, all: Number.POSITIVE_INFINITY } satisfies Record<Range, number>;

/** Whether `order` falls in `range`. Absent is thirty days. */
export const within =
  (range: Option.Option<Range>) =>
  (order: Order): boolean =>
    order.day < days[Option.getOrElse(range, (): Range => "30d")];

/** The label a view prints for a window. */
export const rangeLabel = (range: Option.Option<Range>): string =>
  Option.getOrElse(range, (): Range => "30d");
