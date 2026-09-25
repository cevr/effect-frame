import { registerDom } from "./dom-setup.js";

registerDom();

import {
  ActorTransport,
  Authenticated,
  CurrentPrincipal,
  Policies,
  Policy,
  QueryCache,
  Streaming,
  contract,
  implementQuery,
  query,
} from "effect-frame/actor";
import type { QueryFailure, QueryState } from "effect-frame/actor";
import { QueryTest } from "effect-frame/actor/testing";
import {
  DocumentTimedOut,
  Location,
  Route,
  mount as mountRouter,
  renderDocument,
  NavigationBehavior,
} from "effect-frame/router";
import type {
  AnyRoute,
  DocumentOutcome,
  LocationService,
  NotFoundProps,
  RenderedDocument,
} from "effect-frame/router";
import { Dom, View } from "effect-frame/view";
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect";
import { describe, expect, it } from "effect-bun-test";
import {
  Label,
  Moving,
  type Mover,
  type Side,
  collect,
  eventually,
  eventuallyEffect,
  frame,
  hydrateWith,
  idOf,
  install,
  makeControl,
  recordsIn,
  release,
  sideOf,
  textOf,
} from "../view/streaming-fixture.js";

/**
 * Declared route data and the rendering modes (#18 §3, §4.3, §6, with #22
 * and #85). A route tree is one value; its mode constructor decides how
 * `renderDocument` renders it, and the same views run on both sides. See
 * `docs/design/route-data.md`.
 */

const origin = "http://app.test";

type Labelled = QueryState<{ readonly label: string }, QueryFailure>;

const labelOf = (state: Labelled): string => {
  if (state._tag === "Ready") {
    return state.value.label;
  }
  return state._tag;
};

const NotFound = (_props: NotFoundProps) => Effect.succeed(<p id="missing">missing</p>);

/** A Location that stays where it is put, and moves when the router moves it. */
const locationAt = (href: string): Effect.Effect<LocationService> =>
  Effect.map(Ref.make(new URL(href)), (current) => ({
    current: Ref.get(current),
    push: (url) => Ref.set(current, url),
    replace: (url) => Ref.set(current, url),
    pops: Stream.never,
  }));

/** Every query key the client cache holds a declaration of, by its `id` arg. */
const activeIds = Effect.gen(function* () {
  const cache = yield* QueryCache;
  const decode = Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Struct({ id: Schema.String })),
  );
  const keys = yield* Effect.forEach(yield* cache.active, (key) => decode(key.args));
  return keys.map((key) => key.id).toSorted();
});

const seedIn = (html: string): ReadonlyArray<Streaming.Patch> =>
  Option.match(
    Option.fromNullishOr(
      new RegExp(`<script type="application/json" id="${Streaming.seedId}">(.*?)</script>`).exec(
        html,
      ),
    ),
    {
      onNone: () => [],
      onSome: (found) =>
        Schema.decodeUnknownSync(Streaming.SeedJson)(
          Option.getOrElse(Option.fromNullishOr(found[1]), () => "[]"),
        ),
    },
  );

// ---------------------------------------------------------------------------
// One tenant/post branch, mounted under every mode
// ---------------------------------------------------------------------------

const TenantParams = Schema.Struct({ tenant: Schema.String });
const PostParams = Schema.Struct({ tenant: Schema.String, postId: Schema.String });

const tenantSegment = Route.segment("tenant", {
  path: "/app/:tenant",
  params: TenantParams,
  data: ({ params }) => ({ tenant: Route.query(Label, { id: `tenant-${params.tenant}` }) }),
});

const postSegment = Route.child(tenantSegment, "post", {
  path: "posts/:postId",
  params: PostParams,
  data: ({ params }) => ({ post: Route.query(Label, { id: `post-${params.postId}` }) }),
});

const branch = Route.layout(
  tenantSegment,
  [
    Route.leaf(postSegment, (props) =>
      Effect.succeed(<article id="post">{View.bind(props.data.post.state, labelOf)}</article>),
    ),
  ],
  (props) =>
    Effect.map(props.outlet, (outlet) => (
      <section id="layout">
        <h1 id="tenant">{View.bind(props.data.tenant.state, labelOf)}</h1>
        <div id="slot">{outlet}</div>
      </section>
    )),
);

/**
 * The same segments for a streamed page: the shell draws a `Loading`
 * fallback in place of what waits, so the client's first frame, which the
 * later patches fill, swaps that boundary instead of mismatching its text.
 */
const streamBranch = Route.layout(
  tenantSegment,
  [
    Route.leaf(postSegment, (props) =>
      Effect.gen(function* () {
        const tenant = yield* View.ready(props.data.tenant.state, { label: "?" });
        const post = yield* View.ready(props.data.post.state, { label: "?" });
        return (
          <article id="post">
            {View.bind(tenant, (value) => value.label)}: {View.bind(post, (value) => value.label)}
          </article>
        );
      }),
    ),
  ],
  (props) =>
    Effect.gen(function* () {
      const body = yield* View.loading({ fallback: <p id="wait">wait</p>, content: props.outlet });
      return <section id="layout">{body}</section>;
    }),
);

const ssrApp = Route.ssr("ssr-app", branch);
const streamedApp = Route.streamed("streamed-app", streamBranch);
const awaitApp = Route.awaitAll("await-app", branch);
const clientApp = Route.client("client-app", branch);

const postUrl = new URL(`${origin}/app/t1/posts/1`);

