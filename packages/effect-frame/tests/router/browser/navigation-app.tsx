/* oxlint-disable effect/noNullish, effect/noNewPromise, effect/noNewError -- this module is the fixture's browser boundary: it reads page config and exposes test controls on window. */
/**
 * The real-browser fixture for #31 navigation behavior. One `site` layout
 * with a search field, and leaves that each prove one row: a tall page with
 * a fragment target, a leaf with its own `autofocus` heading, a `Preserve`
 * tab strip, a never-settling query, a late below-the-fold region, and a
 * form whose validation fails. It mounts the real router on the public
 * `browserNavigation` Location, with the public `followLinks`.
 */
import type { Source } from "effect-frame/actor";
import { QueryState } from "effect-frame/actor/client";
import { Policies, Policy, implementQuery, query as declareQuery } from "effect-frame/actor";
import { QueryTest } from "effect-frame/actor/testing";
import {
  Location,
  NavigationBehavior,
  Route,
  browserNavigation,
  followLinks,
  mount,
} from "effect-frame/router";
import { Dom, View } from "effect-frame/view";
import { ViewTest } from "effect-frame/view/testing";
import { Deferred, Duration, Effect, Exit, Layer, Option, Schema, SubscriptionRef } from "effect";
import * as Receipt from "../../../src/router/receipt.js";

export interface NavConfig {
  /** `none` removes the Navigation API before the router mounts. */
  readonly api: "native" | "none";
  /** The router's `traversalReadLimit`, in milliseconds. Absent: its default. */
  readonly traversalReadLimitMillis?: number;
}

export interface NavWindow {
  readonly config: NavConfig;
  /** How many times each leaf's view ran. */
  readonly setups: Record<string, number>;
  /** Every `navigate` event the page saw, as `type:hashChange`. */
  readonly events: Array<string>;
  /** Settle the late region's query. */
  settle: () => Promise<void>;
  /** Hold every read of the declared `Rows` query until `releaseRows`. */
  holdRows: () => void;
  releaseRows: () => void;
  /** Let a gated page's view finish building. */
  open: (name: string) => Promise<void>;
  navigate: (href: string) => Promise<string>;
  ready: boolean;
}

declare global {
  interface Window {
    __nav: NavWindow;
    __navConfig: NavConfig;
  }
}

const tall = (height: number) => <div style={`height: ${String(height)}px`} />;

const site = Route.segment("site", { path: "/site", params: Schema.Struct({}) });

const page = Route.child(site, "page", {
  path: "pages/:id",
  params: Schema.Struct({ id: Schema.String }),
  search: Route.search(Schema.Struct({ q: Schema.String.pipe(Route.withDefault("")) })),
});
const titled = Route.child(site, "titled", { path: "titled", params: Schema.Struct({}) });
const tabs = Route.child(site, "tabs", {
  path: "tabs/:tab",
  params: Schema.Struct({ tab: Schema.String }),
});
const slow = Route.child(site, "slow", { path: "slow", params: Schema.Struct({}) });
const late = Route.child(site, "late", { path: "late", params: Schema.Struct({}) });
const formPage = Route.child(site, "form", { path: "form", params: Schema.Struct({}) });
const gated = Route.child(site, "gated", {
  path: "gated/:name",
  params: Schema.Struct({ name: Schema.String }),
});
/** A second gated leaf, so a move between the two enters a new leaf. */
const held = Route.child(site, "held", {
  path: "held/:name",
  params: Schema.Struct({ name: Schema.String }),
});
/**
 * The declared query of the `rows` leaf: the page is as tall as its answer
 * says. It is released when the leaf exits, so a Back reads it again.
 */
const Rows = declareQuery("Rows", {
  version: 1,
  args: Schema.Struct({ id: Schema.String }),
  result: Schema.Struct({ height: Schema.Finite }),
  policy: "public",
  depends: [],
});
const rows = Route.child(site, "rows", {
  path: "rows/:id",
  params: Schema.Struct({ id: Schema.String }),
  data: ({ params }) => ({ rows: Route.query(Rows, { id: params.id }) }),
});
/** Always redirects: the first load of `/site/old` replaces its entry. */
const old = Route.child(site, "old", {
  path: "old",
  params: Schema.Struct({}),
  before: () => Effect.succeed(Route.redirect(page, { id: "1" }, { q: "" })),
});

