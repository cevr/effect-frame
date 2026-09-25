import { registerDom } from "./dom-setup.js";

registerDom();

import {
  Actor,
  Behavior,
  Value,
  implementQuery,
  query as queryContract,
  Policies,
  Policy,
  ActorHost,
  QueryCache,
} from "effect-frame/actor";
import type { ActorTransport, Source } from "effect-frame/actor";
import {
  Location,
  Route,
  mount as mountRouter,
  NavigationBehavior,
  memoryLocation,
} from "effect-frame/router";
import type { NavigationResult } from "effect-frame/router";
import { Dom, Html, View } from "effect-frame/view";
import { ViewTest } from "effect-frame/view/testing";
import type { LazyModule, Node } from "effect-frame/view";
import * as Frame from "../../src/frame.js";
import {
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Scope,
} from "effect";
import type { Scope as ScopeType } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "effect-bun-test";

/** The one policy table: every contract and query here declares `public`. */
const policies = Layer.succeed(Policies, Policies.of({ public: Policy.allowAll }));

// ---------------------------------------------------------------------------
// Contracts and a real in-process host
// ---------------------------------------------------------------------------

const TenantInfo = queryContract("PendingTenantInfo", {
  version: 1,
  policy: "public",
  args: Schema.Struct({ tenant: Schema.String }),
  result: Schema.String,
  depends: [],
});

const PostBody = queryContract("PendingPostBody", {
  version: 1,
  policy: "public",
  args: Schema.Struct({ tenant: Schema.String, postId: Schema.String }),
  result: Schema.String,
  depends: [],
});

interface Held {
  readonly gate: Deferred.Deferred<void>;
  readonly started: Deferred.Deferred<void>;
}

interface FixturesService {
  readonly held: Ref.Ref<ReadonlyMap<string, Held>>;
  readonly calls: Ref.Ref<ReadonlyMap<string, number>>;
}

class Fixtures extends Context.Service<Fixtures, FixturesService>()(
  "effect-frame/tests/router/route-pending.test/Fixtures",
) {}

const serve = Effect.fn("PendingTest.serve")(function* (id: string) {
  const fixtures = yield* Fixtures;
  yield* Ref.update(fixtures.calls, (calls) =>
    new Map(calls).set(id, Option.getOrElse(Option.fromNullishOr(calls.get(id)), () => 0) + 1),
  );
  const held = Option.fromNullishOr((yield* Ref.get(fixtures.held)).get(id));
  if (Option.isSome(held)) {
    yield* Deferred.succeed(held.value.started, void 0);
    yield* Deferred.await(held.value.gate);
  }
  return `value:${id}`;
});

const TenantLive = implementQuery(TenantInfo, { run: ({ tenant }) => serve(`tenant:${tenant}`) });
const PostLive = implementQuery(PostBody, {
  run: ({ tenant, postId }) => serve(`post:${tenant}/${postId}`),
});

// ---------------------------------------------------------------------------
// The navigation access service a check needs, and one ordered event log
// ---------------------------------------------------------------------------

interface AccessService {
  /** Checks, imports, and setups, in the order they happened. */
  readonly events: Ref.Ref<ReadonlyArray<string>>;
  /** Tenants whose members are signed out: the tenant check redirects. */
  readonly denied: Ref.Ref<ReadonlySet<string>>;
}

class Access extends Context.Service<Access, AccessService>()(
  "effect-frame/tests/router/route-pending.test/Access",
) {}

const makeAccess = Effect.gen(function* () {
  return Access.of({
    events: yield* Ref.make<ReadonlyArray<string>>([]),
    denied: yield* Ref.make<ReadonlySet<string>>(new Set()),
  });
});

const makeFixtures = Effect.gen(function* () {
  return Fixtures.of({
    held: yield* Ref.make<ReadonlyMap<string, Held>>(new Map()),
    calls: yield* Ref.make<ReadonlyMap<string, number>>(new Map()),
  });
});

const client = Layer.merge(
  QueryCache.layer,
  ActorHost.layer({
    implementations: [],
    queries: [TenantLive, PostLive],
    store: ActorHost.memoryStore,
  }),
).pipe(Layer.provide(policies));

const frameLayer = (name: string) =>
  client.pipe(
    Layer.provideMerge(
      Layer.mergeAll(Layer.effect(Fixtures, makeFixtures), Layer.effect(Access, makeAccess)),
    ),
    Layer.provideMerge(TestClock.layer()),
    Layer.provideMerge(Frame.layer({ name })),
  );

const logEvent = (events: Ref.Ref<ReadonlyArray<string>>, event: string) =>
  Ref.update(events, (all) => [...all, event]);

const holdQuery = Effect.fn("PendingTest.holdQuery")(function* (id: string) {
  const fixtures = yield* Fixtures;
  const held: Held = { gate: yield* Deferred.make<void>(), started: yield* Deferred.make<void>() };
  yield* Ref.update(fixtures.held, (all) => new Map(all).set(id, held));
  return held;
});

const callsOf = Effect.fn("PendingTest.callsOf")(function* (id: string) {
  const fixtures = yield* Fixtures;
  return Option.getOrElse(Option.fromNullishOr((yield* Ref.get(fixtures.calls)).get(id)), () => 0);
});

const deny = Effect.fn("PendingTest.deny")(function* (tenant: string) {
  const access = yield* Access;
  yield* Ref.update(access.denied, (all) => new Set(all).add(tenant));
});

const eventsOf = Effect.fn("PendingTest.eventsOf")(function* () {
  const access = yield* Access;
  return yield* Ref.get(access.events);
});

// ---------------------------------------------------------------------------
// A controllable module import
// ---------------------------------------------------------------------------

type Outcome = "ok" | "reject";

/**
 * A platform import the test drives. Each call takes the next outcome, so an
 * import stays in flight until the test offers one. It is a Promise, as a
 * bundler's dynamic import is.
 */
interface Importer {
  readonly calls: Ref.Ref<number>;
  readonly started: Queue.Queue<number>;
  readonly outcomes: Queue.Queue<Outcome>;
  readonly settled: Queue.Queue<number>;
}

