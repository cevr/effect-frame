# Effect Frame

An Effect-native full-stack framework in design and implementation.

The [first-release map](https://github.com/cevr/effect-frame/issues/1) is the source of truth for scope and decisions. GitHub child issues hold the open questions.

## First release

- One explicit actor interface for simple state and state machines.
- Local and remote actor hosts.
- Declarative JSX for browser and OpenTUI clients.
- Server rendering and hydration.
- Real celld persistence for state, accepted commands, command results, and resumable machine work.
- Alchemy as the infrastructure interface.

These are release requirements. They are not implemented features.

## Current state

The workspace contains the project tools and their compatibility probes. It does not yet contain a framework runtime. The actor API, renderer adapter, and recovery model remain open decisions on the map.

The private `tooling/checks` workspace holds the build rules the gate runs: the server/client boundary, the published declarations and subpaths, and the Bun version pin. It is not a framework package.

## Commands

```sh
bun install
bun run gate
```

The gate runs strict lint, format checks, patched TypeScript checks, a browser build, and tests. Effect runtime versions are pinned in the root catalog. Type checks use the patched `tsc` binary.

No cloud deployment or npm publication is configured.

## Server and client files

A file that may run only on a server is named `*.server.ts` or `*.server.tsx`. A file with no suffix runs in both places. A browser entry may not reach a server module through any chain of imports, and it imports `effect-frame/actor/client`, not `effect-frame/actor`. `bun run boundary` checks every browser entry in `tooling/checks/src/browser-entries.ts` and fails the gate with the chain of files that reached the server module. See [the boundary rule](docs/design/boundary.md).

## Browser inspection

The browser-safe `effect-frame/frame` entry exposes `Frame.layer` and
`Frame.inspect`. Build one Frame layer for each application root. Keep it in
the same layer graph as the query cache so the cache registers its entries in
that root.

```ts
import * as Frame from "effect-frame/frame";
import { Layer } from "effect";
import { queryCacheLayer } from "effect-frame/actor/client";

const frameLayer = Frame.layer({ name: "notes" });
const appLayer = Layer.merge(queryCacheLayer.pipe(Layer.provideMerge(frameLayer)), transportLayer);
```

`Layer.provideMerge` gives the cache the Frame registry and keeps the Frame
service available to the mounted application. A test host uses the same
composition with `QueryTest.layer`:

```ts
const testLayer = QueryTest.layer({ queries: [NotesQueryLive] }).pipe(
  Layer.provideMerge(Frame.layer({ name: "notes-test" })),
);
```

Keep the cache layer alive for the full mounted application scope. Providing a
cache only around a short setup effect closes its `RcMap` when that effect
returns, even if an outer view scope still holds a query consumer.

### Live inspection

The browser-safe `effect-frame/inspection` subpath exports `Protocol` (the
versioned wire contract) and `attachGateway`. A development entry calls
`attachGateway` to connect its root to a loopback gateway. A production entry imports nothing
from this subpath and carries none of it. The gateway and the reader are the
`effect-frame` executable in `packages/inspect` (`effect-frame gateway`,
`effect-frame roots`, `effect-frame inspect`), the only Bun piece. See
[the inspection gateway design](docs/design/inspection-gateway.md).

Public subpaths of `effect-frame`: `actor`, `actor/client`, `actor/testing`,
`frame`, `inspection`, `view`, `view/testing`, `view/jsx-runtime`,
`view/jsx-dev-runtime`, `view/driven`, `view/opentui`, `router`, and
`router/prerender`. The test harnesses are subpaths of their own:
`QueryTest` from `actor/testing` and `ViewTest` from `view/testing`.

## Optimistic commands

A remote reference shows a command before the server commits it when the
client can import the actor's behavior and that behavior has `predict`.
`Behavior.value` and `Behavior.reducer` have it. `Behavior.machine` does not.

```ts
import { Effect, Option } from "effect";
import { Behavior } from "effect-frame/actor";
import { ref } from "effect-frame/actor/client";

const notes = Behavior.reducer({ initial: [], reduce: addNote });

const program = Effect.gen(function* () {
  const list = yield* ref(Notes, key, { resume: Option.none(), behavior: notes });
  const handle = yield* list.send({ _tag: "Add", text: "hello" });
  // { revision: { _tag: "Provisional", base: 0, depth: 1 }, state }
  const shown = yield* list.displayed.get;
  // The committed revision only.
  const committed = yield* list.applied.get;
  return { handle, shown, committed };
});
```

- `displayed` is what the reference shows. `state` is `displayed.state`.
- `applied` stays committed. Use it for resume data.
- Only a fresh command ID predicts. A supplied ID waits for its receipt.
- A committed state replaces the prediction. A rejected command leaves the
  pending log, and the rest replays over the same base. An `Uncertain`
  command keeps its prediction until a retry settles it.
- A query `override` shows a value as stale until any authoritative value
  replaces it: a command reply's refresh, a `refresh`, or a new declaration.

See [the optimistic send design](docs/design/optimistic.md).

## Routing

`effect-frame/router` exports one route model on the `Route` namespace. A
segment is an address. A branch is a segment with its view. A mount picks the
rendering mode for a whole tree: `Route.client`, `Route.ssr`,
`Route.streamed`, or `Route.awaitAll`.

```tsx
import { Link, Route, link, mount } from "effect-frame/router";
import { View } from "effect-frame/view";
import { Effect, Schema } from "effect";

// A flat route is the one-leaf shorthand of the same model.
const Login = Route.client("login", {
  path: "/login",
  params: Schema.Struct({}),
  search: Route.search(Schema.Struct({ next: Schema.String.pipe(Route.withDefault("/")) })),
  view: (props) => Effect.succeed(<p>{View.bind(props.search, (s) => s.next)}</p>),
});

const tenant = Route.segment("tenant", {
  path: "/app/:tenant",
  params: Schema.Struct({ tenant: Schema.String }),
  data: ({ params }) => ({ info: Route.query(TenantInfo, { tenant: params.tenant }) }),
  before: ({ params, url }) =>
    Effect.gen(function* () {
      if (yield* isSignedIn(params.tenant)) {
        return Route.Continue;
      }
      return Route.redirect(Route.target(Login, {}, { next: `${url.pathname}${url.search}` }));
    }),
});

const post = Route.child(tenant, "post", {
  path: "posts/:postId",
  params: Schema.Struct({ tenant: Schema.String, postId: Schema.String }),
});

const App = Route.client(
  "app",
  Route.layout(
    tenant,
    [
      Route.leaf(
        post,
        View.lazy(() => import("./post-view.js")),
        {
          errored: (failure) => <p>{View.bind(failure, (f) => f._tag)}</p>,
          pending: { fallback: <p>opening</p>, after: "100 millis", atLeast: "300 millis" },
        },
      ),
    ],
    (props) =>
      Effect.gen(function* () {
        const first = yield* link(post, { tenant: "t1", postId: "1" }, {});
        const body = yield* View.loading({ fallback: <p>loading</p>, content: props.outlet });
        return (
          <section>
            <Link link={first}>first post</Link>
            {body}
          </section>
        );
      }),
  ),
);

const program = Effect.gen(function* () {
  yield* mount({ routes: [App, Login], notFound, host, root });
});
```

- `before` runs parent first, before anything commits. It returns
  `Route.Continue` or `Route.redirect(Route.target(...))`.
- A view that can fail, and every `View.lazy` view, needs an `errored`
  handler. It receives a `Route.RouteFailure`.
- Every segment view gets `params`, `search`, `data`, `href`,
  `updateSearch`, and `replaceSearch`. A layout also gets `outlet`.
- `link` takes a flat route or a segment. `Link` draws `aria-current="page"`
  on the destination, and `aria-current="true"` on a segment the current URL
  continues below. Neither holds on not-found or on another route.
- `Route.client(name, root)` takes a branch of a root segment only, and so
  do `Route.ssr`, `Route.streamed`, and `Route.awaitAll`. A mode is the
  constructor; no route value carries a mode field.
- Leave checks and navigation receipts are not public yet (#56).

See [the public route design](docs/design/route-public.md).

### Scroll and focus

In the browser, provide `browserNavigation` as the `Location`. It uses the
Navigation API, and the History API where that is absent. `followLinks`
follows ordinary same-origin anchors.

```tsx
import {
  Location,
  NavigationBehavior,
  Route,
  browserNavigation,
  followLinks,
  mount,
} from "effect-frame/router";

const program = Effect.gen(function* () {
  const location = yield* browserNavigation;
  const router = yield* mount({ routes: [App, Login], notFound, host, root }).pipe(
    Effect.provideService(Location, location),
  );
  yield* followLinks(document, router);
});

// A tab strip that keeps the reader where they are.
Route.leaf(tab, TabView, { behavior: NavigationBehavior.Preserve });
```

- At shell commit (the new branch is in the document, fallbacks included),
  `NavigationBehavior.Restore`, the default, puts the viewport at the top, at
  the URL's fragment, or at the entry's saved position on Back and Forward.
  It then focuses the entering leaf's root, or the first `autofocus` element
  inside that leaf. It does not wait for queries.
- `NavigationBehavior.Preserve` leaves scroll and focus alone. Set it on a
  leaf (`Route.leaf(..., { behavior })`), on a flat route (`behavior` in
  `Route.client(name, { ... })`), or for the whole router
  (`mount({ ..., behavior })`). A layout takes no `behavior`: the destination
  leaf decides.
- A leaf's root element gets `tabindex="-1"`, unless the view wrote a tab
  index (either spelling) or the element is focusable already, such as a
  `<button>`.
  Focus uses `preventScroll`. A stayed leaf (a search or param change on the
  same leaf) keeps focus and the caret.
- The router holds no scroll position and never sets
  `history.scrollRestoration`. It adds no `aria-live` region.
- `followLinks` leaves a link that only changes the current page's fragment
  to the browser.

See [the navigation behavior design](docs/design/navigation-behavior.md).

### Server documents

`renderDocument` answers one request. It settles the request first: it
matches the URL and runs the matched route's checks, whatever the mode.
Then it renders with the settled tree's mode. It mounts the same router on
the HTML host, over its own query cache, at the request URL.

```ts
import { DocumentTimedOut, renderDocument } from "effect-frame/router";

// Run it in the request's Scope, and stream the body before that Scope closes.
const answer = renderDocument({
  routes: [App, Login],
  notFound,
  url: new URL(request.url),
  document: page, // an Html.Document
  closeWhen: Effect.sleep("10 seconds"),
}).pipe(
  Effect.provideService(CurrentPrincipal, principal),
  Effect.map((outcome) => {
    if (outcome._tag === "Redirect") {
      return seeOther(outcome.location); // 303
    }
    return respond(outcome.status, outcome.body); // 200, or 404 for not-found
  }),
  Effect.catchTag("DocumentTimedOut", () => Effect.succeed(gatewayTimeout())),
);
```

- A check that redirects is the answer, `{ _tag: "Redirect", location }`.
  The render does not follow it. A `Route.client` route runs its checks
  on the server too.
- `Rendered.route` is `{ _tag: "Matched", route }`, the route value, or
  `{ _tag: "NotFound" }`. `status` is 404 for not-found and 200 otherwise.
  A hand-written route and not-found render as `SSR`.
- `Route.ssr`: the server resolves every query the matched branch
  declares, in parallel, before any view draws. It draws once and writes
  one seed script. The client hydrates with no read.
- `Route.streamed`: the shell first, then one record per declared query
  (see "Streamed documents"). Put a `View.loading` boundary around what waits.
- `Route.awaitAll`: one document once every read settled.
- `Route.client`: the document with an empty mount element. The server
  reads nothing.
- `closeWhen` runs once. The checks, the declarations, and the first
  drawing must end before it completes, or `renderDocument` fails with
  `DocumentTimedOut { phase: "settle" | "draw" }` and closes what it
  opened. After the first drawing, `AwaitAll` writes what it has and
  `Streamed` writes `Closed`; the client reads what is still open. If the
  drawing and its seed still disagree at the limit (a query kept moving),
  no document is written: `DocumentTimedOut { phase: "agree" }`.
- Every read is checked under the `CurrentPrincipal` you provide, by the
  policy its query names. A refusal is seeded, never the value.
- The checks and the drawing read through one query cache, which the
  request Scope holds. A query both read is read once and written once; a
  query only a check read is not written into the document.

A route prints only what a URL carries both ways: a path segment is
well-formed text that is not empty and not `.` or `..`, and a search key or
value is well-formed text. `href` dies with `Route.UrlValueRejected` for
another value, and parse never yields one.

See [the route data design](docs/design/route-data.md).

### Prerendered pages

`Route.prerender` is a mode constructor that lists its inputs. A tree names
one `Route.inputs(segment, enumerate)` for each segment that adds a path
param. A child's function runs once for each parent, receives the parent's
params, and returns only its own.

```ts
const Posts = Route.prerender("posts", Route.layout(org, [Route.leaf(post, PostView)], OrgView), {
  inputs: [Route.inputs(org, listOrgs), Route.inputs(post, ({ org }) => listPosts(org))],
});
```

A segment that adds a param and names no inputs is refused where the tree
is constructed, with `PrerenderAncestorNotEnumerable` naming the segment
and the param. A layout that adds no param needs no inputs.

The build and the server are server-only, in `effect-frame/router/prerender`:

```ts
import * as Prerender from "effect-frame/router/prerender";

// The build: every input, through renderDocument's pipeline, in AwaitAll, as Anonymous.
const buildSite = Effect.gen(function* () {
  yield* Prerender.build({
    routes: [Posts, App],
    notFound,
    document: (page) => Effect.succeed(documentFor(page)),
    client: bundleText, // your browser bundle, written as client.js
    out: "dist/prerender",
    timeLimit: "10 seconds",
  });
});

// The server: a built page answers before the router runs. `load` holds the
// generation for the calling scope: run it in the scope the server lives in.
const handler = Effect.gen(function* () {
  const site = yield* Prerender.load("dist/prerender");
  return yield* Prerender.serve(site, routerHandler);
});
```

- Each page is written to `<href>/index.html` in a new generation under
  `dist/prerender/generations/`, at the URL its route's `href` prints,
  beside `client.js` and `manifest.json`. The build publishes the
  generation by renaming `current.json` over the old pointer, so a failed
  or crashed build leaves the previous generation serving. `load` holds
  the generation it read for its scope, so a running server keeps its
  files across any number of rebuilds; the first build after the server
  stops removes them.
- Publishing is safe against a process crash or interruption on POSIX file
  systems; it does not `fsync`, so it is not durable across power loss, and
  Windows replacement semantics are not claimed.
- One build writes one output: a second build fails with
  `PrerenderBuildLocked`. A lock file a hard crash left names itself in
  the error; remove it once no build runs.
- A query two pages read, or that an inputs Effect and a page read, is read
  once. An actor snapshot is read once too, and actors do not move while
  the build runs, so the page and its resume script show one revision.
- A query whose policy refuses `Anonymous` fails the build with
  `PrerenderUnauthorized`, and nothing is published.
- The build refuses what it could not serve as written: an href with a
  search part (`PrerenderSearchRejected`), two hrefs that differ only in
  case (`PrerenderPathCollision`), and a local link to a prerender route
  that no input built (`PrerenderBrokenLink`). `timeLimit` covers each
  page from `document(page)` on.
- A loaded site reads one generation. A built page answers with a strong
  `ETag` for the bytes it read, and a matching `If-None-Match` answers 304.
  HEAD answers as GET does, with no body. A page with no file renders
  through the router.
- A baked query value paints at once as `Ready { stale: true }` and is read
  once to confirm it. An actor island resumes from the revision the page
  baked: write its `resumeCodec` script in `document(page)`, as SSR does.

See [the prerender design](docs/design/prerender.md).

## Plain-form commands

A command form works with no JavaScript. The server renders a real
`<form method="post">`; the hydrated page sends the same message over the
actor transport.

```tsx
import { HttpServer } from "effect-frame/actor";
import { Form, Generated } from "effect-frame/actor/client";
import type { RemoteActorRef } from "effect-frame/actor/client";
import { View } from "effect-frame/view";
import { Effect, Option, Schema } from "effect";

// The render mints `id` with the command id. Decoding never mints it.
const Add = Schema.TaggedStruct("Add", {
  id: Generated.fromCommandId(Schema.String),
  text: Schema.String,
  pinned: Form.Checkbox, // absent is false
});

const Compose = (props: { readonly notes: RemoteActorRef<typeof Notes> }) =>
  Effect.gen(function* () {
    const add = yield* View.form({
      ref: props.notes,
      contract: Notes,
      key: { tenant: "demo", list: "inbox" },
      message: Add,
      typed: ["text", "pinned"],
      endpoint: "/actors",
      returnTo: "/",
    });
    return (
      <form onSubmit={add.submit}>
        <input name="text" />
        <input type="checkbox" name="pinned" />
        {add.issues.map((issue) => (
          <p>{issue.message}</p>
        ))}
      </form>
    );
  });

// Server: mount beside the JSON handler, at `/actors/form`.
const forms = HttpServer.form({
  contracts: [Notes],
  principal: HttpServer.anonymous,
  login: Option.none(),
  render: (path) => renderPage(path),
});
```

- `effect-frame/actor/client` exports `Generated` (`fromCommandId`,
  `freshId`, `send`, `Input`) and `Form` (`codec`, `Checkbox`,
  `FormContext`, `FormIssues`, `issuesOf`, `encodeKey`, and the field-map
  helpers). `Wire.paths.form` is `/form`.
- `View.form` returns `{ submit, issues, commandId }`. The runtime draws
  `method`, `action`, and the hidden `$command`, `$contract`, `$version`,
  `$key`, `$return`, `$form`, `_tag`, and generated inputs in every host.
- `HttpServer.form` answers 303 to `$return` on success, 200 with the page
  and its `FormIssues` on a validation failure, 504 with the same id on a
  lost reply, and 400 or 415 before any send. An `Unauthorized` anonymous
  post answers 303 to `login` with `next`; every other refusal is a 403
  with the page.
- `Generated.send(ref, contract, input)` sends from code. The input omits
  every generated field.
- A refused page must carry its issues to the client. On the server, embed
  `Form.encodeIssues` under `Form.issuesScriptId` when `FormContext` is
  present. On the client, read it with `Form.decodeIssues` and mount
  through `Form.provideIssues`.
- Each form posts `$form` (the member tag, or `name`). A refusal redraws
  only the form that posted it.
- `$return` must be printable ASCII, root-relative, and resolve to this
  origin. A `charset` other than UTF-8 is refused with 415.
- A field whose name has a segment that starts with `_` is never written
  back into a refused page. A multipart body is refused with 415.
- `HostEvent.form` carries the submitted fields on a DOM submit.
  `Prepared.post` carries a form's plain post.

See [the plain-form design](docs/design/plain-forms.md).

## Streamed documents

A page can send its shell at once and its query values as they settle.
Nothing in the document runs: each value is a JSON record that the client
reads and puts into its query cache.

```tsx
import { Streaming } from "effect-frame/actor/client";
import { Dom, Html, View } from "effect-frame/view";
import { Effect, Stream } from "effect";

// Server: the shell and its fallbacks first, then one patch per query.
const page: Html.Document = {
  head: '<!doctype html><html><head><meta charset="utf-8"></head><body><main id="app">',
  tail: "</main>", // resume payloads and form issues go here
  bootstrap: '<script type="module" src="/client.js"></script>',
  end: "</body></html>",
};
const body = Html.renderToStream(App, props, page, { closeWhen: Effect.sleep("10 seconds") });
new Response(Stream.toReadableStreamWith(Stream.encodeText(body), context), { headers });

// Client: read the records, seed the cache, hydrate.
const start = Effect.gen(function* () {
  const resumed = yield* Streaming.resume(yield* Dom.readRecords);
  const hydration = Dom.hydrate(root);
  yield* View.mount(App, props, hydration.host, root);
  yield* View.flush;
  const report = yield* hydration.finish; // report.resolvedAhead
  yield* resumed.hydrated; // seeds no view took are dropped, seeded reads start
});
```

- `Html.renderToStream(view, props, document, options)` renders over its
  own query cache and returns `Stream<string>`. The first chunk holds the
  shell, `tail`, a `Placeholder` for each declared query, the patches
  already due, and `bootstrap`. Then one `Patch` per query as it settles,
  then `Closed`.
- `Html.renderAwaitAll(view, props, document, options)` keeps one drawing
  live until every declared query has settled and no `View.loading` boundary
  shows its fallback, then writes one document with a seed script and no
  record channel. `Html.renderToString` is unchanged.
- `options.closeWhen` is the time limit, and both calls require it
  (`Effect.never` waits for ever). A query still open at the limit has no
  value in the document, and the client reads it again. A drawing whose
  records still move at the limit is never written beside a seed it does
  not show: the call fails with `Html.RecordsUnsettled`.
- `Html.Document`, `Html.streamRecord(record)`.
- `Dom.readRecords` reads the records present and follows the rest. It
  also reads an `AwaitAll` seed. `Streaming.resume(records)` puts them into
  the cache before `mount` and returns `Resumed`: `closed` completes once
  the channel ended and every live entry shows its value or failure;
  `hydrated` drops the seeds no view took, and starts the reads that the
  seeds call for (a stale value, a failure that is not final). Until then
  a seeded entry shows what the server drew, so run it after
  `hydration.finish`.
- `HydrationReport.resolvedAhead` counts boundaries that the client drew
  with the other branch, because their query settled before hydration.
  That is not a mismatch.
- A query still open when the document ends fails with `StreamEnded` and
  reads again over `POST /query`. `StreamEnded` is in `QueryFailure`. A
  value in the document never replaces a newer read the client made. Only
  `QueryFailed` in the document is final; any other failure reads again.
- `effect-frame/actor/client` exports `Streaming`: `recordId`, `Placeholder`,
  `Patch`, `Closed`, `StreamRecord`, `RecordJson`, `SeedJson`,
  `containerId`, `recordClass`, `seedId`, `shell`, `declared`,
  `awaitDeclared`, `settledPatches`, `resume`, `DocumentRecords`, `Resumed`,
  `ShellRecords`, `ShellOptions`.
- `Host` has three optional capabilities, `boundaryMarks`, `adoptBoundary`
  and `setupStarted`. A custom host may omit them. The HTML host writes
  `<!--frame-boundary:…-->` marks around each readiness boundary.

See [the streaming design](docs/design/streaming.md).

## Server-driven views

A view can run on the server and draw into a browser over a stream of host
operations. The server mounts the view on a recording host; the client
replays the operations and sends events back. A connection starts with the
drive actor's snapshot, never with an operation log, and a reconnect does
the same at constant cost.

```tsx
import * as Driven from "effect-frame/view/driven"; // server only
import { Dom, Remote } from "effect-frame/view";

// Server: one session per connection.
const serve = Effect.gen(function* () {
  const session = yield* Driven.session(RoomView, props, { contract: Room, key });
  send(session.resume);
  yield* Effect.forkScoped(Stream.runForEach(received, session.fire)); // events back
  yield* Stream.runForEach(session.patches, (patch) => send(encode(patch)));
});

// Client: draw from the snapshot, then apply each patch.
const client = Remote.client(
  RoomView,
  props,
  { contract: Room, key },
  { host: Dom.host, root, send },
);
const follow = Effect.gen(function* () {
  yield* client.resume(payload); // the first connect and every reconnect
  yield* client.apply(patch); // ForeignSession, StaleClient, or UnknownNode: applies nothing
});
```

- `Driven.session(view, props, drive, { limit })` mounts the view on a fresh
  `Remote.recorder()` at the drive's latest snapshot. `resume` is the
  session id, the snapshot, and a digest of the drawing, as one JSON
  string. `patches` streams every later change from position 0, each
  naming the session, with the writes that would not change the client's
  tree left out. A client that falls more than `limit` operations behind
  (default `Driven.defaultLimit`) ends the stream with `Backlogged` and must
  resume. `retained` shows what the session holds; after its scope closes,
  that is nothing.
- `Remote.client(view, props, drive, { host, root, send })` works with any
  host. `resume(payload)` removes what the client drew and draws the view
  from the snapshot on its own recorder, which gives the ids the server's
  recorder gave, and fails `Diverged` if its drawing is not the server's.
  `apply(patch)` refuses a patch from another session (`ForeignSession`),
  one whose `from` is not the position it holds (`StaleClient`), or one
  that names an id it does not hold (`UnknownNode`), and changes nothing.
- `Remote.draw(view, props, drive, payload)` returns the operations a
  drawing from a snapshot makes. Two drawings at one snapshot are equal.
- `Remote.Op`, `Remote.Patch`, `Remote.RemoteEvent`, `Remote.PatchJson`,
  `Remote.RemoteEventJson`, `Remote.StaleClient`, `Remote.UnknownNode`,
  `Remote.recorder`, `Remote.root`, `Remote.Drive`, `Remote.payloadOf`.
- A driven view draws from its one drive actor, on both sides; any other
  read fails `Unreachable`. Its drawing must depend on its props and that
  snapshot only. An event carries its value only, and reaches only a
  listener a patch has delivered. Patches are trusted server output. The
  socket is the application's.
- A host may implement `forget(node)`: the runtime calls it when the owner
  that drew the node ends. The recorder sends it as a `Forget` op, so a
  long session holds only live nodes.

See [the op wire design](docs/design/op-wire.md).

## Authorization

Every contract and every query names a policy. The root host requires a
policy table, and there is no default table and no default rule.

```ts
import { ActorHost, HttpServer, Policies, Policy } from "effect-frame/actor";
import type { Subject } from "effect-frame/actor";
import { Principal, contract, query } from "effect-frame/actor/client";
import { Effect, Layer, Option, Schema } from "effect";

const Ledger = contract("Ledger", {
  version: 1,
  policy: "tenantMember",
  key: Schema.Struct({ tenant: Schema.String, id: Schema.String }),
  snapshot: Schema.Finite,
  message: Entry,
});

const Totals = query("Totals", {
  args: Schema.Struct({ tenant: Schema.String }),
  result: Schema.Finite,
  policy: "tenantMember",
});

// One rule for actors and queries. `Policy.of` refuses Anonymous first.
const tenantMember = Policy.of(
  (subject: Subject) => tenantOf(subject), // Option<string>
  (who, tenant) => Effect.succeed(tenantsOf(who.claims).includes(tenant)),
);

// Allow-all exists only by name.
const policies = Layer.succeed(Policies, Policies.of({ tenantMember, public: Policy.allowAll }));

const host = ActorHost.layer({ implementations, queries }).pipe(Layer.provide(policies));

// The principal is derived once per request, and followed on a connection.
// One subscription per session, shared by every connection on it.
const principal = Effect.map(
  HttpServer.shareSessions({
    read: (sessionId: string) => readSession(sessionId), // Effect<Principal>
    follow: (sessionId: string) => followSession(sessionId), // Stream<Principal>, current first
  }),
  (sessions): HttpServer.DerivePrincipal =>
    (request) =>
      Effect.succeed(
        Option.match(sessionIdOf(request), { onNone: () => Principal.anonymous, onSome: sessions }),
      ),
);
const handler = Effect.flatMap(principal, (derive) => HttpServer.make({ principal: derive }));
```

- `effect-frame/actor` exports `Policy` (`allowAll`, `authenticated`,
  `of`, `all`, `any`, `byAction`), `Policies`, `PolicyNamesMissing`, and
  the types `PolicyTable`, `Subject`, `Action`.
- `effect-frame/actor/client` exports `Principal` (`anonymous`,
  `constant`, `equals`, `isAuthenticated`), `Anonymous`, `Authenticated`,
  `Claims`, `CurrentPrincipal`, and the type `PrincipalSource`. The client
  entry holds no policy table.
- A host whose table lacks a declared name fails to build with
  `PolicyNamesMissing`, which lists every miss.
- `HttpServer.make({ principal })` takes a derivation
  `(request) => Effect<PrincipalSource>`. `HttpServer.anonymous` is the
  derivation for a host with no sessions.
- A changes stream reads its principal from the first value of one
  subscription to the source, and watches the rest of that same
  subscription. It ends with `Unauthorized` on the first value that is not
  equal to the connected one. The HTTP client never retries `Unauthorized`.
- `HttpServer.shareSessions({ read, follow })` keeps one subscription per
  session key, shared by every connection on it and released when the last
  one closes.
- `HttpServer.toWebHandler(layer, { principal })` and celld's
  `defineFrameHost` run the derivation in their own runtime, so a
  derivation may need `ActorTransport` and any service the layer provides.
- `QueryCache` has `principalChanged`: every live entry drops its value and
  reads again. A reference whose change stream ends with `Unauthorized`
  calls it, so a client never shows a value read under a principal that is
  gone. Call it yourself after a sign-in or sign-out in a long-lived client.
- `ActorHost.layer` also provides `ActorHost.Recovery`. Its `wake(address)`
  opens an actor with no caller, so a durable host drains admitted commands
  after a restart. It checks no policy, returns no state, and is never on
  the wire.

See [the authorization design](docs/design/authorization.md).

## Planning

Read [the GitHub tracker guide](docs/wayfinder/github.md) before changing the map. Read source findings in `docs/research/` when they are available.