const documentOf = <R,>(
  routes: ReadonlyArray<AnyRoute<R>>,
  url = postUrl,
  closeWhen: Effect.Effect<void> = Effect.never,
) => renderDocument({ routes, notFound: NotFound, url, document: frame, closeWhen });

/** The outcome is a document, not a redirect. */
const renderedOf = <R,>(outcome: DocumentOutcome<R>): Effect.Effect<RenderedDocument<R>> => {
  if (outcome._tag === "Rendered") {
    return Effect.succeed(outcome);
  }
  return Effect.die(`expected a document, got a redirect to ${outcome.location.href}`);
};

/** Render over one side, and fail the test on a redirect. */
const renderIn = <R, S>(
  side: Context.Context<S>,
  routes: ReadonlyArray<AnyRoute<R>>,
  url = postUrl,
  closeWhen: Effect.Effect<void> = Effect.never,
) =>
  Effect.flatMap(documentOf(routes, url, closeWhen).pipe(Effect.provideContext(side)), renderedOf);

/** The whole document of one render. */
const htmlIn = <R, S>(
  side: Context.Context<S>,
  routes: ReadonlyArray<AnyRoute<R>>,
  url = postUrl,
) =>
  Effect.flatMap(renderIn(side, routes, url), (rendered) =>
    Effect.map(collect(rendered.body), (chunks) => chunks.join("")),
  );