const makeImporter = Effect.gen(function* () {
  const importer: Importer = {
    calls: yield* Ref.make(0),
    started: yield* Queue.unbounded<number>(),
    outcomes: yield* Queue.unbounded<Outcome>(),
    settled: yield* Queue.unbounded<number>(),
  };
  return importer;
});

class ChunkFailed extends Schema.TaggedError<ChunkFailed>()("ChunkFailed", {
  call: Schema.Finite,
}) {}

const loader =
  <P, E, R>(
    importer: Importer,
    events: Ref.Ref<ReadonlyArray<string>>,
    module: LazyModule<P, E, R>,
  ) =>
  (): Promise<LazyModule<P, E, R>> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const call = yield* Ref.updateAndGet(importer.calls, (count) => count + 1);
        yield* logEvent(events, `import:${String(call)}`);
        yield* Queue.offer(importer.started, call);
        const outcome = yield* Queue.take(importer.outcomes);
        yield* Queue.offer(importer.settled, call);
        if (outcome === "reject") {
          return yield* Effect.die(ChunkFailed.make({ call }));
        }
        return module;
      }),
    );

// ---------------------------------------------------------------------------
// The tenant/post tree with a lazy, pending post
// ---------------------------------------------------------------------------

const LoginRouteSegment = Route.segment("login", {
  path: "/login",
  params: Schema.Struct({}),
  search: Route.search(Schema.Struct({ next: Schema.String.pipe(Route.withDefault("/")) })),
});
const LoginRoute = Route.client(
  "login",
  Route.leaf(LoginRouteSegment, (props) =>
    Effect.succeed(<p id="login">{View.bind(props.search, (search) => search.next)}</p>),
  ),
);

const TenantParams = Schema.Struct({ tenant: Schema.String });
const checkTenant = (next: Route.BeforeInput<{ readonly tenant: string }, {}>) =>
  Effect.gen(function* () {
    const access = yield* Access;
    yield* logEvent(access.events, `check:tenant:${next.url.pathname}`);
    if ((yield* Ref.get(access.denied)).has(next.params.tenant)) {
      return Route.redirect(LoginRouteSegment, {}, { next: next.url.pathname });
    }
    return Route.Continue;
  });

const checkPost = (
  next: Route.BeforeInput<{ readonly tenant: string; readonly postId: string }, {}>,
) =>
  Effect.gen(function* () {
    const access = yield* Access;
    yield* logEvent(access.events, `check:post:${next.url.pathname}`);
    return Route.Continue;
  });

const tenantSegment = Route.segment("tenant", {
  path: "/app/:tenant",
  params: TenantParams,
  data: ({ params }) => ({ tenant: Route.query(TenantInfo, { tenant: params.tenant }) }),
  before: checkTenant,
});

const postSegment = Route.child(tenantSegment, "post", {
  path: "posts/:postId",
  params: Schema.Struct({ postId: Schema.String }),
  // Declared and never read by the view: an unread query.
  data: ({ params }) => ({
    post: Route.query(PostBody, { tenant: params.tenant, postId: params.postId }),
  }),
  before: checkPost,
});

class PostFailed extends Schema.TaggedError<PostFailed>()("PostFailed", {
  postId: Schema.String,
}) {}

const PostRevision = 40;
const BumpedRevision = 99;

const spawnAtRevision = Effect.fn("PendingTest.spawnAtRevision")(function* (revision: number) {
  const local = yield* Actor.local(Behavior.value(0));
  for (let next = 1; next <= revision; next += 1) {
    yield* Effect.orDie(local.call(Value.Set(next)));
  }
  return local;
});

interface Probes {
  readonly postSetups: Ref.Ref<ReadonlyArray<string>>;
  readonly postBuilt: Queue.Queue<string>;
  readonly postClosed: Queue.Queue<string>;
  /** Opened by the test: a `slow*` post's own setup waits on it. */
  readonly slow: Deferred.Deferred<void>;
  /** Each time the pending fallback reached the document. Plain, so `attach` may write it. */
  readonly pendingShown: Array<string>;
  /** Each time `errored` was built. */
  readonly erroredBuilt: Array<string>;
}

const makeProbes = Effect.gen(function* () {
  const probes: Probes = {
    postSetups: yield* Ref.make<ReadonlyArray<string>>([]),
    postBuilt: yield* Queue.unbounded<string>(),
    postClosed: yield* Queue.unbounded<string>(),
    slow: yield* Deferred.make<void>(),
    pendingShown: [],
    erroredBuilt: [],
  };
  return probes;
});

const describeFailure = <E extends { readonly _tag: string }>(
  failure: Route.RouteFailure<E>,
): string => {
  if (failure._tag === "Setup") {
    return `Setup:${failure.error._tag}`;
  }
  return `Declaration:${failure.error._tag}`;
};

/** The imported post view. Each instance runs this setup with its own Scope. */
const makePostView = (probes: Probes) => (props: Route.PropsOf<typeof postSegment>) =>
  Effect.gen(function* () {
    const access = yield* Access;
    const first = yield* props.params.get;
    yield* Ref.update(probes.postSetups, (all) => [...all, first.postId]);
    yield* logEvent(access.events, `setup:${first.postId}`);
    yield* Effect.addFinalizer(() => Queue.offer(probes.postClosed, first.postId));
    const local = yield* spawnAtRevision(PostRevision);
    if (first.postId === "bad") {
      return yield* PostFailed.make({ postId: first.postId });
    }
    if (first.postId.startsWith("slow")) {
      yield* Deferred.await(probes.slow);
    }
    if (first.postId.endsWith("-bad")) {
      return yield* PostFailed.make({ postId: first.postId });
    }
    if (first.postId.endsWith("-boom")) {
      return yield* Effect.die("post setup defect");
    }
    const tenant = yield* View.ready(props.data.tenant.state, "");
    yield* Queue.offer(probes.postBuilt, first.postId);
    return (
      <article id="post">
        <p id="post-param">{View.bind(props.params, (params) => params.postId)}</p>
        <span id="post-tenant">{View.bind(tenant)}</span>
        <output id="post-actor">{View.bind(local.state, String)}</output>
        <button id="bump" onClick={View.event(Effect.orDie(local.call(Value.Set(BumpedRevision))))}>
          bump
        </button>
      </article>
    );
  });

