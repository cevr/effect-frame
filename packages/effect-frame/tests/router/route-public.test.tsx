import { registerDom } from "./dom-setup.js";

registerDom();

// Public imports only: this file is the application's view of the route
// surface. See `docs/design/route-public.md`.
import { implementQuery, query as queryContract } from "effect-frame/actor";
import type { ActorTransport, QueryCache, Source } from "effect-frame/actor";
import { QueryTest } from "effect-frame/actor/testing";
import * as Frame from "effect-frame/frame";
import { Link, Location, Route, link, mount as mountRouter } from "effect-frame/router";
import type { AnyRoute, LocationService, Router } from "effect-frame/router";
import { Dom, Loading, View, ViewTest, ready, render } from "effect-frame/view";
import type { LoadingScope, Node } from "effect-frame/view";
import { Context, Deferred, Effect, Layer, Option, Queue, Ref, Schema, Stream } from "effect";
import type { Scope } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "effect-bun-test";

// ---------------------------------------------------------------------------
// Contracts and a real in-process host
// ---------------------------------------------------------------------------

const TenantInfo = queryContract("PublicTenantInfo", {
  args: Schema.Struct({ tenant: Schema.String }),
  result: Schema.String,
});

const PostBody = queryContract("PublicPostBody", {
  args: Schema.Struct({ tenant: Schema.String, postId: Schema.String }),
  result: Schema.String,
});

const TenantLive = implementQuery(TenantInfo, ({ tenant }) => Effect.succeed(`Tenant ${tenant}`));
const PostLive = implementQuery(PostBody, ({ tenant, postId }) =>
  Effect.succeed(`Post ${tenant}/${postId}`),
);

// ---------------------------------------------------------------------------
// The application's navigation access service and one ordered event log
// ---------------------------------------------------------------------------

interface AccessService {
  readonly events: Ref.Ref<ReadonlyArray<string>>;
  /** Tenants whose members are signed out: the tenant check redirects. */
  readonly denied: Ref.Ref<ReadonlySet<string>>;
}

class Access extends Context.Service<Access, AccessService>()(
  "effect-frame/tests/router/route-public.test/Access",
) {}

const makeAccess = Effect.gen(function* () {
  return Access.of({
    events: yield* Ref.make<ReadonlyArray<string>>([]),
    denied: yield* Ref.make<ReadonlySet<string>>(new Set()),
  });
});

const logEvent = Effect.fn("PublicTest.logEvent")(function* (event: string) {
  const access = yield* Access;
  yield* Ref.update(access.events, (all) => [...all, event]);
});

const eventsOf = Effect.flatMap(Access, (access) => Ref.get(access.events));

const frameLayer = (name: string) =>
  QueryTest.layer({ queries: [TenantLive, PostLive] }).pipe(
    Layer.provideMerge(Layer.effect(Access, makeAccess)),
    Layer.provideMerge(TestClock.layer()),
    Layer.provideMerge(Frame.layer({ name })),
  );

// ---------------------------------------------------------------------------
// The two-level tenant/post app
// ---------------------------------------------------------------------------

// A flat route: the one-leaf shorthand.
const LoginRoute = Route.client("login", {
  path: "/login",
  params: Schema.Struct({}),
  search: Route.search(Schema.Struct({ next: Schema.String.pipe(Route.withDefault("/")) })),
  view: (props) =>
    Effect.succeed(<p id="login">{View.bind(props.search, (search) => search.next)}</p>),
});

const tenant = Route.segment("tenant", {
  path: "/app/:tenant",
  params: Schema.Struct({ tenant: Schema.String }),
  search: Route.search(Schema.Struct({ tab: Schema.String.pipe(Route.withDefault("home")) })),
  data: ({ params }) => ({ tenant: Route.query(TenantInfo, { tenant: params.tenant }) }),
  // Services stay in R; the input is the candidate's decoded values.
  before: ({ params, url }) =>
    Effect.gen(function* () {
      const access = yield* Access;
      yield* logEvent(`check:tenant:${params.tenant}`);
      if ((yield* Ref.get(access.denied)).has(params.tenant)) {
        return Route.redirect(Route.target(LoginRoute, {}, { next: url.pathname }));
      }
      return Route.Continue;
    }),
});

const post = Route.child(tenant, "post", {
  path: "posts/:postId",
  params: Schema.Struct({ tenant: Schema.String, postId: Schema.String }),
  search: Route.search(Schema.Struct({ mode: Schema.String.pipe(Route.withDefault("read")) })),
  data: ({ params }) => ({
    post: Route.query(PostBody, { tenant: params.tenant, postId: params.postId }),
  }),
  before: ({ params }) => Effect.as(logEvent(`check:post:${params.postId}`), Route.Continue),
});

