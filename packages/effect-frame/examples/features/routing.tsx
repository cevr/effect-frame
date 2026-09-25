// #region imports
import { Link, NavigationBehavior, Route, link } from "effect-frame/router";
import { View } from "effect-frame/view";
import { Effect, Schema } from "effect";
import { TenantInfo, isSignedIn } from "./tenant.js";
// #endregion imports

// #region segments
// A search codec decodes the query string; `withDefault` fills a missing key.
export const login = Route.segment("login", {
  path: "/login",
  search: Route.search(Schema.Struct({ next: Schema.String.pipe(Route.withDefault("/")) })),
});

// A one-page route is a tree of one leaf. There is no other form.
export const Login = Route.client(
  "login",
  Route.leaf(login, (props) =>
    Effect.succeed(<p>sign in, then go to {View.bind(props.search, (search) => search.next)}</p>),
  ),
);

// `before` runs parent first, before anything commits: continue, or redirect.
export const tenant = Route.segment("tenant", {
  path: "/app/:tenant",
  params: Schema.Struct({ tenant: Schema.String }),
  data: ({ params }) => ({ info: Route.query(TenantInfo, { tenant: params.tenant }) }),
  before: ({ params, url }) =>
    Effect.gen(function* () {
      if (yield* isSignedIn(params.tenant)) {
        return Route.Continue;
      }
      return Route.redirect(login, {}, { next: `${url.pathname}${url.search}` });
    }),
});

// A child declares only its own params: `post` sees `{ tenant, postId }`.
export const post = Route.child(tenant, "post", {
  path: "posts/:postId",
  params: Schema.Struct({ postId: Schema.String }),
});

export const tab = Route.child(tenant, "tab", {
  path: "tabs/:tab",
  params: Schema.Struct({ tab: Schema.String }),
});
// #endregion segments

// #region layout-view
// A layout view stays generic in `ChildR`, what its children's views need.
// `link` takes fixed params or a Source of them.
export const TenantView = <ChildR,>(props: Route.LayoutPropsOf<typeof tenant, ChildR>) =>
  Effect.gen(function* () {
    const first = yield* link(post, { tenant: "t1", postId: "1" }, {});
    const body = yield* View.loading({ fallback: <p>loading</p>, content: props.outlet });
    return (
      <section>
        <Link link={first}>first post</Link>
        {body}
      </section>
    );
  });
// #endregion layout-view

// Bound to a name, so the lazy import is one place.
const loadPostView = () => import("./post-view.js");

const TabView = (props: Route.PropsOf<typeof tab>) =>
  Effect.succeed(<p>{View.bind(props.params, (params) => params.tab)}</p>);

// #region leaves
export const App = Route.client(
  "app",
  Route.layout(
    tenant,
    [
      // A lazy view is imported beside the page's data. A view that can
      // fail, and every lazy view, names its `errored` handler.
      Route.leaf(post, View.lazy(loadPostView), {
        errored: (failure) => <p>{View.bind(failure, (f) => f._tag)}</p>,
        pending: { fallback: <p>opening</p>, after: "100 millis", atLeast: "300 millis" },
      }),
      // A tab strip that keeps the reader where they are.
      Route.leaf(tab, TabView, { landing: NavigationBehavior.Preserve }),
    ],
    TenantView,
  ),
);
// #endregion leaves