const PendingAfter = "100 millis";
const PendingAtLeast = "300 millis";

const makeApp = (probes: Probes, importer: Importer, events: Ref.Ref<ReadonlyArray<string>>) => {
  const LazyPost = View.lazy(loader(importer, events, { default: makePostView(probes) }));
  const tree = Route.layout(
    tenantSegment,
    [
      Route.leaf(postSegment, LazyPost, {
        errored: (failure) => {
          probes.erroredBuilt.push("errored");
          return <p id="post-errored">{View.bind(failure, describeFailure)}</p>;
        },
        pending: {
          fallback: (
            <p
              id="post-pending"
              attach={Dom.attach(() =>
                Effect.sync(() => {
                  probes.pendingShown.push("shown");
                }),
              )}
            >
              opening post
            </p>
          ),
          after: PendingAfter,
          atLeast: PendingAtLeast,
        },
      }),
    ],
    (props) =>
      Effect.gen(function* () {
        const body = yield* View.loading({
          fallback: <p id="child-loading">loading child</p>,
          content: Effect.map(props.outlet, (outlet) => <div id="outlet">{outlet}</div>),
        });
        return (
          <section id="layout">
            <p id="tenant-param">{View.bind(props.params, (value) => value.tenant)}</p>
            {body}
          </section>
        );
      }),
  );
  return Route.client("app", tree);
};

/** The post view as a plain leaf with no `pending`, under the layout's Loading. */
const makePlainApp = (probes: Probes, events: Ref.Ref<ReadonlyArray<string>>) => {
  const tree = Route.layout(
    tenantSegment,
    [
      Route.leaf(postSegment, makePostView(probes), {
        errored: (failure) => {
          probes.erroredBuilt.push("errored");
          return <p id="post-errored">{View.bind(failure, describeFailure)}</p>;
        },
      }),
    ],
    (props) =>
      Effect.gen(function* () {
        yield* Ref.update(events, (all) => [...all, "layout"]);
        const body = yield* View.loading({
          fallback: <p id="child-loading">loading child</p>,
          content: Effect.map(props.outlet, (outlet) => <div id="outlet">{outlet}</div>),
        });
        return <section id="layout">{body}</section>;
      }),
  );
  return Route.client("app", tree);
};

/** Each time a nested fallback reached the document, by owner. */
interface Shown {
  readonly parent: Array<string>;
  readonly child: Array<string>;
}

const recorded = (log: Array<string>, id: string, text: string) => (
  <p
    id={id}
    attach={Dom.attach(() =>
      Effect.sync(() => {
        log.push("shown");
      }),
    )}
  >
    {text}
  </p>
);

const pendingOf = (log: Array<string>, id: string): Route.Pending => ({
  fallback: recorded(log, id, id),
  after: PendingAfter,
  atLeast: PendingAtLeast,
});

/** A child that needs nothing: only its import prepares. */
const ChildView = (props: Route.PropsOf<typeof postSegment>) =>
  Effect.succeed(<p id="child">{View.bind(props.params, (params) => params.postId)}</p>);

const nestedChild = (shown: Shown, importer: Importer, events: Ref.Ref<ReadonlyArray<string>>) =>
  Route.leaf(postSegment, View.lazy(loader(importer, events, { default: ChildView })), {
    errored: () => <p id="child-errored">child errored</p>,
    pending: pendingOf(shown.child, "child-pending"),
  });

/** A lazy layout with pending, and a lazy leaf with pending under it. */
const makeLazyParentApp = (
  shown: Shown,
  parentImporter: Importer,
  childImporter: Importer,
  events: Ref.Ref<ReadonlyArray<string>>,
) => {
  const ParentView = (props: Route.LayoutPropsOf<typeof tenantSegment, never>) =>
    Effect.map(props.outlet, (outlet) => <section id="parent">{outlet}</section>);
  return Route.client(
    "nested",
    Route.layout(
      tenantSegment,
      [nestedChild(shown, childImporter, events)],
      View.lazy(loader(parentImporter, events, { default: ParentView })),
      {
        errored: () => <p id="parent-errored">parent errored</p>,
        pending: pendingOf(shown.parent, "parent-pending"),
      },
    ),
  );
};

/** A layout whose own setup waits on `gate`, and a lazy leaf with pending. */
const makeSlowParentApp = (
  shown: Shown,
  gate: Deferred.Deferred<void>,
  childImporter: Importer,
  events: Ref.Ref<ReadonlyArray<string>>,
) =>
  Route.client(
    "nested",
    Route.layout(
      tenantSegment,
      [nestedChild(shown, childImporter, events)],
      (props) =>
        Effect.gen(function* () {
          yield* Deferred.await(gate);
          const outlet = yield* props.outlet;
          return <section id="parent">{outlet}</section>;
        }),
      { pending: pendingOf(shown.parent, "parent-pending") },
    ),
  );

/** A first-frame tree: no `Loading`, and a lazy post whose setup never suspends. */
const makeFirstFrameApp = (
  probes: Probes,
  importer: Importer,
  events: Ref.Ref<ReadonlyArray<string>>,
) => {
  const FirstPost = (props: Route.PropsOf<typeof postSegment>) =>
    Effect.gen(function* () {
      const first = yield* props.params.get;
      yield* Ref.update(probes.postSetups, (all) => [...all, first.postId]);
      return <p id="post-first">{`post ${first.postId}`}</p>;
    });
  return Route.client(
    "app",
    Route.layout(
      tenantSegment,
      [
        Route.leaf(postSegment, View.lazy(loader(importer, events, { default: FirstPost })), {
          errored: () => <p id="post-errored">errored</p>,
          pending: pendingOf(probes.pendingShown, "post-pending"),
        }),
      ],
      (props) => Effect.map(props.outlet, (outlet) => <section id="layout">{outlet}</section>),
    ),
  );
};

