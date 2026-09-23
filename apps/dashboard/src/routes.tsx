import { Route } from "effect-frame/router";
import { Effect, Schema } from "effect";
import { demoTenant } from "./contract.js";
import { OrdersView } from "./orders-page.js";
import { OverviewView } from "./overview.js";
import { dash, orders, overview } from "./segments.js";
import { DashShell } from "./views.js";

/**
 * The Dashboard route tree (#18, #22, #25 §4). One streamed tree: the
 * layout and both leaves. A move between the leaves stays in the tree, so
 * the layout's segment, its `TenantInfo` key, and its memo reference never
 * move; only the leaf's keys exit and enter (#28).
 */

export const Dashboard = Route.streamed(
  "dash",
  Route.layout(
    dash,
    [Route.leaf(overview, OverviewView), Route.leaf(orders, OrdersView)],
    DashShell,
  ),
);

const home = Route.segment("home", {
  path: "/",
  params: Schema.Struct({}),
  before: () => Effect.succeed(Route.redirect(Route.target(overview, { tenant: demoTenant }, {}))),
});

/** `/`: a redirect to the demo tenant, answered before anything draws. */
export const Home = Route.ssr(
  "home",
  Route.leaf(home, () => Effect.succeed(<p id="moved">moved to the dashboard</p>)),
);

export const routes = [Home, Dashboard];