describe("declared data on the server (#18 §3.3)", () => {
  it.scopedLive(
    "an SSR render resolves the branch's declared data before render, and the client hydrates with no read",
    () =>
      Effect.gen(function* () {
        const serverControl = makeControl({ "tenant-t1": "Acme", "post-1": "Hello" }, [
          "tenant-t1",
          "post-1",
        ]);
        const server = yield* sideOf(serverControl);
        const rendering = yield* Effect.forkChild(renderIn(server, [ssrApp]));
        // Both reads start at once, the layout's and the leaf's, and nothing is written.
        yield* eventually("both reads started", () => serverControl.calls.length === 2);
        expect(serverControl.calls.toSorted()).toEqual(["post-1", "tenant-t1"]);
        yield* release(serverControl, "tenant-t1");
        yield* Effect.sleep("30 millis");
        // The render waits for the slower declaration: no view has drawn yet.
        expect(rendering.pollUnsafe()).toBeUndefined();
        yield* release(serverControl, "post-1");
        const rendered = yield* Fiber.join(rendering);
        expect(rendered.route).toEqual({ _tag: "Matched", route: ssrApp });
        expect([rendered.mode, rendered.status]).toEqual(["SSR", 200]);
        const html = (yield* collect(rendered.body)).join("");

        expect(html).toContain('<h1 id="tenant">Acme</h1>');
        expect(html).toContain('<article id="post" tabindex="-1">Hello</article>');
        expect(html).not.toContain("Loading");
        expect(html).not.toContain(Streaming.containerId);
        expect(
          seedIn(html)
            .map((patch) => patch.id)
            .toSorted(),
        ).toEqual([idOf("post-1"), idOf("tenant-t1")].toSorted());

        const clientControl = makeControl({});
        const client = yield* sideOf(clientControl);
        const location = yield* locationAt(postUrl.href);
        yield* install(html);
        const { report } = yield* hydrateWith(client, (host, root) =>
          mountRouter({
            landing: NavigationBehavior.Restore,
            traversalReadLimit: "3 seconds",
            routes: [ssrApp],
            notFound: NotFound,
            host,
            root,
          }).pipe(Effect.provideService(Location, location)),
        );
        expect(report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 0 });
        expect(textOf("#post")).toBe("Hello");
        expect(textOf("#tenant")).toBe("Acme");
        expect(clientControl.calls).toEqual([]);
      }),
    10_000,
  );

  it.scopedLive("a layout's view wraps its child's at the outlet", () =>
    Effect.gen(function* () {
      const server = yield* sideOf(makeControl({ "tenant-t1": "Acme", "post-1": "Hello" }));
      const html = yield* htmlIn(server, [ssrApp]);
      expect(html).toContain(
        '<section id="layout"><h1 id="tenant">Acme</h1><div id="slot"><article id="post" tabindex="-1">Hello</article></div></section>',
      );
    }),
  );

  const settledModes: ReadonlyArray<{
    readonly label: string;
    readonly make: typeof Route.ssr;
  }> = [
    { label: "SSR", make: Route.ssr },
    { label: "AwaitAll", make: Route.awaitAll },
  ];
  for (const { label, make } of settledModes) {
    it.scopedLive(
      `an ${label} layout that puts its outlet in Loading draws the leaf, and the client claims it`,
      () =>
        Effect.gen(function* () {
          // The first frame holds the outlet's first instance, as it holds the
          // root: the leaf's reads register with the layout's Loading while
          // that Loading sets up. The data is settled, so both sides draw the
          // leaf, and the client claims the server's nodes.
          const serverControl = makeControl({ "tenant-t1": "Acme", "post-1": "Hello" });
          const server = yield* sideOf(serverControl);
          const app = make(`loading-outlet-${label}`, streamBranch);
          const html = yield* htmlIn(server, [app]);

          expect(html).toContain('<!--frame-boundary:content--><article id="post"');
          expect(html).not.toContain('<p id="wait">wait</p>');

          const clientControl = makeControl({});
          const client = yield* sideOf(clientControl);
          const location = yield* locationAt(postUrl.href);
          yield* install(html);
          const { report } = yield* hydrateWith(client, (host, root) =>
            mountRouter({
              landing: NavigationBehavior.Restore,
              traversalReadLimit: "3 seconds",
              routes: [app],
              notFound: NotFound,
              host,
              root,
            }).pipe(Effect.provideService(Location, location)),
          );
          expect(report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 0 });
          expect(textOf("#post")).toBe("Acme: Hello");
          expect(clientControl.calls).toEqual([]);
        }),
      10_000,
    );
  }

  it.scopedLive(
    "an SSR render whose declared data has not settled at the time limit times out, and releases its reads",
    () =>
      Effect.gen(function* () {
        const serverControl = makeControl({ "tenant-t1": "Acme", "post-1": "Hello" }, ["post-1"]);
        const server = yield* sideOf(serverControl);
        const limit = yield* Deferred.make<void>();
        const rendering = yield* Effect.forkChild(
          Effect.flip(renderIn(server, [ssrApp], postUrl, Deferred.await(limit))),
        );
        yield* eventually("both reads started", () => serverControl.calls.length === 2);
        yield* Effect.sleep("30 millis");
        expect(rendering.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(limit, void 0);
        const failure = yield* Fiber.join(rendering);
        expect(failure).toEqual(DocumentTimedOut.make({ phase: "draw" }));
        // The render's cache is closed: the held read was interrupted, not left running.
        expect(serverControl.interrupted).toEqual(["post-1"]);
      }),
    10_000,
  );

  it.scopedLive(
    "a Streamed render writes the shell first, a placeholder per declared query, then each patch",
    () =>
      Effect.gen(function* () {
        const serverControl = makeControl({ "tenant-t1": "Acme", "post-1": "Hello" }, ["post-1"]);
        const server = yield* sideOf(serverControl);
        const rendered = yield* renderIn(server, [streamedApp]);
        expect(rendered.mode).toBe("Streamed");
        const rendering = yield* Effect.forkChild(collect(rendered.body));
        yield* eventually("the post read started", () => serverControl.calls.includes("post-1"));
        yield* release(serverControl, "post-1");
        const chunks = yield* Fiber.join(rendering);
        const html = chunks.join("");
        // The shell did not wait: the held post leaves the fallback in the first chunk.
        expect(chunks[0]).toContain('<p id="wait">wait</p>');
        expect(chunks[0]).not.toContain('id="post"');
        const records = recordsIn(html);
        expect(
          records
            .filter((record) => record._tag === "Placeholder")
            .map((record) => record.id)
            .toSorted(),
        ).toEqual([idOf("post-1"), idOf("tenant-t1")].toSorted());
        expect(records.at(-1)?._tag).toBe("Closed");
        expect(html).toContain(String.raw`{\"label\":\"Hello\"}`);

        const clientControl = makeControl({});
        const client = yield* sideOf(clientControl);
        const location = yield* locationAt(postUrl.href);
        yield* install(html);
        const { report, resumed } = yield* hydrateWith(client, (host, root) =>
          mountRouter({
            landing: NavigationBehavior.Restore,
            traversalReadLimit: "3 seconds",
            routes: [streamedApp],
            notFound: NotFound,
            host,
            root,
          }).pipe(Effect.provideService(Location, location)),
        );
        yield* resumed.closed;
        yield* View.flush;
        // The whole stream is in the document before hydration, so every patch
        // arrived ahead of it: the client's first frame draws the patched
        // values, and replaces the server's fallback with them (#22).
        expect(report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 1 });
        yield* eventually("the patched post", () => textOf("#post") === "Acme: Hello");
        expect(clientControl.calls).toEqual([]);
      }),
    10_000,
  );

  it.scopedLive("an AwaitAll render writes one document and one seed, and no record channel", () =>
    Effect.gen(function* () {
      const serverControl = makeControl({ "tenant-t1": "Acme", "post-1": "Hello" }, ["post-1"]);
      const server = yield* sideOf(serverControl);
      const rendering = yield* Effect.forkChild(renderIn(server, [awaitApp]));
      yield* eventually("the post read started", () => serverControl.calls.includes("post-1"));
      yield* release(serverControl, "post-1");
      const rendered = yield* Fiber.join(rendering);
      expect(rendered.mode).toBe("AwaitAll");
      const chunks = yield* collect(rendered.body);
      expect(chunks).toHaveLength(1);
      const html = chunks.join("");
      expect(html).toContain('<article id="post" tabindex="-1">Hello</article>');
      expect(html).not.toContain(Streaming.containerId);
      expect(seedIn(html)).toHaveLength(2);
    }),
  );

  it.scopedLive("a ClientOnly render draws nothing and reads nothing", () =>
    Effect.gen(function* () {
      const serverControl = makeControl({ "tenant-t1": "Acme", "post-1": "Hello" });
      const server = yield* sideOf(serverControl);
      const rendered = yield* renderIn(server, [clientApp]);
      expect(rendered.route).toEqual({ _tag: "Matched", route: clientApp });
      expect(rendered.mode).toBe("ClientOnly");
      const html = (yield* collect(rendered.body)).join("");
      expect(html).toBe([frame.head, frame.tail, frame.bootstrap, frame.end].join(""));
      expect(serverControl.calls).toEqual([]);
    }),
  );

  it.scopedLive("a URL no route matches renders not-found as SSR, with status 404", () =>
    Effect.gen(function* () {
      const server = yield* sideOf(makeControl({}));
      const rendered = yield* renderIn(server, [ssrApp], new URL(`${origin}/nowhere`));
      expect([rendered.route, rendered.mode, rendered.status]).toEqual([
        { _tag: "NotFound" },
        "SSR",
        404,
      ]);
      const html = (yield* collect(rendered.body)).join("");
      expect(html).toContain('<p id="missing" tabindex="-1">missing</p>');
    }),
  );

  it.scopedLive("a user route named not-found is that route, not the fallback", () =>
    Effect.gen(function* () {
      const server = yield* sideOf(makeControl({}));
      const named = Route.ssr(
        "not-found",
        Route.leaf(
          Route.segment("not-found", { path: "/not-found", params: Schema.Struct({}) }),
          () => Effect.succeed(<p id="page">a page</p>),
        ),
      );
      const rendered = yield* renderIn(server, [named], new URL(`${origin}/not-found`));
      expect(rendered.route).toEqual({ _tag: "Matched", route: named });
      expect(rendered.status).toBe(200);
      const html = (yield* collect(rendered.body)).join("");
      expect(html).toContain('<p id="page" tabindex="-1">a page</p>');
      const fallback = yield* renderIn(server, [named], new URL(`${origin}/elsewhere`));
      expect([fallback.route, fallback.status]).toEqual([{ _tag: "NotFound" }, 404]);
    }),
  );
});