const NotFound = (props: { readonly url: Source<URL> }) =>
  Effect.succeed(<p id="missing">{View.bind(props.url, (url) => url.pathname)}</p>);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const makeRoot = Effect.acquireRelease(
  Effect.sync(() => {
    const created = document.createElement("main");
    document.body.appendChild(created);
    return created;
  }),
  (created) => Effect.sync(() => created.remove()),
);

const origin = "http://frame.test";

const mountApp = <R,>(app: Route.AnyRoute<R>, root: HTMLElement, path: string) =>
  Effect.gen(function* () {
    const location = yield* memoryLocation(`${origin}${path}`);
    const page = yield* ViewTest.make({
      host: Dom.host,
      root,
      setup: (host, mountRoot) =>
        mountRouter({
          landing: NavigationBehavior.Restore,
          traversalReadLimit: "3 seconds",
          routes: [app, LoginRoute],
          notFound: NotFound,
          host,
          root: mountRoot,
        }).pipe(Effect.provideService(Location, location.location)),
    });
    return { page, router: page.setup, location };
  });

type Page = Effect.Success<ReturnType<typeof mountApp>>["page"];

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

const click = (root: HTMLElement, selector: string) =>
  Effect.sync(() => {
    const target = root.querySelector(selector);
    if (target instanceof HTMLElement) {
      target.click();
    }
  });

const actorsAt = (snapshot: Frame.Snapshot, revision: number) =>
  snapshot.actors.filter((one) => one.revision === revision);

const queryRecord = (snapshot: Frame.Snapshot, contractName: string, args: string) =>
  Option.fromNullishOr(
    snapshot.queries.find(
      (one) => one.key.startsWith(`${contractName}@`) && one.key.includes(args),
    ),
  );

const pathOf = (result: NavigationResult): string =>
  `${result._tag} ${result.url.pathname}${result.url.search}`;

/**
 * The entered post's presentation is live: its region settled the layout's
 * Loading, so the outlet is drawn and the Loading fallback is gone.
 */
const regionLive = (page: Page) =>
  page.waitFor({
    label: "the entered post's presentation region",
    until: (actual) => hasAt(actual, "#outlet") && !hasAt(actual, "#child-loading"),
  });

const pendingVisible = (page: Page) =>
  page.waitFor({
    label: "the post's pending fallback",
    until: (actual) => hasAt(actual, "#post-pending") && !hasAt(actual, "#post"),
  });

const postVisible = (page: Page, postId: string) =>
  page.waitFor({
    label: `post ${postId}`,
    until: (actual) =>
      textAt(actual, "#post-param") === postId &&
      textAt(actual, "#post-tenant") !== "" &&
      !hasAt(actual, "#post-pending"),
  });

const loginVisible = (page: Page) =>
  page.waitFor({
    label: "the sign-in page",
    until: (actual) => hasAt(actual, "#login") && !hasAt(actual, "#post-pending"),
  });

const setupsOf = (probes: Probes) => Ref.get(probes.postSetups);

// ---------------------------------------------------------------------------
// Type fixtures. Unannotated expressions only.
// ---------------------------------------------------------------------------

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type RouteServices<T> = T extends Route.AnyRoute<infer R> ? R : never;

const FixturePostView = (props: Route.PropsOf<typeof postSegment>) =>
  Effect.gen(function* () {
    const params = yield* props.params.get;
    if (params.postId === "bad") {
      return yield* PostFailed.make({ postId: params.postId });
    }
    const tenant = yield* View.ready(props.data.tenant.state, "");
    return <p>{View.bind(tenant)}</p>;
  });

/** An import that has already resolved. */
const resolved =
  <P, E, R>(view: (props: P) => Effect.Effect<Node, E, R>) =>
  (): Promise<LazyModule<P, E, R>> =>
    Effect.runPromise(Effect.succeed({ default: view }));

const lazyFixture = View.lazy(resolved(FixturePostView));
type Fixture = typeof FixturePostView;
type LazyFixture = typeof lazyFixture;

/** Same Props, same R, and E plus exactly the typed import failure. */
const lazyProps: Equals<Parameters<LazyFixture>[0], Parameters<Fixture>[0]> = true;
const lazyError: Equals<
  Effect.Error<ReturnType<LazyFixture>>,
  PostFailed | View.LazyImportFailed
> = true;
const lazyServices: Equals<
  Effect.Services<ReturnType<LazyFixture>>,
  Effect.Services<ReturnType<Fixture>>
> = true;
const lazyServicesExact: Equals<
  Effect.Services<ReturnType<LazyFixture>>,
  View.LoadingScope | ScopeType.Scope
> = true;
const lazyLeaf = Route.leaf(postSegment, lazyFixture, {
  errored: (failure) => <p>{View.bind(failure, describeFailure)}</p>,
  pending: { fallback: <p>opening</p>, after: "150 millis", atLeast: "200 millis" },
});
/** A view that cannot fail may present pending without an errored handler. */
const neverFails = (props: Route.PropsOf<typeof postSegment>) =>
  Effect.map(props.params.get, (params): Node => <p>{params.postId}</p>);
const pendingOnly = Route.leaf(postSegment, neverFails, {
  pending: { fallback: <p>opening</p>, after: 0, atLeast: 0 },
});
/** The app's services: declarations and the check. A lazy view adds none. */
const appServices: Equals<
  RouteServices<ReturnType<typeof makeApp>>,
  QueryCache | ActorTransport | Access
> = true;

// @effect-diagnostics missingEffectError:off
// @ts-expect-error A lazy view adds LazyImportFailed to E, so it needs an errored handler.
const unhandledImport = Route.leaf(postSegment, View.lazy(resolved(neverFails)));

// @ts-expect-error The handler must take LazyImportFailed as well as the view's own E.
const narrowHandler = Route.leaf(postSegment, lazyFixture, {
  errored: (failure: Source<Route.RouteFailure<PostFailed>>) => View.bind(failure, describeFailure),
});

const OtherView = (props: { readonly other: string }) => Effect.succeed(<p>{props.other}</p>);
const wrongModule = () =>
  // @ts-expect-error A lazy module's view must take the segment's props.
  Route.leaf(postSegment, View.lazy(resolved(OtherView)));