const start = (): void => {
  const control: NavWindow = {
    config: window.__navConfig,
    setups: {},
    events: [],
    settle: () => Promise.reject(new Error("the late page is not shown")),
    holdRows: () => undefined,
    releaseRows: () => undefined,
    open: () => Promise.reject(new Error("router is not mounted")),
    navigate: () => Promise.reject(new Error("router is not mounted")),
    ready: false,
  };
  window.__nav = control;
  if (control.config.api === "none") {
    // The fallback path: this page has no Navigation API.
    Reflect.deleteProperty(window, "navigation");
  } else {
    window.navigation.addEventListener("navigate", (event) => {
      control.events.push(`${event.navigationType}:${String(event.hashChange)}`);
    });
  }

  const ran = (name: string) =>
    Effect.sync(() => {
      control.setups[name] = (control.setups[name] ?? 0) + 1;
    });

  const PageView = (props: Route.PropsOf<typeof page>) =>
    Effect.as(
      ran("page"),
      <article id="page">
        <h2 id="page-id">{View.bind(props.params, (params) => params.id)}</h2>
        <p id="page-q">{View.bind(props.search, (search) => search.q)}</p>
        {tall(3000)}
        <h3 id="usage">usage</h3>
        {tall(3000)}
        <h3 id="part%20one">raw id</h3>
        {tall(3000)}
        <h3 id="part two">decoded id</h3>
        {tall(3000)}
        <a name="legacy">named anchor</a>
        {tall(3000)}
      </article>,
    );

  const TitledView = () =>
    Effect.as(
      ran("titled"),
      <article id="titled">
        <h1 id="titled-heading" tabindex="-1" autofocus>
          titled
        </h1>
        {tall(3000)}
      </article>,
    );

  const TabsView = (props: Route.PropsOf<typeof tabs>) =>
    Effect.as(
      ran("tabs"),
      <article id="tabs">
        <p id="tab">{View.bind(props.params, (params) => params.tab)}</p>
        {tall(6000)}
      </article>,
    );

  const SlowView = () =>
    Effect.gen(function* () {
      yield* ran("slow");
      // Never resolved: the response is still open while the shell shows.
      const query = yield* ViewTest.fakeQuery(QueryState.Loading<string, never>());
      const body = yield* View.loading({
        fallback: <p id="slow-fallback">loading</p>,
        content: Effect.map(View.ready(query.source, ""), (value) => (
          <p id="slow-value">{View.bind(value)}</p>
        )),
      });
      return (
        <article id="slow">
          {body}
          {tall(6000)}
        </article>
      );
    });

  const LateView = () =>
    Effect.gen(function* () {
      yield* ran("late");
      const query = yield* ViewTest.fakeQuery(QueryState.Loading<string, never>());
      const context = yield* Effect.context<never>();
      control.settle = () => Effect.runPromiseWith(context)(query.resolve("settled"));
      const region = yield* View.loading({
        fallback: <p id="late-fallback">loading</p>,
        content: Effect.map(View.ready(query.source, ""), (value) => (
          <section id="late-content">
            <p>{View.bind(value)}</p>
            {tall(2000)}
          </section>
        )),
      });
      return (
        <article id="late">
          {tall(4000)}
          {region}
          {tall(4000)}
        </article>
      );
    });

  // Reads of `Rows` wait on the current gate; `holdRows` swaps in a closed one.
  let rowsGate = Deferred.makeUnsafe<void>();
  Deferred.doneUnsafe(rowsGate, Exit.void);
  control.holdRows = () => {
    rowsGate = Deferred.makeUnsafe<void>();
  };
  control.releaseRows = () => {
    Deferred.doneUnsafe(rowsGate, Exit.void);
  };
  const rowsLayer = QueryTest.layer({
    queries: [
      implementQuery(Rows, {
        run: () =>
          Effect.andThen(
            Effect.suspend(() => Deferred.await(rowsGate)),
            Effect.succeed({ height: 6000 }),
          ),
      }),
    ],
  }).pipe(
    Layer.provide(Layer.succeed(Policies, Policies.of({ public: Policy.allowAll }))),
    Layer.orDie,
  );

  const RowsView = (props: Route.PropsOf<typeof rows>) =>
    Effect.gen(function* () {
      yield* ran("rows");
      const body = yield* View.loading({
        fallback: <p id="rows-fallback">loading</p>,
        content: Effect.map(View.ready(props.data.rows.state, { height: 0 }), (value) => (
          <div
            id="rows-content"
            style={View.bind(value, (one) => `height: ${String(one.height)}px`)}
          />
        )),
      });
      return <article id="rows">{body}</article>;
    });

  const FormView = () =>
    Effect.gen(function* () {
      yield* ran("form");
      const error = yield* SubscriptionRef.make("");
      const errorSource: Source<string> = {
        get: SubscriptionRef.get(error),
        changes: SubscriptionRef.changes(error),
      };
      return (
        <article id="form-page">
          <form
            id="form"
            onSubmit={View.submit(() => SubscriptionRef.set(error, "title is required"))}
          >
            <input id="field" name="title" />
            <p id="error">{View.bind(errorSource)}</p>
            <button id="send" type="submit">
              send
            </button>
          </form>
        </article>
      );
    });

  /** One gate per name: the view does not finish building until it opens. */
  const gates = new Map<string, Deferred.Deferred<void>>();
  const gateOf = (name: string) => {
    const found = gates.get(name);
    if (found !== undefined) {
      return found;
    }
    const made = Deferred.makeUnsafe<void>();
    gates.set(name, made);
    return made;
  };
  control.open = (name) => Effect.runPromise(Effect.asVoid(Deferred.succeed(gateOf(name), void 0)));

  const GatedView = (props: { readonly params: Source<{ readonly name: string }> }) =>
    Effect.gen(function* () {
      const { name } = yield* props.params.get;
      yield* ran(`gated:${name}`);
      yield* Deferred.await(gateOf(name));
      return (
        <article id={`gated-${name}`}>
          <p>{name}</p>
          {tall(6000)}
        </article>
      );
    });

  const app = Route.client(
    "site",
    Route.layout(
      site,
      [
        Route.leaf(page, PageView),
        Route.leaf(titled, TitledView),
        Route.leaf(tabs, TabsView, { landing: NavigationBehavior.Preserve }),
        Route.leaf(slow, SlowView),
        Route.leaf(late, LateView),
        Route.leaf(formPage, FormView),
        Route.leaf(rows, RowsView),
        Route.leaf(gated, GatedView),
        Route.leaf(held, GatedView),
        Route.leaf(old, () => Effect.succeed(<p id="old">never shown</p>)),
      ],
      (props) =>
        Effect.map(props.outlet, (outlet) => (
          <section id="layout">
            <input id="search" />
            <nav>
              <a id="to-usage" href="#usage">
                usage
              </a>
              <a id="to-page-2" href="/site/pages/2">
                page 2
              </a>
            </nav>
            {outlet}
          </section>
        )),
    ),
  );

  const NotFound = (props: { readonly url: Source<URL> }) =>
    Effect.succeed(<p id="missing">{View.bind(props.url, (url) => url.pathname)}</p>);

  const main = Effect.gen(function* () {
    const location = yield* browserNavigation;
    const found = Option.fromNullishOr(document.getElementById("root"));
    if (Option.isNone(found)) {
      return yield* Effect.die("fixture: no #root element");
    }
    const router = yield* mount({
      routes: [app],
      notFound: NotFound,
      host: Dom.host,
      root: found.value,
      ...Option.match(Option.fromNullishOr(window.__navConfig.traversalReadLimitMillis), {
        onNone: () => ({}),
        onSome: (millis) => ({ traversalReadLimit: Duration.millis(millis) }),
      }),
    }).pipe(Effect.provideService(Location, location));
    yield* followLinks(document, router);
    const receipts = Receipt.of(router);
    const context = yield* Effect.context<never>();
    control.navigate = (href) =>
      Effect.runPromiseWith(context)(
        Effect.map(
          receipts.navigate(href),
          (result) => `${result._tag} ${result.url.pathname}${result.url.search}${result.url.hash}`,
        ),
      );
    control.ready = true;
    return yield* Effect.never;
  });

  // The query host lives as long as the page: the router reads through it.
  // @effect-diagnostics-next-line strictEffectProvide:off
  Effect.runFork(Effect.scoped(Effect.provide(main, rowsLayer)));
};

start();