// ---------------------------------------------------------------------------
// Server settlement: checks first, then the mode (#18 §6, route-data.md)
// ---------------------------------------------------------------------------

const loginSegment = Route.segment("login", { path: "/login", params: Schema.Struct({}) });
const login = Route.client(
  "login",
  Route.leaf(loginSegment, () => Effect.succeed(<p id="login">login</p>)),
);

/** A guarded root segment whose check redirects to `login`, and counts each run. */
const guardedBranch = (runs: Array<string>, name: string) =>
  Route.leaf(
    Route.segment(name, {
      path: `/${name}`,
      params: Schema.Struct({}),
      data: () => ({ label: Route.query(Label, { id: name }) }),
      before: () =>
        Effect.sync(() => {
          runs.push(name);
          return Route.redirect(loginSegment, {}, {});
        }),
    }),
    (props) => Effect.succeed(<p id="guarded">{View.bind(props.data.label.state, labelOf)}</p>),
  );

/** A check that never answers, and records that the render interrupted it. */
const stuck = (interrupted: Array<string>) =>
  Route.ssr(
    "stuck",
    Route.leaf(
      Route.segment("stuck", {
        path: "/stuck",
        params: Schema.Struct({}),
        before: () =>
          Effect.never.pipe(
            Effect.onInterrupt(() => Effect.sync(() => void interrupted.push("check"))),
          ),
      }),
      () => Effect.succeed(<p id="stuck">stuck</p>),
    ),
  );

const Draft = contract("RouteDataDraft", {
  version: 1,
  policy: "public",
  key: Schema.Struct({ id: Schema.String }),
  snapshot: Schema.String,
  message: Schema.Struct({ text: Schema.String }),
});

const draftingBranch = Route.leaf(
  Route.segment("drafting", {
    path: "/drafting",
    params: Schema.Struct({}),
    data: () => ({
      draft: Route.actor(Draft, { id: "d1" }),
      notes: Route.query(Label, { id: "notes" }),
    }),
  }),
  () => Effect.succeed(<p id="drafting">drafting</p>),
);

const draftingApps = [
  { mode: "SSR", app: Route.ssr("drafting", draftingBranch) },
  { mode: "Streamed", app: Route.streamed("drafting", draftingBranch) },
  { mode: "AwaitAll", app: Route.awaitAll("drafting", draftingBranch) },
];

/** A side whose actor snapshot reads never answer, and record their interruption. */
const stuckSnapshots = (side: Side, events: Array<string>): Side => {
  const inner = Context.get(side, ActorTransport);
  return Context.add(side, ActorTransport, {
    ...inner,
    snapshot: () =>
      Effect.andThen(
        Effect.sync(() => void events.push("snapshot started")),
        Effect.never.pipe(
          Effect.onInterrupt(() => Effect.sync(() => void events.push("snapshot interrupted"))),
        ),
      ),
  });
};

