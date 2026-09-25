import { NavigationBehavior, Route } from "effect-frame/router";
import { Effect, Schema } from "effect";
import { isSignedIn } from "../features/tenant.js";
import { login } from "../features/routing.js";

/**
 * The `@example` blocks of the router modules' JSDoc, as compiled regions.
 * `bun run docs` holds each block to its region here.
 */

const HomeView = () => Effect.succeed(<p>home</p>);
const TabsView = () => Effect.succeed(<p>tabs</p>);
const lists = Route.segment("lists", { path: "/lists" });
const tabs = Route.segment("tabs", { path: "/tabs" });

// #region leaf-landing
export const Tabs = Route.client(
  "tabs",
  Route.leaf(tabs, TabsView, { landing: NavigationBehavior.Preserve }),
);
// #endregion leaf-landing

// #region mode
const Home = Route.segment("home", { path: "/" });
export const HomeRoute = Route.ssr("home", Route.leaf(Home, HomeView));
// #endregion mode

// #region redirecting
const start = Route.segment("start", { path: "/start" });
export const Start = Route.redirecting("start", start, () =>
  Effect.succeed(Route.redirect(lists, {}, {})),
);
// #endregion redirecting

// #region redirect
export const tenant = Route.segment("tenant", {
  path: "/app/:tenant",
  params: Schema.Struct({ tenant: Schema.String }),
  before: ({ params, url }) =>
    Effect.map(isSignedIn(params.tenant), (signedIn) => {
      if (signedIn) {
        return Route.Continue;
      }
      return Route.redirect(login, {}, { next: url.pathname });
    }),
});
// #endregion redirect
