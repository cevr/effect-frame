import { Route } from "effect-frame/router";
import { Schema } from "effect";
import { Alerts, TenantId } from "./contract.js";
import { Funnel, OrderDetail, OrderList, Range, Revenue, Slowest, TenantInfo } from "./queries.js";

/**
 * The addresses of the Dashboard route tree (#18, #25 §4): each segment's
 * path, its codecs, and the data it declares. No view lives here, so the
 * views can name the segments they link to and the tree can name the views.
 *
 * ```
 * dash        /d/:tenant          TenantInfo {tenant}
 * ├─ overview /d/:tenant?range=   Revenue, Orders, Funnel {tenant, range}, Slowest {tenant},
 * │                               actor Alerts {tenant}: the one live stream
 * └─ orders   /d/:tenant/orders   Orders {tenant, range: "all"}, OrderDetail {tenant}
 * ```
 *
 * The layout declares `TenantInfo` once, and both leaves inherit its
 * binding: one entry and one read for the whole branch (#18 §3.2). Both
 * leaves declare the `Orders` query with different arguments, so a move
 * between them exits one key and enters another while the layout's key
 * never moves (#28).
 */

export const DashParams = Schema.Struct({ tenant: TenantId });
export type DashParams = Schema.Schema.Type<typeof DashParams>;

export const dash = Route.segment("dash", {
  path: "/d/:tenant",
  params: DashParams,
  data: ({ params }) => ({
    tenant: Route.query(TenantInfo, { tenant: params.tenant }),
  }),
});

export const OverviewSearch = Route.search(Schema.Struct({ range: Schema.optionalKey(Range) }));
export type OverviewSearch = Schema.Schema.Type<typeof OverviewSearch>;

/**
 * The overview: five cards over four queries and one actor. The alerts are
 * the page's one live stream. The order book is not route data: the page
 * only commands it, through a `commandRef` its view holds (`commands.ts`).
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
  }),
});

/** Every order, and the open ones in detail. */
export const orders = Route.child(dash, "orders", {
  path: "orders",
  params: DashParams,
  data: ({ params }) => ({
    orders: Route.query(OrderList, { tenant: params.tenant, range: "all" }),
    detail: Route.query(OrderDetail, { tenant: params.tenant }),
  }),
});