describe("a server request settles before its mode is chosen", () => {
  it.scopedLive(
    "an SSR route that redirects to a ClientOnly route answers Redirect, and draws nothing",
    () =>
      Effect.gen(function* () {
        const control = makeControl({ guarded: "secret" });
        const server = yield* sideOf(control);
        const runs: Array<string> = [];
        const guarded = Route.ssr("guarded", guardedBranch(runs, "guarded"));
        const outcome = yield* documentOf([guarded, login], new URL(`${origin}/guarded`)).pipe(
          Effect.provideContext(server),
        );
        expect(outcome).toEqual({ _tag: "Redirect", location: new URL(`${origin}/login`) });
        expect(runs).toEqual(["guarded"]);
        // The source's data was never read, and the destination was not rendered here.
        expect(control.calls).toEqual([]);
      }),
  );

  it.scopedLive(
    "a redirecting route answers Redirect with its target, and has no view to draw",
    () =>
      Effect.gen(function* () {
        const control = makeControl({});
        const server = yield* sideOf(control);
        const asked: Array<string> = [];
        const moved = Route.redirecting(
          "moved",
          Route.segment("moved", {
            path: "/moved/:to",
            params: Schema.Struct({ to: Schema.String }),
          }),
          ({ params, kind }) =>
            Effect.sync(() => {
              asked.push(`${params.to}:${kind}`);
              return Route.redirect(loginSegment, {}, {});
            }),
        );
        const outcome = yield* documentOf([moved, login], new URL(`${origin}/moved/x`)).pipe(
          Effect.provideContext(server),
        );
        expect(outcome).toEqual({ _tag: "Redirect", location: new URL(`${origin}/login`) });
        expect(asked).toEqual(["x:initial"]);
        expect(control.calls).toEqual([]);
      }),
  );

  it.scopedLive(
    "a ClientOnly route runs its checks on the server, and a redirect is the answer",
    () =>
      Effect.gen(function* () {
        const control = makeControl({ app: "secret" });
        const server = yield* sideOf(control);
        const runs: Array<string> = [];
        const app = Route.client("app", guardedBranch(runs, "app"));
        const outcome = yield* documentOf([app, login], new URL(`${origin}/app`)).pipe(
          Effect.provideContext(server),
        );
        expect(outcome).toEqual({ _tag: "Redirect", location: new URL(`${origin}/login`) });
        expect(runs).toEqual(["app"]);
        expect(control.calls).toEqual([]);
      }),
  );

  it.scopedLive(
    "a route that passes its checks is settled once: the mounted router asks again for nothing",
    () =>
      Effect.gen(function* () {
        const server = yield* sideOf(makeControl({ "tenant-t1": "Acme", "post-1": "Hello" }));
        const runs: Array<string> = [];
        const counted = Route.ssr(
          "counted",
          Route.leaf(
            Route.segment("counted", {
              path: "/counted",
              params: Schema.Struct({}),
              before: () =>
                Effect.sync(() => {
                  runs.push("counted");
                  return Route.Continue;
                }),
            }),
            () => Effect.succeed(<p id="counted">counted</p>),
          ),
        );
        const html = yield* htmlIn(server, [counted], new URL(`${origin}/counted`));
        expect(html).toContain('<p id="counted" tabindex="-1">counted</p>');
        expect(runs).toEqual(["counted"]);
      }),
  );
});

/** A check that reads queries through the request cache, then continues. */
const readingCheck = (ids: ReadonlyArray<string>) => () =>
  Effect.gen(function* () {
    const cache = yield* QueryCache;
    yield* Effect.forEach(ids, (id) =>
      Effect.flatMap(cache.open(Label, { id }), (entry) =>
        entry.state.changes.pipe(
          Stream.filter((state) => state._tag !== "Loading"),
          Stream.take(1),
          Stream.runDrain,
        ),
      ),
    );
    return Route.Continue;
  });

const checkedTenant = Route.segment("checked", {
  path: "/checked/:tenant",
  params: TenantParams,
  data: ({ params }) => ({ tenant: Route.query(Label, { id: `tenant-${params.tenant}` }) }),
  // The same query the segment declares, and one only the check reads.
  before: ({ params }) => readingCheck([`tenant-${params.tenant}`, "gate"])(),
});

const checkedLeaf = Route.leaf(checkedTenant, (props) =>
  Effect.succeed(<p id="checked">{View.bind(props.data.tenant.state, labelOf)}</p>),
);

const checkedApps = [
  { mode: "SSR", app: Route.ssr("checked", checkedLeaf) },
  { mode: "AwaitAll", app: Route.awaitAll("checked", checkedLeaf) },
  { mode: "Streamed", app: Route.streamed("checked", checkedLeaf) },
];

/** The ids a document carries a value for: its seed, or its patch records. */
const valuesIn = (html: string): ReadonlyArray<string> => [
  ...seedIn(html).map((patch) => patch.id),
  ...recordsIn(html).flatMap((record) => {
    if (record._tag === "Patch") {
      return [record.id];
    }
    return [];
  }),
];

describe("one query cache per request (#28)", () => {
  for (const { mode, app } of checkedApps) {
    it.scopedLive(
      `a query the check and the page both read is read once and written once: ${mode}`,
      () =>
        Effect.gen(function* () {
          const control = makeControl({ "tenant-t1": "Acme", gate: "open" });
          const server = yield* sideOf(control);
          const html = yield* htmlIn(server, [app], new URL(`${origin}/checked/t1`));
          expect(html).toContain("Acme");
          expect(control.calls.toSorted()).toEqual(["gate", "tenant-t1"]);
          // The page's query is written once; the check's own query is not written.
          expect(valuesIn(html)).toEqual([idOf("tenant-t1")]);
        }),
    );
  }

  it.scopedLive("closing the request Scope releases the request cache and stops its reads", () =>
    Effect.gen(function* () {
      const control = makeControl({ held: "Held", late: "Late" }, ["held"]);
      const server = yield* sideOf(control);
      const captured: Array<QueryCache["Service"]> = [];
      const closed: Array<string> = [];
      const capturing = Route.streamed(
        "capturing",
        Route.leaf(
          Route.segment("capturing", {
            path: "/capturing",
            params: Schema.Struct({}),
            data: () => ({ held: Route.query(Label, { id: "held" }) }),
            // The check sees the request's cache, the one the drawing reads through.
            before: () =>
              Effect.gen(function* () {
                captured.push(yield* QueryCache);
                return Route.Continue;
              }),
          }),
          (props) =>
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() => Effect.sync(() => void closed.push("view")));
              return <p id="held">{View.bind(props.data.held.state, labelOf)}</p>;
            }),
        ),
      );
      const request = yield* Scope.make();
      const rendered = yield* Scope.provide(
        renderIn(server, [capturing], new URL(`${origin}/capturing`)),
        request,
      );
      expect(rendered.mode).toBe("Streamed");
      yield* eventually("the held read started", () => control.calls.includes("held"));
      expect([control.interrupted, closed]).toEqual([[], []]);
      yield* Scope.close(request, Exit.void);
      // The drawing closes, its read stops, and the cache itself is closed: it reads nothing more.
      yield* eventually("the held read was stopped", () => control.interrupted.includes("held"));
      expect(closed).toEqual(["view"]);
      const cache = yield* Option.match(Option.fromNullishOr(captured[0]), {
        onNone: () => Effect.die("the check saw no cache"),
        onSome: Effect.succeed,
      });
      yield* Effect.exit(
        Effect.scoped(
          Effect.andThen(cache.open(Label, { id: "late" }), Effect.sleep("50 millis")),
        ).pipe(Effect.provideContext(server)),
      );
      expect(control.calls).toEqual(["held"]);
    }),
  );
});

