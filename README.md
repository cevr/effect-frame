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

The private `tooling/checks` workspace checks Effect v4 schema codecs, scope cleanup, and browser bundling. It also holds the server/client build rule. It is not a framework package.

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
`view/jsx-dev-runtime`, `view/opentui`, and `router`.

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
rendering mode for a whole tree; `Route.client` is the one mode today.

```tsx
import { Link, Route, link, mount } from "effect-frame/router";
import { Loading, View } from "effect-frame/view";
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
        const body = yield* Loading({ fallback: <p>loading</p>, children: props.outlet });
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
- `Route.client(name, root)` takes a branch of a root segment only.
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
import { Dom, Html, mount, render } from "effect-frame/view";
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
  yield* mount(App, props, hydration.host, root);
  yield* render;
  const report = yield* hydration.finish; // report.resolvedAhead
  yield* resumed.hydrated; // seeds no view took are dropped now
});
```

- `Html.renderToStream(view, props, document, options)` renders over its
  own query cache and returns `Stream<string>`. The first chunk holds the
  shell, `tail`, a `Placeholder` for each declared query, the patches
  already due, and `bootstrap`. Then one `Patch` per query as it settles,
  then `Closed`.
- `Html.renderAwaitAll(view, props, document, options)` keeps one drawing
  live until every declared query has settled and no `Loading` boundary
  shows its fallback, then writes one document with a seed script and no
  record channel. `Html.renderToString` is unchanged.
- `options.closeWhen` is the time limit, and both calls require it
  (`Effect.never` waits for ever). A query still open at the limit has no
  value in the document, and the client reads it again.
- `Html.Document`, `Html.streamRecord(record)`.
- `Dom.readRecords` reads the records present and follows the rest. It
  also reads an `AwaitAll` seed. `Streaming.resume(records)` puts them into
  the cache before `mount` and returns `Resumed`: `closed` completes once
  the channel ended and every live entry shows its value or failure;
  `hydrated` drops the seeds no view took.
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
  `of`, `all`, `any`, `byAction`), `Policies`, `PolicyNamesMissing`,
  `MissingPolicy`, and the types `PolicyTable`, `Subject`, `Action`.
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
