import { Route } from "effect-frame/router";
import { Schema } from "effect";
import { Alerts, Memo, Orders, TenantId } from "./contract.js";
import { Funnel, OrderDetail, OrderList, Range, Revenue, Slowest, TenantInfo } from "./queries.js";

/**
 * The addresses of the Dashboard route tree (#18, #25 §4): each segment's
 * path, its codecs, and the data it declares. No view lives here, so the
 * views can name the segments they link to and the tree can name the views.
 *
 * ```
 * dash            /d/:tenant                TenantInfo {tenant}
 * ├─ overview     /d/:tenant?range=         Revenue, Orders, Funnel {tenant, range},
 * │                                         Slowest {tenant}, actor Alerts {tenant}:
 * │                                         the one live stream
 * └─ orders       /d/:tenant/orders/…       Orders {tenant, range: "all"}
 *    ├─ index     /d/:tenant/orders         OrderDetail {tenant}
 *    └─ order     /d/:tenant/orders/:order  TenantInfo {tenant}: the layout's key again
 * ```
 *
 * The layout declares `TenantInfo` once, and every leaf inherits its
 * binding: one entry and one read for the whole three-deep branch (#18
 * §3.2). The overview and the orders layout declare the `Orders` query with
 * different arguments, so a move between them exits one key and enters
 * another while the layout's key never moves (#28). The order leaf declares
 * the layout's key a second time: the shared declaration.
 */

export const DashParams = Schema.Struct({ tenant: TenantId });
export type DashParams = Schema.Schema.Type<typeof DashParams>;

export const dash = Route.segment("dash", {
  path: "/d/:tenant",
  params: DashParams,
  data: ({ params }) => ({
    tenant: Route.query(TenantInfo, { tenant: params.tenant }),
    // The memo is only written: a send-only reference, no live stream.
    memo: Route.commandRef(Memo, { tenant: params.tenant }),
  }),
});

export const OverviewSearch = Route.search(Schema.Struct({ range: Schema.optionalKey(Range) }));
export type OverviewSearch = Schema.Schema.Type<typeof OverviewSearch>;

/**
 * The overview: five cards over four queries and one actor. The alerts are
 * the page's one live stream. The order book is only commanded: a
 * `Route.commandRef`, which the transition moves with the tenant and which
 * reads no snapshot.
 */
export const overview = Route.child(dash, "overview", {
  path: "",
  params: DashParams,
  search: OverviewSearch,
  data: ({ params, search }) => ({
    revenue: Route.query(Revenue, { tenant: params.tenant, ...search }),
    orders: Route.query(OrderList, { tenant: params.tenant, ...search }),
    funnel: Route.query(Funnel, { tenant: params.tenant, ...search }),
    slowest: Route.query(Slowest, { tenant: params.tenant }),
    alerts: Route.actor(Alerts, { tenant: params.tenant }),
    book: Route.commandRef(Orders, { tenant: params.tenant }),
  }),
});

/**
 * The orders layout: every order, which both its leaves show. It is the
 * middle of a three-deep branch: dash, orders, and a leaf.
 */
export const orders = Route.child(dash, "orders", {
  path: "orders",
  params: DashParams,
  data: ({ params }) => ({
    orders: Route.query(OrderList, { tenant: params.tenant, range: "all" }),
    book: Route.commandRef(Orders, { tenant: params.tenant }),
  }),
});

/** `/d/:tenant/orders`: the open orders in detail. */
export const ordersIndex = Route.child(orders, "orders-index", {
  path: "",
  params: DashParams,
  data: ({ params }) => ({
    detail: Route.query(OrderDetail, { tenant: params.tenant }),
  }),
});

export const OrderParams = Schema.Struct({ tenant: TenantId, order: Schema.String });
export type OrderParams = Schema.Schema.Type<typeof OrderParams>;

/**
 * `/d/:tenant/orders/:order`: one order. It declares `TenantInfo` for its
 * tenant, the key the layout declares: two segments, one entry. When this
 * leaf exits, the layout still holds the key; when the layout's tenant
 * moves, the key goes (#28). A child may not reuse a parent's name, so the
 * binding here is `info`.
 */
export const order = Route.child(orders, "order", {
  path: ":order",
  params: OrderParams,
  data: ({ params }) => ({
    info: Route.query(TenantInfo, { tenant: params.tenant }),
  }),
});