describe("the time limit bounds the whole preparation", () => {
  it.scopedLive("a check that never answers times out at the limit, and is interrupted", () =>
    Effect.gen(function* () {
      const server = yield* sideOf(makeControl({}));
      const interrupted: Array<string> = [];
      const failure = yield* Effect.flip(
        documentOf([stuck(interrupted)], new URL(`${origin}/stuck`), Effect.void).pipe(
          Effect.provideContext(server),
        ),
      );
      expect(failure).toEqual(DocumentTimedOut.make({ phase: "settle" }));
      expect(interrupted).toEqual(["check"]);
    }),
  );

  for (const { mode, app } of draftingApps) {
    it.scopedLive(
      `an actor snapshot that never answers times out at the limit, and the render closes: ${mode}`,
      () =>
        Effect.gen(function* () {
          const events: Array<string> = [];
          const control = makeControl({ notes: "n" }, ["notes"]);
          const server = stuckSnapshots(yield* sideOf(control), events);
          const limit = yield* Deferred.make<void>();
          const rendering = yield* Effect.forkChild(
            Effect.flip(
              documentOf([app], new URL(`${origin}/drafting`), Deferred.await(limit)).pipe(
                Effect.provideContext(server),
              ),
            ),
          );
          yield* eventually(
            "both reads started",
            () => events.includes("snapshot started") && control.calls.includes("notes"),
          );
          yield* Deferred.succeed(limit, void 0);
          expect(yield* Fiber.join(rendering)).toEqual(DocumentTimedOut.make({ phase: "draw" }));
          // Nothing the render started is left running: the snapshot read, and
          // the query read in the render's own cache, were both interrupted.
          expect(events).toEqual(["snapshot started", "snapshot interrupted"]);
          expect(control.interrupted).toEqual(["notes"]);
        }),
    );
  }
});

// ---------------------------------------------------------------------------
// The rendering mode is a constructor (#18 §6)
// ---------------------------------------------------------------------------

describe("a route's rendering mode is a constructor, not a field (#18 §6)", () => {
  it.scopedLive("each mode is its own constructor, and no route value carries a mode", () =>
    Effect.gen(function* () {
      const server = yield* sideOf(makeControl({ "tenant-t1": "Acme", "post-1": "Hello" }));
      const Blank = () => Effect.succeed(<p>flat</p>);
      const flat = Route.ssr(
        "flat",
        Route.leaf(Route.segment("flat", { path: "/flat", params: Schema.Struct({}) }), Blank),
      );
      const modes = yield* Effect.forEach([clientApp, ssrApp, streamedApp, awaitApp], (route) =>
        Effect.map(renderIn(server, [route]), (rendered) => rendered.mode),
      );
      expect(modes).toEqual(["ClientOnly", "SSR", "Streamed", "AwaitAll"]);
      expect((yield* renderIn(server, [flat], new URL(`${origin}/flat`))).mode).toBe("SSR");
      for (const route of [clientApp, ssrApp, streamedApp, awaitApp, flat]) {
        expect(Object.keys(route)).not.toContain("mode");
      }
      // @ts-expect-error No route value carries a mode field.
      void ssrApp.mode;
      // @ts-expect-error A one-leaf route carries none either.
      void flat.mode;
      // @ts-expect-error A segment has no mode field: the constructor is the mode.
      Route.segment("moded", { path: "/moded", params: Schema.Struct({}), mode: "SSR" });
    }),
  );
});

/** A one-leaf route of `Moving`, rendered in `mode`: its records move inside every catch-up. */
const movingRoute = (mode: "SSR" | "Streamed" | "AwaitAll", mover: Mover) => {
  const definition = Route.leaf(
    Route.segment("moving", { path: "/moving", params: Schema.Struct({}) }),
    () => Moving({ mover }),
  );
  if (mode === "SSR") {
    return Route.ssr("moving", definition);
  }
  if (mode === "Streamed") {
    return Route.streamed("moving", definition);
  }
  return Route.awaitAll("moving", definition);
};