const wrongDuration = () =>
  // @ts-expect-error `after` is a Duration input.
  Route.leaf(postSegment, neverFails, {
    pending: { fallback: <p>opening</p>, after: true, atLeast: 0 },
  });
// @effect-diagnostics missingEffectError:error

const typeFixtures = [
  lazyProps,
  lazyError,
  lazyServices,
  lazyServicesExact,
  appServices,
  lazyLeaf,
  pendingOnly,
  unhandledImport,
  narrowHandler,
  wrongModule,
  wrongDuration,
];

// ---------------------------------------------------------------------------
// Proofs
// ---------------------------------------------------------------------------

describe("private route pending and lazy views", () => {
  it.effect("0. keeps exact lazy Props, E, and R, and typed pending options", () =>
    Effect.sync(() => {
      expect(typeFixtures.slice(0, 5)).toEqual([true, true, true, true, true]);
      // A lazy view is a tagged value: the route reads its definition off it.
      expect(lazyFixture._tag).toBe("LazyView");
    }),
  );

  it.scoped.layer(frameLayer("pending-timing"))(
    "1. imports after checks, shows pending only after `after`, and keeps it `atLeast`",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const probes = yield* makeProbes;
        const access = yield* Access;
        const importer = yield* makeImporter;
        const { page, router } = yield* mountApp(
          makeApp(probes, importer, access.events),
          root,
          "/app/t1",
        );
        yield* page.waitFor({
          label: "the layout alone",
          until: (actual) => textAt(actual, "#tenant-param") === "t1",
        });
        expect(yield* Ref.get(importer.calls)).toBe(0);

        // The transition enters the post after both checks continued, then
        // starts the import. The navigation commits without waiting for it.
        const moved = yield* router.push("/app/t1/posts/1");
        expect(pathOf(moved)).toBe("Committed /app/t1/posts/1");
        expect(yield* Queue.take(importer.started)).toBe(1);
        expect((yield* eventsOf()).slice(-3)).toEqual([
          "check:tenant:/app/t1/posts/1",
          "check:post:/app/t1/posts/1",
          "import:1",
        ]);

        // Before `after`: the region is live, and the fallback is not shown.
        yield* regionLive(page);
        yield* TestClock.adjust("99 millis");
        yield* View.flush;
        expect(hasAt(root, "#post-pending")).toBe(false);
        expect(probes.pendingShown).toEqual([]);

        // At `after`: the fallback shows.
        yield* TestClock.adjust("1 millis");
        yield* pendingVisible(page);
        expect(probes.pendingShown).toEqual(["shown"]);

        // The import lands at 100ms and setup completes, but the fallback
        // stays until 100 + `atLeast`.
        yield* Queue.offer(importer.outcomes, "ok");
        expect(yield* Queue.take(probes.postBuilt)).toBe("1");
        yield* TestClock.adjust("299 millis");
        yield* View.flush;
        expect(hasAt(root, "#post-pending")).toBe(true);
        expect(hasAt(root, "#post")).toBe(false);
        yield* TestClock.adjust("1 millis");
        yield* postVisible(page, "1");
        expect(yield* setupsOf(probes)).toEqual(["1"]);

        // A stayed post keeps its setup: a param move presents nothing.
        yield* router.push("/app/t1/posts/2");
        yield* postVisible(page, "2");
        expect(yield* setupsOf(probes)).toEqual(["1"]);

        // Work that finishes before `after` never shows the fallback: the
        // module is loaded, so a new post instance's setup is prompt.
        yield* router.push("/app/t1");
        expect(yield* Queue.take(probes.postClosed)).toBe("1");
        yield* router.push("/app/t1/posts/2");
        yield* postVisible(page, "2");
        expect(probes.pendingShown).toEqual(["shown"]);
        expect(yield* Ref.get(importer.calls)).toBe(1);
        expect(yield* setupsOf(probes)).toEqual(["1", "2"]);
      }),
  );

  it.scoped.layer(frameLayer("pending-shared-import"))(
    "2. one import serves two roots; each instance runs its own setup, Scope, and state",
    () =>
      Effect.gen(function* () {
        const probes = yield* makeProbes;
        const access = yield* Access;
        const importer = yield* makeImporter;
        const app = makeApp(probes, importer, access.events);
        const rootA = yield* makeRoot;
        const rootB = yield* makeRoot;
        const a = yield* mountApp(app, rootA, "/app/t1");
        const b = yield* mountApp(app, rootB, "/app/t1");

        // Both roots enter the post while the one import is in flight.
        yield* a.router.push("/app/t1/posts/1");
        expect(yield* Queue.take(importer.started)).toBe(1);
        yield* b.router.push("/app/t1/posts/1");
        yield* regionLive(a.page);
        yield* regionLive(b.page);
        expect(yield* Ref.get(importer.calls)).toBe(1);
        expect(yield* setupsOf(probes)).toEqual([]);

        yield* Queue.offer(importer.outcomes, "ok");
        yield* TestClock.adjust("1 second");
        yield* postVisible(a.page, "1");
        yield* postVisible(b.page, "1");
        expect(yield* Ref.get(importer.calls)).toBe(1);
        // Two setups, two Scopes, two local actors.
        expect(yield* setupsOf(probes)).toEqual(["1", "1"]);
        const both = actorsAt(yield* Frame.inspect, PostRevision);
        expect(both).toHaveLength(2);
        expect(both[0]?.id).not.toBe(both[1]?.id);

        // Roots do not share instance state.
        yield* click(rootA, "#bump");
        yield* a.page.waitFor({
          label: "root A's bumped actor",
          until: (actual) => textAt(actual, "#post-actor") === String(BumpedRevision),
        });
        expect(textAt(rootB, "#post-actor")).toBe(String(PostRevision));

        // Closing root A closes only its instance.
        yield* a.page.close;
        expect(yield* Queue.take(probes.postClosed)).toBe("1");
        expect(actorsAt(yield* Frame.inspect, PostRevision)).toHaveLength(1);
        expect(textAt(rootB, "#post-param")).toBe("1");

        // A new instance reuses the loaded module with a fresh setup.
        yield* b.router.push("/app/t1");
        expect(yield* Queue.take(probes.postClosed)).toBe("1");
        yield* b.router.push("/app/t1/posts/3");
        yield* postVisible(b.page, "3");
        expect(yield* Ref.get(importer.calls)).toBe(1);
        expect(yield* setupsOf(probes)).toEqual(["1", "1", "3"]);
      }),
  );

  it.scoped.layer(frameLayer("pending-import-rejected"))(
    "3. a typed import rejection shows errored at once, and a later attempt imports again",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const probes = yield* makeProbes;
        const access = yield* Access;
        const importer = yield* makeImporter;
        const { page, router } = yield* mountApp(
          makeApp(probes, importer, access.events),
          root,
          "/app/t1",
        );
        yield* router.push("/app/t1/posts/1");
        yield* Queue.take(importer.started);
        yield* regionLive(page);
        yield* TestClock.adjust(PendingAfter);
        yield* pendingVisible(page);

        // The chunk fails while the fallback is shown. `errored` replaces it
        // at once: the clock does not move, so `atLeast` held nothing.
        yield* Queue.offer(importer.outcomes, "reject");
        yield* page.waitFor({
          label: "the typed import failure",
          until: (actual) =>
            textAt(actual, "#post-errored") === "Setup:LazyImportFailed" &&
            !hasAt(actual, "#post-pending"),
        });
        expect(probes.erroredBuilt).toEqual(["errored"]);
        expect(yield* setupsOf(probes)).toEqual([]);
        expect(yield* Ref.get(importer.calls)).toBe(1);

        // The failure is not kept: the failed instance is entered again and
        // its import runs again.
        yield* router.push("/app/t1/posts/2");
        expect(yield* Queue.take(importer.started)).toBe(2);
        yield* Queue.offer(importer.outcomes, "ok");
        yield* TestClock.adjust("1 second");
        yield* postVisible(page, "2");
        expect(hasAt(root, "#post-errored")).toBe(false);
        expect(yield* Ref.get(importer.calls)).toBe(2);
        expect(yield* setupsOf(probes)).toEqual(["2"]);

        // The view's own typed failure while the fallback shows also draws
        // `errored` at once.
        yield* router.push("/app/t1");
        yield* router.push("/app/t1/posts/slow-bad");
        yield* regionLive(page);
        const now = yield* Clock.currentTimeMillis;
        yield* TestClock.adjust(PendingAfter);
        yield* pendingVisible(page);
        yield* Deferred.succeed(probes.slow, void 0);
        yield* page.waitFor({
          label: "the view's typed setup failure",
          until: (actual) =>
            textAt(actual, "#post-errored") === "Setup:PostFailed" &&
            !hasAt(actual, "#post-pending"),
        });
        expect(yield* Clock.currentTimeMillis).toBe(now + 100);
        expect(yield* Queue.take(probes.postClosed)).toBe("2");
        expect(yield* Queue.take(probes.postClosed)).toBe("slow-bad");
      }),
  );

  it.scoped.layer(frameLayer("pending-cancel"))(
    "4. exit, redirect, and root close remove the fallback at once and mount nothing late",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const probes = yield* makeProbes;
        const access = yield* Access;
        const importer = yield* makeImporter;
        const { page, router } = yield* mountApp(
          makeApp(probes, importer, access.events),
          root,
          "/app/t1",
        );

        // Exit while the import is in flight and the fallback is shown.
        yield* router.push("/app/t1/posts/1");
        yield* Queue.take(importer.started);
        yield* regionLive(page);
        yield* TestClock.adjust(PendingAfter);
        yield* pendingVisible(page);
        yield* router.push("/login");
        yield* loginVisible(page);
        // The import completes after the exit: nothing sets up or mounts.
        yield* Queue.offer(importer.outcomes, "ok");
        expect(yield* Queue.take(importer.settled)).toBe(1);
        yield* TestClock.adjust("1 second");
        yield* View.flush;
        expect(yield* setupsOf(probes)).toEqual([]);
        expect(hasAt(root, "#post")).toBe(false);
        const exited = yield* Frame.inspect;
        expect(exited.routes.map((one) => one.routeName)).toEqual(["login"]);
        expect(exited.queries).toHaveLength(0);

        // A redirect away from a post whose own setup is suspended.
        yield* router.push("/app/t1/posts/slow-1");
        expect(yield* Ref.get(importer.calls)).toBe(1);
        yield* regionLive(page);
        yield* TestClock.adjust(PendingAfter);
        yield* pendingVisible(page);
        expect(yield* setupsOf(probes)).toEqual(["slow-1"]);
        yield* deny("t9");
        const redirected = yield* router.push("/app/t9/posts/1");
        expect(pathOf(redirected)).toBe("Committed /login?next=%2Fapp%2Ft9%2Fposts%2F1");
        yield* loginVisible(page);
        expect(yield* Queue.take(probes.postClosed)).toBe("slow-1");
        expect(actorsAt(yield* Frame.inspect, PostRevision)).toHaveLength(0);

        // A root close while the fallback is shown.
        yield* router.push("/app/t1/posts/slow-2");
        yield* regionLive(page);
        yield* TestClock.adjust(PendingAfter);
        yield* pendingVisible(page);
        yield* page.close;
        expect(yield* Queue.take(probes.postClosed)).toBe("slow-2");
        yield* Deferred.succeed(probes.slow, void 0);
        yield* TestClock.adjust("1 second");
        yield* View.flush;
        expect(hasAt(root, "#post")).toBe(false);
        expect(hasAt(root, "#post-pending")).toBe(false);
        const closed = yield* Frame.inspect;
        expect(closed.actors.filter((one) => one.kind === "local")).toHaveLength(0);
        expect(closed.queries).toHaveLength(0);
        expect(closed.mounts).toHaveLength(0);
        expect(closed.routes).toHaveLength(0);
        expect(probes.pendingShown).toEqual(["shown", "shown", "shown"]);
      }),
  );

  it.scoped.layer(frameLayer("pending-unread-query"))(
    "5. an unread held query blocks neither the route nor the removal of its fallback",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const probes = yield* makeProbes;
        const access = yield* Access;
        const importer = yield* makeImporter;
        const held = yield* holdQuery("post:t1/1");
        const { page, router } = yield* mountApp(
          makeApp(probes, importer, access.events),
          root,
          "/app/t1",
        );
        yield* router.push("/app/t1/posts/1");
        yield* Queue.take(importer.started);
        yield* Deferred.await(held.started);
        yield* regionLive(page);
        yield* TestClock.adjust(PendingAfter);
        yield* pendingVisible(page);
        yield* Queue.offer(importer.outcomes, "ok");
        yield* TestClock.adjust(PendingAtLeast);
        yield* postVisible(page, "1");

        // The declared post query is still in flight and nothing waited on it.
        expect(yield* callsOf("post:t1/1")).toBe(1);
        const snapshot = yield* Frame.inspect;
        expect(Option.isSome(queryRecord(snapshot, "PendingPostBody", '"postId":"1"'))).toBe(true);
        expect(yield* Deferred.isDone(held.gate)).toBe(false);
        yield* Deferred.succeed(held.gate, void 0);
      }),
  );

  it.scoped.layer(frameLayer("pending-protected"))(
    "6. a protected lazy child's import never starts when its parent check redirects",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const probes = yield* makeProbes;
        const access = yield* Access;
        const importer = yield* makeImporter;
        yield* deny("t2");
        const { page, router } = yield* mountApp(
          makeApp(probes, importer, access.events),
          root,
          "/app/t2/posts/1",
        );
        yield* loginVisible(page);
        const refused = yield* router.push("/app/t2/posts/2");
        expect(pathOf(refused)).toBe("Committed /login?next=%2Fapp%2Ft2%2Fposts%2F2");
        yield* loginVisible(page);
        // The parent refused twice. No child check, import, or setup ran.
        expect(yield* Ref.get(importer.calls)).toBe(0);
        expect(yield* eventsOf()).toEqual([
          "check:tenant:/app/t2/posts/1",
          "check:tenant:/app/t2/posts/2",
        ]);
        expect(yield* setupsOf(probes)).toEqual([]);

        // A permitted navigation imports once.
        yield* Queue.offer(importer.outcomes, "ok");
        yield* router.push("/app/t1/posts/1");
        yield* TestClock.adjust("1 second");
        yield* postVisible(page, "1");
        expect(yield* Ref.get(importer.calls)).toBe(1);
      }),
  );

  it.scoped.layer(frameLayer("pending-first-frame"))(
    "7. the initial first frame waits for the import and setup, and never shows pending",
    () =>
      Effect.gen(function* () {
        const probes = yield* makeProbes;
        const access = yield* Access;
        const importer = yield* makeImporter;
        const { location } = yield* memoryLocation(`${origin}/app/t1/posts/1`);
        const scope = yield* Scope.make();
        const htmlRoot = Html.element("#root");
        const mounting = yield* Effect.forkChild(
          mountRouter({
            landing: NavigationBehavior.Restore,
            traversalReadLimit: "3 seconds",
            routes: [makeFirstFrameApp(probes, importer, access.events)],
            notFound: NotFound,
            host: Html.host,
            root: htmlRoot,
          }).pipe(Effect.provideService(Location, location), Scope.provide(scope)),
        );
        yield* Queue.take(importer.started);
        // The mount waits for the import, however long it takes.
        yield* TestClock.adjust("1 second");
        expect(Option.isNone(Option.fromNullishOr(mounting.pollUnsafe()))).toBe(true);
        expect(yield* setupsOf(probes)).toEqual([]);

        yield* Queue.offer(importer.outcomes, "ok");
        yield* Fiber.join(mounting);
        // The post's setup started before the shell returned.
        expect(yield* setupsOf(probes)).toEqual(["1"]);
        yield* View.flush;
        const html = Html.serializeChildren(htmlRoot.children);
        yield* Scope.close(scope, Exit.void);

        // The leaf's root is focusable by the router, not by Tab (#31).
        expect(html).toContain(
          '<section id="layout"><p id="post-first" tabindex="-1">post 1</p></section>',
        );
        expect(html).not.toContain("post-pending");
        expect(yield* Ref.get(importer.calls)).toBe(1);
        const closed = yield* Frame.inspect;
        expect(closed.actors.filter((one) => one.kind === "local")).toHaveLength(0);
        expect(closed.queries).toHaveLength(0);
        expect(closed.mounts).toHaveLength(0);
        expect(closed.routes).toHaveLength(0);
      }),
  );
  it.scoped.layer(frameLayer("pending-defect"))(
    "8. a setup defect removes the fallback at once and leaves the enclosing Loading settled",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const probes = yield* makeProbes;
        const access = yield* Access;
        const importer = yield* makeImporter;
        yield* Queue.offer(importer.outcomes, "ok");
        const { page, router } = yield* mountApp(
          makeApp(probes, importer, access.events),
          root,
          "/app/t1",
        );
        yield* router.push("/app/t1/posts/slow-boom");
        yield* regionLive(page);
        yield* TestClock.adjust(PendingAfter);
        yield* pendingVisible(page);
        yield* Deferred.succeed(probes.slow, void 0);
        // No clock movement: the fallback goes, and the layout's Loading
        // does not fall back to its own fallback forever.
        yield* page.waitFor({
          label: "the settled region after a defect",
          until: (actual) =>
            !hasAt(actual, "#post-pending") &&
            hasAt(actual, "#outlet") &&
            !hasAt(actual, "#child-loading"),
        });
        expect(yield* Queue.take(probes.postClosed)).toBe("slow-boom");
        expect(hasAt(root, "#post-errored")).toBe(false);
        expect(probes.erroredBuilt).toEqual([]);

        // The Frame and the layout stay alive: the next entry sets up.
        yield* router.push("/app/t1");
        yield* router.push("/app/t1/posts/3");
        yield* postVisible(page, "3");
      }),
  );

  it.scoped.layer(frameLayer("pending-defect-plain"))(
    "8b. without pending, a setup defect still leaves the enclosing Loading settled",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const probes = yield* makeProbes;
        const access = yield* Access;
        const { page, router } = yield* mountApp(
          makePlainApp(probes, access.events),
          root,
          "/app/t1",
        );
        yield* router.push("/app/t1/posts/slow-boom");
        // The waiting setup has registered no read, so the layout's Loading
        // has nothing to wait for: it shows the outlet, not its fallback.
        yield* page.waitFor({
          label: "the layout's outlet while the setup waits",
          until: (actual) => hasAt(actual, "#outlet") && !hasAt(actual, "#child-loading"),
        });
        yield* Deferred.succeed(probes.slow, void 0);
        yield* page.waitFor({
          label: "the settled region after a defect",
          until: (actual) => hasAt(actual, "#outlet") && !hasAt(actual, "#child-loading"),
        });
        expect(yield* Queue.take(probes.postClosed)).toBe("slow-boom");
        expect(probes.erroredBuilt).toEqual([]);

        yield* router.push("/app/t1");
        yield* router.push("/app/t1/posts/3");
        yield* postVisible(page, "3");
      }),
  );

  const nestedScenario = <E,>(
    page: Page,
    root: HTMLElement,
    shown: Shown,
    childImporter: Importer,
    parentDrawn: Effect.Effect<void, E>,
    kind: "prompt" | "hold",
  ) =>
    Effect.gen(function* () {
      yield* parentDrawn;
      // The child's presentation starts only now, long after the
      // transition entered it. Its fallback has not been drawn.
      yield* View.flush;
      expect(shown.child).toEqual([]);
      expect(hasAt(root, "#child-pending")).toBe(false);
      if (kind === "prompt") {
        // The import lands before `after`, counted from when the child's
        // presentation started: no flash.
        yield* Queue.offer(childImporter.outcomes, "ok");
        yield* page.waitFor({
          label: "the child view",
          until: (actual) => hasAt(actual, "#child") && !hasAt(actual, "#child-pending"),
        });
        expect(shown.child).toEqual([]);
        return;
      }
      // `after` counts from when the child's presentation started, and
      // `atLeast` from when its fallback was drawn.
      yield* TestClock.adjust("99 millis");
      yield* View.flush;
      expect(shown.child).toEqual([]);
      yield* TestClock.adjust("1 millis");
      yield* page.waitFor({
        label: "the child fallback",
        until: (actual) => hasAt(actual, "#child-pending"),
      });
      expect(shown.child).toEqual(["shown"]);
      yield* Queue.offer(childImporter.outcomes, "ok");
      expect(yield* Queue.take(childImporter.settled)).toBe(1);
      yield* TestClock.adjust("299 millis");
      yield* View.flush;
      expect(hasAt(root, "#child-pending")).toBe(true);
      expect(hasAt(root, "#child")).toBe(false);
      yield* TestClock.adjust("1 millis");
      yield* page.waitFor({
        label: "the child view after atLeast",
        until: (actual) => hasAt(actual, "#child") && !hasAt(actual, "#child-pending"),
      });
      expect(shown.child).toEqual(["shown"]);
    });

  const nestedCases: ReadonlyArray<{
    readonly kind: "prompt" | "hold";
    readonly letter: string;
    readonly outcome: string;
  }> = [
    { kind: "prompt", letter: "a", outcome: "does not flash" },
    { kind: "hold", letter: "b", outcome: "holds atLeast from when it showed" },
  ];

  for (const { kind, letter, outcome } of nestedCases) {
    it.scoped.layer(frameLayer(`pending-lazy-parent-${kind}`))(
      `9${letter}. under a lazy parent that lands late, the child ${outcome}`,
      () =>
        Effect.gen(function* () {
          const root = yield* makeRoot;
          const access = yield* Access;
          const parentImporter = yield* makeImporter;
          const childImporter = yield* makeImporter;
          const shown: Shown = { parent: [], child: [] };
          const { page, router } = yield* mountApp(
            makeLazyParentApp(shown, parentImporter, childImporter, access.events),
            root,
            "/login",
          );
          yield* loginVisible(page);
          yield* router.push("/app/t1/posts/1");
          // Both imports start when the transition enters the branch.
          yield* Queue.take(parentImporter.started);
          yield* Queue.take(childImporter.started);
          yield* TestClock.adjust(PendingAfter);
          yield* page.waitFor({
            label: "the parent fallback",
            until: (actual) => hasAt(actual, "#parent-pending"),
          });
          yield* TestClock.adjust("400 millis");
          const parentDrawn = Effect.gen(function* () {
            yield* Queue.offer(parentImporter.outcomes, "ok");
            yield* page.waitFor({
              label: "the parent view",
              until: (actual) => hasAt(actual, "#parent") && !hasAt(actual, "#parent-pending"),
            });
          });
          yield* nestedScenario(page, root, shown, childImporter, parentDrawn, kind);
          expect(shown.parent).toEqual(["shown"]);
        }),
    );

    it.scoped.layer(frameLayer(`pending-slow-parent-${kind}`))(
      `10${letter}. under a slow parent setup, the child ${outcome}`,
      () =>
        Effect.gen(function* () {
          const root = yield* makeRoot;
          const access = yield* Access;
          const childImporter = yield* makeImporter;
          const gate = yield* Deferred.make<void>();
          const shown: Shown = { parent: [], child: [] };
          const { page, router } = yield* mountApp(
            makeSlowParentApp(shown, gate, childImporter, access.events),
            root,
            "/login",
          );
          yield* loginVisible(page);
          yield* router.push("/app/t1/posts/1");
          yield* Queue.take(childImporter.started);
          yield* TestClock.adjust(PendingAfter);
          yield* page.waitFor({
            label: "the parent fallback",
            until: (actual) => hasAt(actual, "#parent-pending"),
          });
          // The parent's setup ends at 100ms; its own fallback holds to 400ms.
          yield* Deferred.succeed(gate, void 0);
          const parentDrawn = Effect.gen(function* () {
            yield* TestClock.adjust("300 millis");
            yield* page.waitFor({
              label: "the parent view",
              until: (actual) => hasAt(actual, "#parent") && !hasAt(actual, "#parent-pending"),
            });
          });
          yield* nestedScenario(page, root, shown, childImporter, parentDrawn, kind);
          expect(shown.parent).toEqual(["shown"]);
        }),
    );
  }
});