class PostFailed extends Schema.TaggedError<PostFailed>()("PostFailed", {
  postId: Schema.String,
}) {}

interface Probes {
  /** Opened by the test: a `slow*` post's setup waits on it. */
  readonly slow: Deferred.Deferred<void>;
  readonly built: Queue.Queue<string>;
}

/** The post view module. `Route.PropsOf` names the segment, not the tree. */
const makePostView = (probes: Probes) => (props: Route.PropsOf<typeof post>) =>
  Effect.gen(function* () {
    const first = yield* props.params.get;
    yield* logEvent(`setup:${first.postId}`);
    if (first.postId === "bad") {
      return yield* PostFailed.make({ postId: first.postId });
    }
    if (first.postId.startsWith("slow")) {
      yield* Deferred.await(probes.slow);
    }
    const body = yield* ready(props.data.post.state, "");
    const tenantName = yield* ready(props.data.tenant.state, "");
    yield* Queue.offer(probes.built, first.postId);
    return (
      <article id="post">
        <h2 id="post-body">{View.bind(body)}</h2>
        <p id="post-tenant">{View.bind(tenantName)}</p>
        <p id="post-mode">{View.bind(props.search, (search) => search.mode)}</p>
        <button
          id="edit"
          onClick={View.event(() => props.updateSearch((search) => ({ ...search, mode: "edit" })))}
        >
          edit
        </button>
      </article>
    );
  });

/**
 * A platform import the test drives: each call waits for the next offered
 * outcome. It is a Promise, as a bundler's dynamic import is.
 */
interface Importer {
  readonly calls: Ref.Ref<number>;
  readonly started: Queue.Queue<number>;
  readonly outcomes: Queue.Queue<"ok">;
}

const makeImporter = Effect.gen(function* () {
  const importer: Importer = {
    calls: yield* Ref.make(0),
    started: yield* Queue.unbounded<number>(),
    outcomes: yield* Queue.unbounded<"ok">(),
  };
  return importer;
});

const loader =
  <P, E, R>(importer: Importer, module: View.LazyModule<P, E, R>) =>
  (): Promise<View.LazyModule<P, E, R>> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const call = yield* Ref.updateAndGet(importer.calls, (count) => count + 1);
        yield* Queue.offer(importer.started, call);
        yield* Queue.take(importer.outcomes);
        return module;
      }),
    );

const describeFailure = (failure: Route.RouteFailure<PostFailed | View.LazyImportFailed>) => {
  if (failure._tag === "Setup") {
    return `Setup:${failure.error._tag}`;
  }
  return `Declaration:${failure.error._tag}`;
};

const PendingAfter = "100 millis";
const PendingAtLeast = "300 millis";

const makeApp = (probes: Probes, importer: Importer) =>
  Route.client(
    "app",
    Route.layout(
      tenant,
      [
        Route.leaf(post, View.lazy(loader(importer, { default: makePostView(probes) })), {
          errored: (failure) => <p id="post-errored">{View.bind(failure, describeFailure)}</p>,
          pending: {
            fallback: <p id="post-pending">opening post</p>,
            after: PendingAfter,
            atLeast: PendingAtLeast,
          },
        }),
      ],
      (props) =>
        Effect.gen(function* () {
          const current = yield* props.params.get;
          // A typed link to a nested segment, drawn by `Link`.
          const first = yield* link(
            post,
            { tenant: current.tenant, postId: "1" },
            { mode: "read" },
          );
          const body = yield* Loading({
            fallback: <p id="child-loading">loading</p>,
            children: Effect.map(props.outlet, (outlet) => <div id="outlet">{outlet}</div>),
          });
          return (
            <section id="layout">
              <p id="tenant-param">{View.bind(props.params, (params) => params.tenant)}</p>
              <p id="tenant-tab">{View.bind(props.search, (search) => search.tab)}</p>
              <Link link={first}>first post</Link>
              <button
                id="tab"
                onClick={View.event(() =>
                  props.replaceSearch((search) => ({ ...search, tab: "people" })),
                )}
              >
                people
              </button>
              {body}
            </section>
          );
        }),
    ),
  );

const NotFound = (props: { readonly url: Source<URL> }) =>
  Effect.succeed(<p id="missing">{View.bind(props.url, (url) => url.pathname)}</p>);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface FakeLocation {
  readonly service: LocationService;
  readonly history: Array<string>;
}