describe("a drawing whose seed never agrees with it by the limit (review round 2)", () => {
  it.scopedLive(
    'fails DocumentTimedOut { phase: "agree" } when a Ready value keeps moving; a Loading one cannot move',
    () =>
      Effect.gen(function* () {
        const server = yield* sideOf(makeControl({ a: "Alpha" }, ["held"]));
        const modes: ReadonlyArray<"SSR" | "Streamed" | "AwaitAll"> = [
          "SSR",
          "Streamed",
          "AwaitAll",
        ];
        for (const mode of modes) {
          // SSR and Streamed write once their first drawing agrees, so their
          // moves run from the start. AwaitAll waits on `held`: its moves
          // start at the limit, in the final pass.
          const mover: Mover = { on: mode !== "AwaitAll", moves: 0 };
          const outcome = yield* Effect.exit(
            documentOf(
              [movingRoute(mode, mover)],
              new URL(`${origin}/moving`),
              Effect.andThen(
                Effect.sleep("30 millis"),
                Effect.sync(() => void (mover.on = true)),
              ),
            ).pipe(Effect.provideContext(server)),
          );
          expect(mover.moves).toBeGreaterThan(0);
          // SSR and Streamed draw while `a` is still Loading. An override
          // derives from the entry's own Ready value (#19), so it has
          // nothing to move: the moves write nothing and the drawing agrees.
          // AwaitAll's moves start once `a` is Ready, and never agree.
          if (mode === "AwaitAll") {
            expect({ mode, outcome }).toEqual({
              mode,
              outcome: Exit.fail(DocumentTimedOut.make({ phase: "agree" })),
            });
          } else {
            expect({ mode, rendered: Exit.isSuccess(outcome) }).toEqual({ mode, rendered: true });
          }
        }
      }),
    10_000,
  );
});

// ---------------------------------------------------------------------------
// Inheritance, nesting, and release (#18 §2.2, §3.2, §4.3)
// ---------------------------------------------------------------------------

const orgSegment = Route.segment("org", {
  path: "/orgs/:org",
  params: Schema.Struct({ org: Schema.String }),
  data: ({ params }) => ({ org: Route.query(Label, { id: `org-${params.org}` }) }),
});
const teamSegment = Route.child(orgSegment, "team", {
  path: "teams/:team",
  params: Schema.Struct({ org: Schema.String, team: Schema.String }),
});
const memberSegment = Route.child(teamSegment, "member", {
  path: "members/:member",
  params: Schema.Struct({ org: Schema.String, team: Schema.String, member: Schema.String }),
});

const orgApp = Route.ssr(
  "org-app",
  Route.layout(
    orgSegment,
    [
      Route.layout(
        teamSegment,
        [
          Route.leaf(memberSegment, (props) =>
            Effect.succeed(
              <p id="member">
                {View.bind(
                  props.params,
                  (params) => `${params.org}/${params.team}/${params.member}`,
                )}
                {View.bind(props.data.org.state, labelOf)}
              </p>,
            ),
          ),
        ],
        (props) =>
          Effect.map(props.outlet, (outlet) => (
            <div id="team">
              {View.bind(props.data.org.state, labelOf)}
              {outlet}
            </div>
          )),
      ),
    ],
    (props) =>
      Effect.map(props.outlet, (outlet) => (
        <main id="org">
          {View.bind(props.data.org.state, labelOf)}
          {outlet}
        </main>
      )),
  ),
);

const memberUrl = `${origin}/orgs/o1/teams/t2/members/m3`;

describe("nesting and inheritance (#18 §2.2, §3.2)", () => {
  it.scopedLive(
    "a three-deep branch matches one URL, yields every ancestor's params, and reads the layout's query once",
    () =>
      Effect.gen(function* () {
        const serverControl = makeControl({ "org-o1": "Org One" });
        const server = yield* sideOf(serverControl);
        const html = yield* htmlIn(server, [orgApp], new URL(memberUrl));
        // The leaf is the page: the router makes its root focusable (#31).
        expect(html).toContain(
          '<main id="org">Org One<div id="team">Org One<p id="member" tabindex="-1">o1/t2/m3<!---->Org One</p></div></main>',
        );
        expect(serverControl.calls).toEqual(["org-o1"]);
        expect(seedIn(html).map((patch) => patch.id)).toEqual([idOf("org-o1")]);

        // On the client too: three views read the inherited binding, one entry.
        const clientControl = makeControl({ "org-o1": "Org One" });
        const client = yield* sideOf(clientControl);
        const root = document.createElement("main");
        yield* Effect.gen(function* () {
          yield* mountRouter({
            landing: NavigationBehavior.Restore,
            traversalReadLimit: "3 seconds",
            routes: [orgApp],
            notFound: NotFound,
            host: Dom.host,
            root,
          }).pipe(Effect.provideService(Location, yield* locationAt(memberUrl)));
          yield* eventuallyEffect(
            "every view shows the org",
            Effect.map(View.flush, () => root.textContent === "Org OneOrg Oneo1/t2/m3Org One"),
          );
          expect(clientControl.calls).toEqual(["org-o1"]);
          expect(yield* activeIds).toEqual(["org-o1"]);
        }).pipe(Effect.provideContext(client));
      }),
  );

  it.live("a parent that ends in a tail cannot have children", () =>
    Effect.sync(() => {
      const docs = Route.segment("docs", {
        path: "/docs/:rest*",
        params: Schema.Struct({ rest: Schema.Array(Schema.String) }),
      });
      const page = Route.child(docs, "page", {
        path: "page",
        params: Schema.Struct({ rest: Schema.Array(Schema.String) }),
      });
      expect(() =>
        Route.layout(docs, [Route.leaf(page, () => Effect.succeed(<p />))], (props) =>
          Effect.map(props.outlet, (outlet) => <div>{outlet}</div>),
        ),
      ).toThrow(expect.objectContaining({ reason: "a layout cannot end in a tail" }));
    }),
  );
});

