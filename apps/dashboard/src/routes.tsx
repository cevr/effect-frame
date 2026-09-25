import { Route } from "effect-frame/router";
import { Effect, Schema } from "effect";
import { demoTenant } from "./contract.js";
import { OrderView, OrdersIndex, OrdersLayout } from "./orders-page.js";
import { OverviewView } from "./overview.js";
import { dash, order, orders, ordersIndex, overview } from "./segments.js";
import { DashShell } from "./views.js";

/**
 * The Dashboard route tree (#18, #22, #25 §4). One streamed tree, three
 * deep: the dash layout, the overview leaf, and the orders layout with its
 * index and order leaves. A move between the leaves stays in the tree, so
 * the layout's segment, its `TenantInfo` key, and its memo reference never
 * move; only the leaf's keys exit and enter (#28).
 */

export const Dashboard = Route.streamed(
  "dash",
  Route.layout(
    dash,
    [
      Route.leaf(overview, OverviewView),
      Route.layout(
        orders,
        [Route.leaf(ordersIndex, OrdersIndex), Route.leaf(order, OrderView)],
        OrdersLayout,
      ),
    ],
    DashShell,
  ),
);

const home = Route.segment("home", { path: "/", params: Schema.Struct({}) });

/** `/`: a redirect to the demo tenant, answered before anything draws. */
export const Home = Route.redirecting("home", home, () =>
  Effect.succeed(Route.redirect(overview, { tenant: demoTenant }, {})),
);

export const routes = [Home, Dashboard];
