/**
 * A server entry for the #31 bundle proof: it renders a routed tree to HTML
 * on the server host with a memory `Location`. `navigation-behavior.test.tsx`
 * bundles it and asserts the browser navigation modules are not in it.
 */
import type { LocationService } from "effect-frame/router";
import { Location, NavigationBehavior, Route, mount } from "effect-frame/router";
import { Html, View } from "effect-frame/view";
import { Effect, Schema, Stream } from "effect";

const site = Route.segment("site", { path: "/site", params: Schema.Struct({}) });
const page = Route.child(site, "page", {
  path: "pages/:id",
  params: Schema.Struct({ id: Schema.String }),
});

export const app = Route.client(
  "site",
  Route.layout(
    site,
    [
      Route.leaf(
        page,
        (props) =>
          Effect.succeed(<article>{View.bind(props.params, (params) => params.id)}</article>),
        { landing: NavigationBehavior.Preserve },
      ),
    ],
    (props) => Effect.map(props.outlet, (outlet) => <main>{outlet}</main>),
  ),
);

/** Render one URL to HTML, as a server would. */
export const renderUrl = (href: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const location: LocationService = {
        current: Effect.succeed(new URL(href)),
        push: () => Effect.void,
        replace: () => Effect.void,
        pops: Stream.never,
      };
      const root = Html.element("#root");
      yield* mount({
        landing: NavigationBehavior.Restore,
        traversalReadLimit: "3 seconds",
        routes: [app],
        notFound: () => Effect.succeed(<p>missing</p>),
        host: Html.host,
        root,
      }).pipe(Effect.provideService(Location, location));
      yield* View.flush;
      return Html.serializeChildren(root.children);
    }),
  );