// ---------------------------------------------------------------------------
// Release on exit (#18 §4.3)
// ---------------------------------------------------------------------------

const listsSegment = Route.segment("lists", {
  path: "/lists",
  params: Schema.Struct({}),
  data: () => ({ shell: Route.query(Label, { id: "shared" }) }),
});
const listSegment = Route.child(listsSegment, "list", {
  path: ":list",
  params: Schema.Struct({ list: Schema.String }),
  // The same key the layout declares, under another name, and one of its own.
  data: ({ params }) => ({
    mine: Route.query(Label, { id: "shared" }),
    counts: Route.query(Label, { id: `counts-${params.list}` }),
  }),
});

const releaseApp = (closed: Array<string>) =>
  Route.client(
    "lists",
    Route.layout(
      listsSegment,
      [
        Route.leaf(listSegment, (props) =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() => Effect.sync(() => void closed.push("list view")));
            return <p id="list">{View.bind(props.data.counts.state, labelOf)}</p>;
          }),
        ),
      ],
      (props) => Effect.map(props.outlet, (outlet) => <section>{outlet}</section>),
    ),
  );

const scratch = Route.client(
  "scratch",
  Route.leaf(Route.segment("scratch", { path: "/scratch", params: Schema.Struct({}) }), () =>
    Effect.succeed(<p id="scratch">scratch</p>),
  ),
);

describe("an exited segment releases its scope and its unshared keys (#18 §4.3)", () => {
  it.scopedLive("the leaf exits and the shared key stays; the layout exits and it goes", () =>
    Effect.gen(function* () {
      const control = makeControl({ shared: "Shared", "counts-inbox": "3" });
      const client = yield* sideOf(control);
      const closed: Array<string> = [];
      const root = document.createElement("main");
      yield* Effect.gen(function* () {
        const router = yield* mountRouter({
          landing: NavigationBehavior.Restore,
          traversalReadLimit: "3 seconds",
          routes: [releaseApp(closed), scratch],
          notFound: NotFound,
          host: Dom.host,
          root,
        }).pipe(Effect.provideService(Location, yield* locationAt(`${origin}/lists/inbox`)));
        yield* eventuallyEffect(
          "the counts",
          Effect.map(View.flush, () => root.textContent === "3"),
        );
        expect(yield* activeIds).toEqual(["counts-inbox", "shared"]);

        // The leaf exits: its view scope closes and only its unshared key goes.
        yield* router.navigate("/lists");
        expect(closed).toEqual(["list view"]);
        expect(yield* activeIds).toEqual(["shared"]);
        expect(control.calls.filter((id) => id === "shared")).toHaveLength(1);

        // The layout exits: the key no surviving segment declares goes too.
        yield* router.navigate("/scratch");
        expect(yield* activeIds).toEqual([]);
      }).pipe(Effect.provideContext(client));
    }),
  );
});

// ---------------------------------------------------------------------------
// The request's principal (#85)
// ---------------------------------------------------------------------------

const Secret = query("RouteSecret", {
  version: 1,
  args: Schema.Struct({ id: Schema.String }),
  result: Schema.Struct({ label: Schema.String }),
  policy: "member",
  depends: [],
});

const secretLabel = "classified-label";

const guarded = Layer.build(
  QueryTest.layer({
    queries: [implementQuery(Secret, { run: () => Effect.succeed({ label: secretLabel }) })],
  }).pipe(
    Layer.provide(Layer.succeed(Policies, Policies.of({ member: Policy.authenticated }))),
    Layer.orDie,
  ),
);

const secretApp = Route.ssr(
  "secret",
  Route.leaf(
    Route.segment("secret", {
      path: "/secret",
      params: Schema.Struct({}),
      data: () => ({ secret: Route.query(Secret, { id: "a" }) }),
    }),
    (props) => Effect.succeed(<p id="secret">{View.bind(props.data.secret.state, labelOf)}</p>),
  ),
);

const secretOutcomes = (html: string): ReadonlyArray<string> =>
  seedIn(html).map((patch) => {
    if (patch.outcome._tag === "Error") {
      return `Error ${patch.outcome.error._tag}`;
    }
    return `Value ${patch.outcome.value}`;
  });

describe("declared data is read under the request's principal (#85)", () => {
  it.scoped(
    "an anonymous SSR render of a protected route query seeds the refusal, never the value",
    () =>
      Effect.gen(function* () {
        const server = yield* guarded;
        const html = yield* htmlIn(server, [secretApp], new URL(`${origin}/secret`));
        expect(secretOutcomes(html)).toEqual(["Error Unauthorized"]);
        expect(html).toContain('<p id="secret" tabindex="-1">Failed</p>');
        expect(html).not.toContain(secretLabel);
      }),
  );

  it.scoped("the same render under a signed-in principal seeds the value", () =>
    Effect.gen(function* () {
      const server = yield* guarded;
      const html = yield* htmlIn(server, [secretApp], new URL(`${origin}/secret`)).pipe(
        Effect.provideService(
          CurrentPrincipal,
          Authenticated.make({ subject: "alice", claims: {} }),
        ),
      );
      expect(secretOutcomes(html)).toEqual([`Value {"label":"${secretLabel}"}`]);
      expect(html).toContain(`<p id="secret" tabindex="-1">${secretLabel}</p>`);
    }),
  );
});