const makeLocation = (initial: string): Effect.Effect<FakeLocation> =>
  Effect.gen(function* () {
    const current = yield* Ref.make(new URL(initial));
    const history: Array<string> = [];
    const write = (kind: string) => (url: URL) =>
      Effect.andThen(
        Ref.set(current, url),
        Effect.sync(() => {
          history.push(`${kind} ${url.pathname}${url.search}`);
        }),
      );
    return {
      service: {
        current: Ref.get(current),
        push: write("push"),
        replace: write("replace"),
        pops: Stream.never,
      },
      history,
    };
  });

const makeRoot = Effect.acquireRelease(
  Effect.sync(() => {
    const created = document.createElement("main");
    document.body.appendChild(created);
    return created;
  }),
  (created) => Effect.sync(() => created.remove()),
);

const origin = "http://frame.test";

const mountApp = <R,>(app: AnyRoute<R>, root: HTMLElement, path: string) =>
  Effect.gen(function* () {
    const location = yield* makeLocation(`${origin}${path}`);
    const page = yield* ViewTest.make({
      host: Dom.host,
      root,
      setup: (host, mountRoot) =>
        mountRouter({ routes: [app, LoginRoute], notFound: NotFound, host, root: mountRoot }).pipe(
          Effect.provideService(Location, location.service),
        ),
    });
    return { page, router: page.setup, location };
  });

const textAt = (root: globalThis.Node, selector: string): string => {
  if (!(root instanceof HTMLElement)) {
    return "";
  }
  return Option.getOrElse(
    Option.fromNullishOr(root.querySelector(selector)?.textContent),
    () => "",
  );
};

const hasAt = (root: globalThis.Node, selector: string): boolean =>
  root instanceof HTMLElement && Option.isSome(Option.fromNullishOr(root.querySelector(selector)));

const attributeAt = (root: HTMLElement, selector: string, name: string): string =>
  Option.getOrElse(
    Option.fromNullishOr(root.querySelector(selector)?.getAttribute(name)),
    () => "",
  );

const click = (root: HTMLElement, selector: string) =>
  Effect.sync(() => {
    const target = root.querySelector(selector);
    if (target instanceof HTMLElement) {
      target.click();
    }
  });

// ---------------------------------------------------------------------------
// Type fixtures. Unannotated expressions only.
// ---------------------------------------------------------------------------

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type RouteServices<T> = T extends AnyRoute<infer R> ? R : never;

const fixtureProbes: Probes = {
  slow: Deferred.makeUnsafe<void>(),
  built: Effect.runSync(Queue.unbounded<string>()),
};
const fixtureImporter: Importer = {
  calls: Ref.makeUnsafe(0),
  started: Effect.runSync(Queue.unbounded<number>()),
  outcomes: Effect.runSync(Queue.unbounded<"ok">()),
};
const PostView = makePostView(fixtureProbes);
const LazyPost = View.lazy(loader(fixtureImporter, { default: PostView }));

// 1. Exact E and R.
/**
 * The layout yields its outlet inside `Loading`, so `LoadingScope` is
 * provided. `link` reads `Router`, which the mount provides.
 */
const appServicesExact: Equals<
  RouteServices<ReturnType<typeof makeApp>>,
  QueryCache | ActorTransport | Access | Router
> = true;
const lazyError: Equals<
  Effect.Error<ReturnType<typeof LazyPost>>,
  PostFailed | View.LazyImportFailed
> = true;
const lazyServices: Equals<
  Effect.Services<ReturnType<typeof LazyPost>>,
  Effect.Services<ReturnType<typeof PostView>>
> = true;
const lazyProps: Equals<Parameters<typeof LazyPost>[0], Route.PropsOf<typeof post>> = true;
/** The flat shorthand keeps its exact route type. */
const flatExact: Equals<
  typeof LoginRoute,
  Route.Route<
    "login",
    Schema.Struct<{}>,
    Schema.Codec<{ readonly next: string }, Route.SearchRecord>,
    never
  >
> = true;

// 2. Invalid targets.
const segmentTarget = Route.target(post, { tenant: "t1", postId: "7" }, { mode: "edit" });
const flatTarget = Route.target(LoginRoute, {}, { next: "/" });
// @ts-expect-error A target needs every param of the destination.
const missingParam = () => Route.target(post, { tenant: "t1" }, { mode: "read" });
// @ts-expect-error A param has the destination's decoded type.
const wrongParam = () => Route.target(post, { tenant: "t1", postId: 7 }, { mode: "read" });
// @ts-expect-error A search field the destination does not decode.
const wrongSearch = () => Route.target(LoginRoute, {}, { back: "/" });

// 3. Lazy module props.
const OtherView = (props: { readonly other: string }) => Effect.succeed(<p>{props.other}</p>);
const wrongModule = () =>
  // @ts-expect-error A lazy module's view must take the segment's props.
  Route.leaf(post, View.lazy(loader(fixtureImporter, { default: OtherView })), {
    errored: () => <p>failed</p>,
  });

// 4. Missing services.
class Clipboard extends Context.Service<Clipboard, { readonly copy: Effect.Effect<void> }>()(
  "effect-frame/tests/router/route-public.test/Clipboard",
) {}
const NeedsClipboard = (_props: Route.PropsOf<typeof post>) =>
  Effect.map(Clipboard, (): Node => <p>copy</p>);
const clipboardApp = Route.client(
  "clip",
  Route.layout(tenant, [Route.leaf(post, NeedsClipboard)], (props) =>
    Effect.map(props.outlet, (outlet) => <div>{outlet}</div>),
  ),
);
/** The view's service reaches the tree's services, beside the data and the check. */
const clipboardServices: Equals<
  RouteServices<typeof clipboardApp>,
  QueryCache | ActorTransport | Access | Clipboard
> = true;
/** What an application that has no `Clipboard` can run. */
const withoutClipboard = (
  mounted: Effect.Effect<
    unknown,
    never,
    QueryCache | ActorTransport | Access | Location | Scope.Scope
  >,
) => mounted;
const mountsFullApp = (root: HTMLElement) =>
  withoutClipboard(
    mountRouter({
      routes: [makeApp(fixtureProbes, fixtureImporter)],
      notFound: NotFound,
      host: Dom.host,
      root,
    }),
  );
// @effect-diagnostics missingEffectContext:off
const missingService = (root: HTMLElement) =>
  withoutClipboard(
    // @ts-expect-error Mounting the tree needs `Clipboard`, which the caller does not have.
    mountRouter({ routes: [clipboardApp], notFound: NotFound, host: Dom.host, root }),
  );
// @effect-diagnostics missingEffectContext:error
/** A layout that yields its outlet outside `Loading` keeps `LoadingScope`. */
const ReadingChild = (props: Route.PropsOf<typeof post>) =>
  Effect.map(ready(props.data.post.state, ""), (body): Node => <p>{View.bind(body)}</p>);
const leakyApp = Route.client(
  "leaky",
  Route.layout(tenant, [Route.leaf(post, ReadingChild)], (props) =>
    Effect.map(props.outlet, (outlet) => <div>{outlet}</div>),
  ),
);
const leakyServices: Equals<
  RouteServices<typeof leakyApp>,
  QueryCache | ActorTransport | Access | LoadingScope
> = true;

// 5. Missing typed fallback.
// @effect-diagnostics missingEffectError:off
// @ts-expect-error A view that can fail needs an errored handler.
const unhandledSetup = Route.leaf(post, PostView);
// @ts-expect-error A lazy view adds LazyImportFailed to E, so it needs an errored handler.
const unhandledImport = Route.leaf(post, LazyPost, { pending: somePending() });
// @ts-expect-error The handler must take LazyImportFailed as well as the view's own E.
const narrowHandler = Route.leaf(post, LazyPost, {
  errored: (failure: Source<Route.RouteFailure<PostFailed>>) => <p>{View.bind(failure, String)}</p>,
});
// @effect-diagnostics missingEffectError:error

function somePending(): Route.Pending {
  return { fallback: <p>opening</p>, after: 0, atLeast: 0 };
}

// 6. Links: a flat route and a segment are both destinations.
const flatLink = link(LoginRoute, {}, { next: "/" });
const segmentLink = link(post, { tenant: "t1", postId: "1" }, (search) => search);
// @ts-expect-error A link's params have the destination's decoded type.
const wrongLink = () => link(post, { tenant: "t1", postId: 1 }, { mode: "read" });

const typeFixtures = [
  appServicesExact,
  lazyError,
  lazyServices,
  lazyProps,
  flatExact,
  clipboardServices,
  leakyServices,
];
const compiled = [
  segmentTarget,
  flatTarget,
  missingParam,
  wrongParam,
  wrongSearch,
  wrongModule,
  mountsFullApp,
  missingService,
  unhandledSetup,
  unhandledImport,
  narrowHandler,
  flatLink,
  segmentLink,
  wrongLink,
];

// ---------------------------------------------------------------------------
// Proofs
// ---------------------------------------------------------------------------

describe("public nested routes", () => {
  it.effect("0. keeps exact E and R, typed targets, lazy props, services, and fallbacks", () =>
    Effect.sync(() => {
      expect(typeFixtures).toEqual([true, true, true, true, true, true, true]);
      expect(compiled).toHaveLength(14);
      expect(segmentTarget.href).toBe("/app/t1/posts/7?mode=edit");
      expect(flatTarget.href).toBe("/login");
    }),
  );

  it.scoped.layer(frameLayer("public-example"))(
    "1. a tenant/post app: before redirect, pending, a lazy leaf, and errored",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const probes: Probes = {
          slow: yield* Deferred.make<void>(),
          built: yield* Queue.unbounded<string>(),
        };
        const importer = yield* makeImporter;
        const { page, router, location } = yield* mountApp(
          makeApp(probes, importer),
          root,
          "/app/t1",
        );
        yield* page.waitFor({
          label: "the tenant layout alone",
          until: (actual) => textAt(actual, "#tenant-param") === "t1",
        });
        // A segment link prints through the segment's own codecs.
        expect(attributeAt(root, "#layout a", "href")).toBe("/app/t1/posts/1");
        expect(attributeAt(root, "#layout a", "aria-current")).toBe("");
        expect(yield* Ref.get(importer.calls)).toBe(0);

        // Checks run parent first, then the lazy import starts. The
        // navigation commits without waiting for it.
        yield* click(root, "#layout a");
        expect(yield* Queue.take(importer.started)).toBe(1);
        expect(yield* eventsOf).toEqual(["check:tenant:t1", "check:tenant:t1", "check:post:1"]);

        // Pending shows only at `after`, and stays `atLeast` once shown.
        yield* page.waitFor({
          label: "the post's region under the layout's Loading",
          until: (actual) => hasAt(actual, "#outlet") && !hasAt(actual, "#child-loading"),
        });
        yield* TestClock.adjust("99 millis");
        yield* render;
        expect(hasAt(root, "#post-pending")).toBe(false);
        yield* TestClock.adjust("1 millis");
        yield* page.waitFor({
          label: "the pending fallback",
          until: (actual) => hasAt(actual, "#post-pending"),
        });
        yield* Queue.offer(importer.outcomes, "ok");
        expect(yield* Queue.take(probes.built)).toBe("1");
        yield* TestClock.adjust("299 millis");
        yield* render;
        expect(hasAt(root, "#post")).toBe(false);
        yield* TestClock.adjust("1 millis");
        yield* page.waitFor({
          label: "post 1",
          until: (actual) =>
            textAt(actual, "#post-body") === "Post t1/1" &&
            textAt(actual, "#post-tenant") === "Tenant t1",
        });
        expect(attributeAt(root, "#layout a", "aria-current")).toBe("page");

        // The leaf updates its own search; the layout updates its own and
        // keeps the child's path.
        yield* click(root, "#edit");
        yield* page.waitFor({
          label: "the post in edit mode",
          until: (actual) => textAt(actual, "#post-mode") === "edit",
        });
        yield* click(root, "#tab");
        yield* page.waitFor({
          label: "the people tab",
          until: (actual) => textAt(actual, "#tenant-tab") === "people",
        });
        expect(textAt(root, "#post-mode")).toBe("edit");
        expect(location.history.slice(-2)).toEqual([
          "push /app/t1/posts/1?mode=edit",
          "replace /app/t1/posts/1?mode=edit&tab=people",
        ]);

        // A typed setup failure shows errored with its typed error.
        yield* router.navigate("/app/t1");
        yield* router.navigate("/app/t1/posts/bad");
        yield* page.waitFor({
          label: "the typed setup failure",
          until: (actual) => textAt(actual, "#post-errored") === "Setup:PostFailed",
        });

        // A layout redirect: history moves once, to the typed target, and
        // no child check, import, or setup of the refused branch starts.
        yield* Effect.flatMap(Access, (access) => Ref.set(access.denied, new Set(["t2"])));
        const before = (yield* eventsOf).length;
        yield* router.navigate("/app/t2/posts/9");
        yield* page.waitFor({
          label: "the sign-in page",
          until: (actual) => textAt(actual, "#login") === "/app/t2/posts/9",
        });
        expect((yield* eventsOf).slice(before)).toEqual(["check:tenant:t2"]);
        expect(location.history.at(-1)).toBe("push /login?next=%2Fapp%2Ft2%2Fposts%2F9");
        expect(yield* Ref.get(importer.calls)).toBe(1);

        yield* page.close;
        const snapshot = yield* Frame.inspect;
        expect(snapshot.queries).toEqual([]);
        expect(snapshot.routes).toEqual([]);
      }),
  );
});
