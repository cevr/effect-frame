# effect-frame

Actors, queries, views and a router on Effect. One process holds the actors;
pages read them through queries and actor references, draw with typed JSX,
and move with a router that owns its data.

This README is the reference for writing an app. Every TypeScript block
below is a region of a file in [`examples/`](examples), which the gate
typechecks, lints and tests (`tests/examples/`). The words are defined in
[the glossary](../../CONTEXT.md).

## Rules an app follows

- A view is a function of its props that returns an Effect:
  `(props) => Effect.gen(function* () { ... })`. It runs once per mounted
  identity. A change moves only what binds the source that changed.
- A view names the props it is given, even a page that reads none: a leaf
  types them `Route.PropsOf<typeof segment>`, a layout
  `Route.LayoutPropsOf<typeof segment, ChildR>`. The Effect language
  service's `lazyEffect` rule refuses an exported view with no parameter,
  `() => Effect.gen(...)`.
- A child view is a function the parent yields, never a JSX tag. A
  PascalCase JSX tag is one of `For`, `Show`, `Match`, `Portal` or `Await`.
- A contract, a query, and a behavior are browser safe. The server half of
  an actor or query (`implementTransparent`, `implementQuery`), the host,
  the policy table, and the HTTP handler live in `*.server.ts` files.
- A browser entry imports `effect-frame/actor/client`, never
  `effect-frame/actor`, and reaches no `*.server.ts` file.
- Every choice is written where it is made: a route names its rendering
  mode, a host names its store and its policies, a handler names its body
  limit and its principal. There are no defaults to find out about.
- An Effect is yielded or composed. `Effect.provide` appears once, at the
  entry point, with `@effect-diagnostics-next-line strictEffectProvide:off`.

## Subpaths

| Subpath                         | Holds                                                                      | Runs in |
| ------------------------------- | -------------------------------------------------------------------------- | ------- |
| `effect-frame/actor`            | the host, `implementTransparent`, `implementQuery`, `Policy`, `HttpServer` | server  |
| `effect-frame/actor/client`     | `contract`, `query`, `Behavior`, `Actor`, `QueryCache`, `HttpTransport`    | both    |
| `effect-frame/actor/testing`    | `HttpTest` and the conformance suites                                      | tests   |
| `effect-frame/view`             | `View`, the JSX tags, `Dom`, `Html`, `Remote`                              | both    |
| `effect-frame/view/testing`     | `ViewTest`                                                                 | tests   |
| `effect-frame/view/driven`      | `Driven.session`, a server-driven view                                     | server  |
| `effect-frame/view/opentui`     | the terminal host                                                          | both    |
| `effect-frame/router`           | `Route`, `link`, `Link`, `hydrate`, `mount`, `renderDocument`              | both    |
| `effect-frame/router/prerender` | `Prerender.build`, `load`, `serve`                                         | server  |
| `effect-frame/frame`            | `Frame.layer`, `Frame.inspect`                                             | both    |
| `effect-frame/inspection`       | `Protocol`, `attachGateway`                                                | browser |

The JSX runtimes are `effect-frame/view/jsx-runtime`,
`effect-frame/view/jsx-dev-runtime`, and their `view/opentui/` twins. A
`tsconfig.json` names `"jsxImportSource": "effect-frame/view"`.

## A first app

A counter per name, on one server page each, with the names beside it.
The files are [`examples/counter/`](examples/counter), and
`tests/examples/counter.test.tsx` runs them as the server does.

The contract, the behavior and the query are shared by both sides.

<!-- example: examples/counter/contract.ts#contract -->

```ts
import { Behavior, contract, query } from "effect-frame/actor/client";
import { Match, Schema } from "effect";

// A message is a tagged struct. A form posts strings, so a number field
// decodes from a string: `FiniteFromString`, not `Finite`.
export const Increment = Schema.TaggedStruct("Increment", { by: Schema.FiniteFromString });
export const Reset = Schema.TaggedStruct("Reset", {});
export const CounterMessage = Schema.Union([Increment, Reset]);
export type CounterMessage = Schema.Schema.Type<typeof CounterMessage>;

// The contract is the public face of an actor: its key, its snapshot, its
// messages, and the policy that judges every read and send. Browser safe.
export const Counter = contract("Counter", {
  version: 1,
  policy: "public",
  key: Schema.Struct({ name: Schema.String }),
  snapshot: Schema.Finite,
  message: CounterMessage,
});

// The behavior is pure and browser safe too: the server runs it, and a
// page that holds it predicts a send before the server commits it.
export const counterBehavior = Behavior.reducer<number, CounterMessage>({
  initial: 0,
  reduce: (count, message) =>
    Match.valueTags(message, {
      Increment: (increment) => count + increment.by,
      Reset: () => 0,
    }),
});

// A query is a named server read. `depends` names the contracts whose
// commits make it stale; `version` is its wire version, as a contract's is.
export const CounterNames = query("CounterNames", {
  version: 1,
  args: Schema.Struct({}),
  result: Schema.Array(Schema.String),
  policy: "public",
  depends: [Counter],
});
```

The server half runs the actors and answers the query.

<!-- example: examples/counter/counter.server.ts#server-half -->

```ts
import {
  ActorHost,
  Policies,
  Policy,
  implementQuery,
  implementTransparent,
} from "effect-frame/actor";
import { Effect, Layer } from "effect";
import { Counter, CounterNames, counterBehavior } from "./contract.js";

// A `.server.ts` file runs only on a server: `bun run boundary` fails a
// browser entry that reaches it.
export const CounterLive = implementTransparent(Counter, { behavior: counterBehavior });

export const CounterNamesLive = implementQuery(CounterNames, {
  run: () => Effect.succeed(["home", "work"]),
});

// Every policy name a contract or query declares has a rule here. There is
// no default: allow-all is written by name.
export const policies = Layer.succeed(Policies, Policies.of({ public: Policy.allowAll }));

// The host runs the actors. `store` says where their mailboxes live; the
// memory store keeps nothing across a restart.
export const host = ActorHost.layer({
  implementations: [CounterLive],
  queries: [CounterNamesLive],
  store: ActorHost.memoryStore,
}).pipe(Layer.provide(policies), Layer.orDie);
```

The routes file imports from the router, the view, and the contract.

<!-- example: examples/counter/routes.tsx#imports -->

```tsx
import type { QueryState, RemoteActorRef } from "effect-frame/actor/client";
import { Source } from "effect-frame/actor/client";
import type { NotFoundProps } from "effect-frame/router";
import { Link, Route, link } from "effect-frame/router";
import { Show, View } from "effect-frame/view";
import { Effect, Schema } from "effect";
import { Counter, CounterNames, Increment, Reset, counterBehavior } from "./contract.js";
```

Segments are the addresses, and each one declares the data its page needs.

<!-- example: examples/counter/routes.tsx#segments -->

```tsx
// A segment is an address: a path template, the params it declares, and the
// data its page needs. `data` derives each declaration from the params, and
// the route opens, moves and releases it.
export const shell = Route.segment("shell", {
  path: "/",
  data: () => ({ names: Route.query(CounterNames, {}) }),
});

// A child continues its parent's path and declares only its own params.
export const counter = Route.child(shell, "counter", {
  path: "counters/:name",
  params: Schema.Struct({ name: Schema.String }),
  data: ({ params }) => ({
    counter: Route.actor(Counter, { name: params.name }, { behavior: counterBehavior }),
  }),
});
```

A leaf view draws one page.

<!-- example: examples/counter/routes.tsx#leaf-view -->

```tsx
// A view is `(props) => Effect.gen(...)`. It runs once per mounted identity;
// a change moves only what binds the source that changed.
export const CounterView = (props: Route.PropsOf<typeof counter>) =>
  Effect.gen(function* () {
    // `state` follows the actor the route holds now, across param moves.
    const count = props.data.counter.state;
    const big = Source.select(count, (value) => value >= 10);
    // One region per actor: a move to another counter builds its form again.
    const controls = yield* View.keyed(
      props.data.counter.ref,
      (ref) => ref.key.name,
      (ref) => Effect.flatMap(ref.get, (current) => Controls({ counter: current })),
    );
    return (
      <section>
        <h1>{View.bind(props.params, (params) => params.name)}</h1>
        <p>count: {View.bind(count)}</p>
        <Show when={big}>
          <p>that is a lot</p>
        </Show>
        {controls}
      </section>
    );
  });

// A child view is a function the parent yields, never a JSX tag.
const Controls = (props: { readonly counter: RemoteActorRef<typeof Counter> }) =>
  Effect.gen(function* () {
    // The form posts with no script and sends over the transport with one.
    const add = yield* View.form({
      ref: props.counter,
      message: Increment,
      typed: ["by"],
      endpoint: "/actors",
      returnTo: counter.href({ name: props.counter.key.name }, {}),
    });
    const reset = View.event(Effect.asVoid(props.counter.send(Reset.make({}))));
    return (
      <div>
        <form onSubmit={add.submit}>
          <input name="by" value="1" />
          <button type="submit">add</button>
        </form>
        {add.issues.map((issue) => (
          <p>{issue.message}</p>
        ))}
        <button type="button" onClick={reset}>
          reset
        </button>
      </div>
    );
  });
```

A layout view wraps its child.

<!-- example: examples/counter/routes.tsx#layout-view -->

```tsx
// A layout wraps its child's view, which it gets as `props.outlet`. It stays
// generic in `ChildR`, what the child's view needs; in a .tsx file the
// generic takes a trailing comma.
export const ShellView = <ChildR,>(props: Route.LayoutPropsOf<typeof shell, ChildR>) =>
  Effect.gen(function* () {
    // `View.loading` shows its fallback until every `View.ready` inside it
    // has a first value. A `View.ready` with no `View.loading` above it
    // does not compile where the tree is mounted.
    const nav = yield* View.loading({
      fallback: <p>loading</p>,
      content: Names({ names: props.data.names.state }),
    });
    const body = yield* View.loading({ fallback: <p>loading</p>, content: props.outlet });
    return (
      <main>
        <nav>{nav}</nav>
        {body}
      </main>
    );
  });

const Names = (props: { readonly names: Source<QueryState<ReadonlyArray<string>, unknown>> }) =>
  Effect.gen(function* () {
    const names = yield* View.ready(props.names, []);
    // A keyed list whose rows run an Effect: here, each row makes its link.
    const rows = yield* View.list({
      each: names,
      keyBy: (name) => name,
      row: (name) =>
        Effect.gen(function* () {
          const current = yield* name.get;
          const to = yield* link(counter, { name: current }, {});
          return (
            <li>
              <Link link={to}>{current}</Link>
            </li>
          );
        }),
    });
    return <ul>{rows}</ul>;
  });
```

The routes mount the tree in one rendering mode.

<!-- example: examples/counter/routes.tsx#routes -->

```tsx
// A route is a tree of branches mounted by one rendering-mode constructor.
// `Route.ssr` resolves every declared read on the server before it draws.
export const App = Route.ssr(
  "app",
  Route.layout(shell, [Route.leaf(counter, CounterView)], ShellView),
);

// `/` has no page of its own.
export const Home = Route.redirecting("home", Route.segment("home", { path: "/" }), () =>
  Effect.succeed(Route.redirect(counter, { name: "home" }, {})),
);

export const routes = [Home, App];

export const NotFound = (_props: NotFoundProps) => Effect.succeed(<p>no such page</p>);
```

The server document and the browser entry name the same root element.

<!-- example: examples/counter/document.ts#root-id -->

```ts
// The element the page mounts into. The server's document names it and the
// browser entry finds it, both from here.
export const rootId = "app";
```

The server renders a page for each request, and serves the actors.

<!-- example: examples/counter/page.server.ts#server -->

```ts
import { HttpServer } from "effect-frame/actor";
import type { ActorTransport, Principal } from "effect-frame/actor/client";
import { Anonymous, CurrentPrincipal, Form } from "effect-frame/actor/client";
import { renderDocument, respondDocument } from "effect-frame/router";
import { Html } from "effect-frame/view";
import { Effect, Option, Schema, Stream } from "effect";
import { Counter } from "./contract.js";
import { rootId } from "./document.js";
import { NotFound, routes } from "./routes.js";

// The document around the drawing. The renderer writes `<div id={rootId}>`
// between `head` and `tail`; a refused form post adds its issues to `tail`.
const page = (tail: string): Html.Document => ({
  head: '<!doctype html><html><head><meta charset="utf-8"></head><body>',
  rootId,
  tail,
  bootstrap: '<script type="module" src="/client.js"></script>',
  end: "</body></html>",
});

// Render one URL through the routes, for one principal. The route's
// constructor picks the rendering mode; nothing here names one.
export const renderPage = Effect.fn("Counter.renderPage")(function* (
  url: URL,
  principal: Principal,
) {
  // A refused post's page carries its issues, so the client draws the same form.
  const refusal = yield* Effect.serviceOption(Form.FormContext);
  const issues = yield* Option.match(refusal, {
    onNone: () => Effect.succeed(""),
    onSome: (found) =>
      Effect.map(Form.encodeIssues(found), (json) => Html.jsonScript(Form.issuesScriptId, json)),
  });
  return yield* renderDocument({
    routes,
    notFound: NotFound,
    url,
    document: page(issues),
    closeWhen: Effect.sleep("10 seconds"),
    principal,
  });
});

// This app has no sessions: every page is drawn for nobody in particular.
const nobody: Principal = Anonymous.make({});

// One page request. `respondDocument` owns the render's Scope and answers a
// redirect with 303, a document with its status, and a defect with 500.
export const answerPage = (request: Request): Effect.Effect<Response, never, ActorTransport> =>
  respondDocument(renderPage(new URL(request.url), nobody), {
    onTimeout: () => Effect.succeed(new Response("the page took too long", { status: 504 })),
  });

class PageRedirected extends Schema.TaggedError<PageRedirected>()("PageRedirected", {
  location: Schema.String,
}) {}

// The page a refused plain post draws again, as one string.
const drawAgain = (path: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const principal = yield* CurrentPrincipal;
      const outcome = yield* renderPage(new URL(path, "http://counter.invalid"), principal);
      if (outcome._tag === "Redirect") {
        return yield* PageRedirected.make({ location: outcome.location.pathname });
      }
      return Array.from(yield* Stream.runCollect(outcome.body)).join("");
    }),
  );

// The actor handler: the JSON verbs, the change streams, and the plain form
// route, each at `prefix` + its path. Every edge decision is written here.
export const actorHandler = HttpServer.make({
  prefix: "/actors",
  principal: HttpServer.anonymous,
  maxBodyBytes: HttpServer.defaultMaxBodyBytes,
  form: Option.some({
    contracts: [Counter],
    login: Option.none(),
    render: drawAgain,
    commitWithin: HttpServer.defaultCommitWithin,
  }),
});
```

The browser entry hydrates what the server drew.

<!-- example: examples/counter/client.tsx#client -->

```tsx
import { HttpTransport, QueryCache } from "effect-frame/actor/client";
import {
  Location,
  NavigationBehavior,
  browserNavigation,
  followLinks,
  hydrate,
} from "effect-frame/router";
import { Dom } from "effect-frame/view";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { rootId } from "./document.js";
import { NotFound, routes } from "./routes.js";

// The browser entry: it imports `effect-frame/actor/client`, never
// `effect-frame/actor`, and reaches no `.server.ts` file.
const start = Effect.gen(function* () {
  const root = yield* Dom.root(rootId);
  // `hydrate` reads what the server's document carries, mounts the routes
  // over its nodes, and follows the URL from then on.
  const { router } = yield* hydrate({
    routes,
    notFound: NotFound,
    root,
    landing: NavigationBehavior.Restore,
    traversalReadLimit: "3 seconds",
  });
  yield* followLinks(document, router);
  return yield* Effect.never;
});

const services = Layer.mergeAll(
  Layer.provideMerge(
    QueryCache.layer,
    HttpTransport.layer({
      baseUrl: `${location.origin}/actors`,
      reconnect: HttpTransport.defaultReconnect,
    }).pipe(Layer.provide(FetchHttpClient.layer)),
  ),
  Layer.effect(Location, browserNavigation),
);

// The entry point: the one place the client's services are provided.
// @effect-diagnostics-next-line strictEffectProvide:off
Effect.runFork(Effect.scoped(Effect.provide(start, services)));
```

The process edge builds the bundle and serves. It is the only file that
names Bun.

<!-- example: examples/counter/main.server.ts#main -->

```ts
// oxlint-disable effect/noAsyncFunction, effect/noGlobals -- the process edge: Bun builds the bundle and serves, and each request enters the runtime through runPromise.
import { ManagedRuntime } from "effect";
import { host } from "./counter.server.js";
import { actorHandler, answerPage } from "./page.server.js";

// The platform boundary: one runtime holds the actors, and both the pages
// and the actor handler run in it.
const runtime = ManagedRuntime.make(host);
const actors = await runtime.runPromise(actorHandler);
const client = await Bun.build({ entrypoints: ["./client.tsx"], target: "browser" });
const bundle = await client.outputs[0]?.text();

Bun.serve({
  port: 3000,
  fetch: (request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/actors/")) {
      return runtime.runPromise(actors(request));
    }
    if (url.pathname === "/client.js") {
      return new Response(bundle, { headers: { "content-type": "text/javascript" } });
    }
    return runtime.runPromise(answerPage(request));
  },
});
```

## What a view calls

| Write                                     | Kind           | For                                                                          |
| ----------------------------------------- | -------------- | ---------------------------------------------------------------------------- |
| `View.bind(source, f?)`                   | prop or child  | a value that follows a source, projected by `f` where it is drawn            |
| `View.event(handler \| effect)`           | `on*` prop     | an event handler, or the Effect a handler that reads no event runs           |
| `View.submit(handler \| effect)`          | `onSubmit`     | a submit whose default action the host suppresses                            |
| `View.form({ ref, message, ... })`        | yielded Effect | a command form that posts with no script                                     |
| `View.list({ each, keyBy, row })`         | yielded Effect | a keyed list whose rows run an Effect                                        |
| `View.keyed(source, keyBy, row)`          | yielded Effect | one region built again for each new identity                                 |
| `View.show({ when, content, fallback })`  | yielded Effect | a branch whose setup runs only while a boolean source is true                |
| `View.match(on, cases)`                   | yielded Effect | one branch per tag of a union source, whose case runs a setup                |
| `View.loading({ fallback, content })`     | yielded Effect | a boundary that shows `fallback` until every `View.ready` inside has a value |
| `View.errored({ fallback, content })`     | yielded Effect | a boundary that shows `fallback` when `View.orErrored` inside fails          |
| `View.ready(state, placeholder)`          | yielded Effect | a query's value, inside `View.loading`                                       |
| `View.readyWithStale(state, placeholder)` | yielded Effect | the same, with the `stale` flag                                              |
| `View.orErrored(state)`                   | yielded Effect | a query's state whose failure goes to `View.errored`                         |
| `View.attempt(setup, fallback)`           | yielded Effect | one setup's typed failure, handled in place                                  |
| `View.lazy(load)`                         | a view         | a view imported on first use                                                 |
| `View.attach(run)`, `Dom.attach(run)`     | `attach` prop  | a behaviour on the host node, for the element's lifetime                     |
| `<For each keyBy fallback?>`              | tag            | a keyed list of plain rows, and `fallback` while it has none                 |
| `<Show when fallback?>`                   | tag            | a branch while a boolean source is true, and `fallback` while it is not      |
| `<Show when is>{(narrowed) => ...}`       | tag            | a branch while `is` holds, given a source of the narrowed value              |
| `<Match on cases>`                        | tag            | one branch per tag of a union source                                         |
| `<Await state loading failed ready>`      | tag            | all three states of a query in one place                                     |
| `<Portal into={Dom.target(element)}>`     | tag            | children drawn under a node the host made a target of                        |
| `View.mount`, `View.flush`                | yielded Effect | mounting a view without the router, and settling it in a test                |

## One branch per case

Conditions over one value are one tagged union, matched once. Project the
source to the union with `Source.select` and draw it with `<Match>`: each
case gets a source of its own member, and a missing case does not compile.
This replaces a `Show` inside a `Show`, which tracks two sources and nests a
render function per level. When a case runs a setup, `View.match(on, cases)`
is the same table as a yielded Effect.

<!-- example: examples/features/branches.tsx#union-match -->

```tsx
/** A search hit's citation: its reference code and link, when it has them. */
export interface Hit {
  readonly refcode: Option.Option<string>;
  readonly url: Option.Option<string>;
}

/** The three ways a citation draws, as one union: no `Show` inside a `Show`. */
export type Cite =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Unlinked"; readonly refcode: string }
  | { readonly _tag: "Linked"; readonly refcode: string; readonly url: string };

const citeOf = (hit: Hit): Cite =>
  Option.match(hit.refcode, {
    onNone: (): Cite => ({ _tag: "Missing" }),
    onSome: (refcode) =>
      Option.match(hit.url, {
        onNone: (): Cite => ({ _tag: "Unlinked", refcode }),
        onSome: (url): Cite => ({ _tag: "Linked", refcode, url }),
      }),
  });

// One source of the union, matched once. Each case gets a source of its own
// member, and a missing case does not compile.
export const Reference = (props: { readonly hit: Source<Hit> }) =>
  Effect.succeed(
    <Match
      on={Source.select(props.hit, citeOf)}
      cases={{
        Missing: () => <span class="refcode" />,
        Unlinked: (cite) => <span class="refcode">{View.bind(cite, (c) => c.refcode)}</span>,
        Linked: (cite) => (
          <a class="refcode" href={View.bind(cite, (c) => c.url)}>
            {View.bind(cite, (c) => c.refcode)}
          </a>
        ),
      }}
    />,
  );
```

## JSX

The tags are a closed, typed map. A `tsconfig.json` with
`"jsxImportSource": "effect-frame/view"` gets the HTML tags, which the DOM,
HTML, and Remote hosts share. A terminal file names its own runtime in a
block comment at its top, `@jsxImportSource effect-frame/view/opentui`, and
gets `box`, `text`, and `input`, whose props are the OpenTUI renderables'
own options.

- A prop is the attribute as HTML spells it: `class`, `for`, `tabindex`,
  `contenteditable`. `className` does not compile.
- A value is written once, or bound to a source with `View.bind`. A raw
  `Source` reports `Property '"wrap the source with View.bind(source)"' is
missing`.
- An `on*` prop is the event in lowercase (`onKeyDown` listens for
  `keydown`) and takes `View.event` or `View.submit`. A plain function
  reports `"wrap the handler with View.event(handler)"`. A handler that
  reads its event is `View.event((event) => ...)`; one that reads none is
  the Effect itself, `View.event(addPane)`, run once per event. Either way
  the Effect cannot fail: a view has no place to return a failure.
- `View.submit` has the host suppress the default action first. A form's
  `onSubmit` takes only that kind, `View.submit` or a `View.form` binding's
  `submit`, so a form never posts natively by mistake. A view writes no
  `method` or `action`: the runtime writes a command form's plain post.
- A void element (`input`, `img`, `br`) holds no children.

## Routing

`effect-frame/router` exports one route model on the `Route` namespace. A
segment is an address. A branch is a segment with its view. A mode
constructor mounts a whole tree: `Route.client`, `Route.ssr`,
`Route.streamed`, `Route.awaitAll`, `Route.prerender`, or `Route.driven`.

<!-- example: examples/features/routing.tsx#imports -->

```tsx
import { Link, NavigationBehavior, Route, link } from "effect-frame/router";
import { View } from "effect-frame/view";
import { Effect, Schema } from "effect";
import { TenantInfo, isSignedIn } from "./tenant.js";
```

<!-- example: examples/features/routing.tsx#segments -->

```tsx
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
```

<!-- example: examples/features/routing.tsx#layout-view -->

```tsx
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
```

<!-- example: examples/features/routing.tsx#leaves -->

```tsx
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
```

- A segment's `params` codec decodes exactly the names its own template
  declares, so `path: "/app/:tenant"` with `Schema.Struct({ tenantId })`
  does not compile. A child declares only its own params and inherits its
  ancestors'. A template with no param takes no `params`.
- `before` runs parent first, before anything commits. It returns
  `Route.Continue` or `Route.redirect(segment, params, search)`.
- A URL that only moves elsewhere is `Route.redirecting(name, segment, to)`.
  It has no view: `to` answers the `Route.redirect` before anything draws.
- A view that can fail, and every `View.lazy` view, needs an `errored`
  handler. It receives a `Route.RouteFailure`.
- `View.lazy` returns a `LazyView`, tagged `"LazyView"`. A route given it
  starts the import beside its data; a route given a view wrapped around
  it sees a plain View and imports at setup, so hand the route the
  `LazyView` itself.
- Every segment view gets `params`, `search`, `data`, `href`,
  `pushSearch`, and `replaceSearch`. A layout also gets `outlet`.
- Every move is `push` or `replace`: `router.push(href)`, a link's
  `link.push` and `link.replace`, a view's `pushSearch` and
  `replaceSearch`, and a `UrlState`'s `push` and `replace`, which take a
  value or an updater of the latest value.
- Each `data` binding has a `state` Source. A `Route.query` binding also has
  `refresh` and `override`. A `Route.actor` binding is `{ ref, state }`:
  `state` follows the reference the route holds now, and a send names it,
  `Effect.flatMap(props.data.counter.ref.get, (ref) => ref.send(message))`.
- `Route.commandRef(contract, key)` declares an actor the page only
  commands. Its binding is `{ ref }`, a `Source<RemoteCommandRef<C>>` the
  route opens, moves with its params, and releases; it reads no snapshot
  and follows no stream.
- A view written apart from its segment types its props from the segment:
  `Route.PropsOf<typeof post>` for a leaf, and
  `Route.LayoutPropsOf<typeof tenant, ChildR>` for a layout. A layout view
  stays generic in `ChildR`, the services its children's views need, so
  `Route.layout` can prove the outlet's requirements (a `View.loading`
  around `props.outlet` provides `LoadingScope`; a tree that leaves it open
  fails at the mode constructor with `View.ready needs a View.loading above
it`). In a `.tsx` file the generic needs its trailing comma. Do not type
  props by hand: the props interfaces are not exported.
- `link` takes a segment. `Link` draws `aria-current="page"` when the
  current path is the segment's path printed with the link's params, and
  `aria-current="true"` when the current path continues below that printed
  path. The same segment with other params gets neither, nor does any link
  on not-found or on another route. The search never counts: a link to a
  list is the page under any sort or filter.
- `link(to, params, search)` takes fixed params or a `Source` of them. A
  layout that outlives a param move passes `props.params`, so its links
  follow the params it holds now instead of the ones it was drawn with.
- A mode constructor takes a branch of a root segment only. A mode is the
  constructor; no route value carries a mode field.

See [the public route design](../../docs/design/route-public.md).

### Scroll and focus

In the browser, provide `browserNavigation` as the `Location`. It uses the
Navigation API, and the History API where that is absent. `followLinks`
follows ordinary same-origin anchors. `Dom.root` finds the element the
server's document wrote for its `rootId`, or fails with `RootNotFound`. The
first app's browser entry above is the one every example app uses.

- At shell commit (the new branch is in the document, fallbacks included),
  `NavigationBehavior.Restore` puts the viewport at the top, at
  the URL's fragment, or at the entry's saved position on Back and Forward.
  It then focuses the entering leaf's root, or the first `autofocus` element
  inside that leaf. It does not wait for queries.
- `NavigationBehavior.Preserve` leaves scroll and focus alone. Set it on a
  leaf (`Route.leaf(..., { landing })`, as the tab leaf above does), or for
  the whole router (`hydrate({ ..., landing })`). A layout takes no
  `landing`: the destination leaf decides. The option is `landing`, not
  `behavior`: `behavior` is an actor's reducer.
- `mount` and `hydrate` require `landing` and `traversalReadLimit` (how long
  Back and Forward wait for a page's declared reads before they land). The
  router has no hidden default.
- A leaf's root element gets `tabindex="-1"`, unless the view wrote a
  `tabindex` or the element is focusable already, such as a `<button>`.
  Focus uses `preventScroll`. A stayed leaf (a search or param change on the
  same leaf) keeps focus and the caret.
- The router holds no scroll position and never sets
  `history.scrollRestoration`. It adds no `aria-live` region.
- `Link` and `followLinks` share one plain-click policy: a modified or
  middle click, `target="_blank"`, a download, another origin, and a link
  that only changes the current page's fragment are left to the browser.
  `followLinks` always pushes; a move that replaces is a `Link` with
  `replace`.

See [the navigation behavior design](../../docs/design/navigation-behavior.md).

### Server documents

`renderDocument` answers one request. It settles the request first: it
matches the URL and runs the matched route's checks, whatever the mode.
Then it renders with the settled tree's mode. It mounts the same router on
the HTML host, over its own query cache, at the request URL. The first
app's `page.server.ts` above is the whole of it.

- `principal` is required: every check and query the render reads runs
  under it, and nothing falls back to a default caller.
- `respondDocument` answers a redirect with `303 See Other`, a document
  with its status and an HTML body, a `DocumentTimedOut` with `onTimeout`,
  and a defect with 500.
- A check that redirects is the answer, `{ _tag: "Redirect", location }`.
  The render does not follow it. A `Route.client` route runs its checks
  on the server too.
- `Rendered.route` is `{ _tag: "Matched", route }`, the route value, or
  `{ _tag: "NotFound" }`. `status` is 404 for not-found and 200 otherwise.
  Not-found renders as `SSR`.
- Every route comes from a mode constructor, and names itself. `mount` and
  the server document die with `Route.RouteNameRejected` when two routes
  share a name, or when one is named `"not-found"`, the router's own.
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

See [the route data design](../../docs/design/route-data.md).

### Prerendered pages

`Route.prerender` is a mode constructor that lists its inputs.

<!-- example: examples/features/prerender.server.tsx#tree -->

```tsx
// A prerender tree names one `Route.inputs` for each segment that adds a
// path param. A child's function runs once per parent page, receives the
// parent's params, and returns only its own.
export const Posts = Route.prerender(
  "posts",
  Route.layout(org, [Route.leaf(post, PostView)], OrgView),
  { inputs: [Route.inputs(org, listOrgs), Route.inputs(post, (parent) => listPosts(parent.org))] },
);
```

A segment that adds a param and names no inputs is refused where the tree
is constructed, with `PrerenderAncestorNotEnumerable` naming the segment
and the param. A layout that adds no param needs no inputs.

The build and the server are server-only, in `effect-frame/router/prerender`:

<!-- example: examples/features/prerender.server.tsx#build -->

```tsx
// The build: every input, through the document pipeline, in AwaitAll, as
// Anonymous. It publishes a new generation with one rename.
export const buildSite = Prerender.build({
  routes: [Posts],
  notFound: NotFound,
  document: (page) => Effect.succeed(documentFor(page)),
  client: bundleText, // written once as client.js
  out: "dist/prerender",
  timeLimit: "10 seconds",
});

// The server: a built page answers before the router runs. `load` holds the
// generation it read for the calling scope, so run it in the server's scope.
export const handler = (routerHandler: Prerender.WebHandler) =>
  Effect.gen(function* () {
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

The blog app (`apps/blog`) is a whole prerendered site. See
[the prerender design](../../docs/design/prerender.md).

## Plain-form commands

A command form works with no JavaScript. The server renders a real
`<form method="post">`; the hydrated page sends the same message over the
actor transport. The first app's `Controls` is one; the server's
`HttpServer.make` above serves its route at `/actors/form`.

<!-- example: examples/features/forms.tsx#message -->

```tsx
// The render mints `id` from the form's command id; decoding never mints it.
// A checkbox posts nothing when unchecked, so `Form.Checkbox` reads absent
// as false.
export const Add = Schema.TaggedStruct("Add", {
  id: Generated.fromCommandId(Schema.String),
  text: Schema.String,
  pinned: Form.Checkbox,
});
```

<!-- example: examples/features/forms.tsx#compose -->

```tsx
// `typed` names the fields the reader types; the runtime writes the rest
// (method, action, and the hidden command fields) in every host.
export const Compose = (props: { readonly notes: RemoteActorRef<typeof Notes> }) =>
  Effect.gen(function* () {
    const add = yield* View.form({
      ref: props.notes,
      message: Add,
      typed: ["text", "pinned"],
      endpoint: "/actors",
      returnTo: "/",
    });
    return (
      <form onSubmit={add.submit}>
        <input name="text" />
        <input type="checkbox" name="pinned" />
        <button type="submit">add</button>
        {add.issues.map((issue) => (
          <p>{issue.message}</p>
        ))}
      </form>
    );
  });

// From code, `Generated.send` sends the input without its generated fields.
export const addFromCode = (notes: RemoteActorRef<typeof Notes>) =>
  Generated.send(notes, { _tag: "Add", text: "hello", pinned: false });
```

- `effect-frame/actor/client` exports `Generated` (`fromCommandId`,
  `freshId`, `send`, `Input`) and `Form` (`codec`, `Checkbox`,
  `FormContext`, `FormIssues`, `issuesOf`, `encodeKey`, and the field-map
  helpers). `Wire.paths.form` is `/form`.
- `View.form` returns `{ submit, issues, commandId }`. The runtime draws
  `method`, `action`, and the hidden `$command`, `$contract`, `$version`,
  `$key`, `$return`, `$form`, `_tag`, and generated inputs in every host.
- The form route answers 303 to `$return` on success, 200 with the page
  and its `FormIssues` on a validation failure, 504 with the same id on a
  lost reply, and 400 or 415 before any send. An `Unauthorized` anonymous
  post answers 303 to `login` with `next`; every other refusal is a 403
  with the page.
- A refused page must carry its issues to the client. On the server, embed
  `Form.encodeIssues` under `Form.issuesScriptId` when `FormContext` is
  present, as the first app's `renderPage` does. `hydrate` reads them on
  the client.
- Each form posts `$form` (the member tag, or `name`). A refusal redraws
  only the form that posted it.
- `$return` must be printable ASCII, root-relative, and resolve to this
  origin. A `charset` other than UTF-8 is refused with 415.
- A field whose name has a segment that starts with `_` is never written
  back into a refused page. A multipart body is refused with 415.
- `HostEvent.form` carries the submitted fields on a DOM submit.
  `Prepared.post` carries a form's plain post.

See [the plain-form design](../../docs/design/plain-forms.md).

## Optimistic commands

A remote reference shows a command before the server commits it when the
client can import the actor's behavior and that behavior has `predict`.

<!-- example: examples/features/optimistic.ts#optimistic -->

```ts
// A reference given the actor's behavior predicts each fresh send before
// the server commits it. `Behavior.value` and `Behavior.reducer` predict;
// `Behavior.machine` does not.
export const program = Effect.gen(function* () {
  const counter = yield* Actor.remote(
    Counter,
    { name: "home" },
    { resume: Option.none(), behavior: counterBehavior },
  );
  const handle = yield* counter.send(Increment.make({ by: 1 }));
  // { revision: { _tag: "Provisional", base, depth: 1 }, state }
  const shown = yield* counter.displayed.get;
  // The committed revision only: use it for resume data.
  const committed = yield* counter.applied.get;
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

See [the optimistic send design](../../docs/design/optimistic.md).

## Streamed documents

A routed page streams with `Route.streamed`, and `hydrate` reads the
records. A page with no router writes both halves itself.

<!-- example: examples/features/streaming.server.ts#server -->

```ts
// The shell and its fallbacks first, then one record per query as it
// settles, then `Closed`. Nothing in the document runs: each record is JSON
// the client reads into its query cache.
const page: Html.Document = {
  head: '<!doctype html><html><head><meta charset="utf-8"></head><body>',
  rootId: "app", // the renderer writes <div id="app"> around the drawing
  tail: "", // resume payloads and form issues go here
  bootstrap: '<script type="module" src="/client.js"></script>',
  end: "</body></html>",
};

export const answer = Effect.gen(function* () {
  const body = Html.renderToStream(NamesPage, { title: "names" }, page, {
    closeWhen: Effect.sleep("10 seconds"),
  });
  const context = yield* Effect.context<Stream.Services<typeof body>>();
  return new Response(Stream.toReadableStreamWith(Stream.encodeText(body), context), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
});
```

<!-- example: examples/features/streaming-client.tsx#client -->

```tsx
// A routed page never writes this: `hydrate` from `effect-frame/router`
// does it. A page with no router reads the records, seeds the cache, and
// hydrates itself, in this order.
export const start = Effect.gen(function* () {
  const root = yield* Dom.root("app");
  const resumed = yield* Streaming.resume(yield* Dom.readRecords);
  const hydration = Dom.hydrate(root);
  yield* View.mount(NamesPage, { title: "names" }, hydration.host, root);
  yield* View.flush;
  const report = yield* hydration.finish; // report.resolvedAhead
  // Drop the seeds no view took, and start the reads the seeds call for.
  yield* resumed.hydrated;
  return report;
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
  record channel. `Html.renderToString` draws one frame and releases what setup opened
  before the string returns.
- `options.closeWhen` is the time limit, and both calls require it
  (`Effect.never` waits for ever). A query still open at the limit has no
  value in the document, and the client reads it again. A drawing whose
  records still move at the limit is never written beside a seed it does
  not show: the call fails with `Html.RecordsUnsettled`.
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
- `Host` has three optional capabilities, `boundaryMarks`, `adoptBoundary`
  and `setupStarted`. A custom host may omit them. The HTML host writes
  `<!--frame-boundary:…-->` marks around each readiness boundary.

See [the streaming design](../../docs/design/streaming.md).

## Server-driven views

A view can run on the server and draw into a browser over a stream of host
operations. The server mounts the view on a recording host; the client
replays the operations and sends events back. A connection starts with the
drive actor's snapshot, never with an operation log, and a reconnect does
the same at constant cost. A routed page uses `Route.driven`.

<!-- example: examples/features/driven.server.ts#server -->

```ts
// One session per connection. The socket is the application's: `received`
// is the events the client sent, and `send` writes one text frame.
export const serve = (
  key: RoomKey,
  received: Stream.Stream<Remote.RemoteEvent>,
  send: (text: string) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const session = yield* Driven.session(RoomView, { key }, { contract: Counter, key });
    // The first message is the drive's snapshot, never an operation log.
    yield* send(session.resume);
    yield* Effect.forkScoped(Stream.runForEach(received, session.fire));
    yield* Stream.runForEach(session.patches, (patch) => Effect.flatMap(encodePatch(patch), send));
  });
```

<!-- example: examples/features/driven-client.tsx#client -->

```tsx
// The client draws from the snapshot on its own recorder, then applies each
// patch. It works with any host; here, the DOM.
export const follow = (key: RoomKey, root: Element, send: (event: Remote.RemoteEvent) => void) => {
  const client = Remote.client(
    RoomView,
    { key },
    { contract: Counter, key },
    {
      host: Dom.host,
      root,
      send,
    },
  );
  return {
    // The first connect and every reconnect.
    resume: (payload: string) => client.resume(payload),
    // A patch from another session, one out of order, or one naming a node
    // the client does not hold applies nothing and fails.
    apply: (text: string) => Effect.flatMap(decodePatch(text), client.apply),
  };
};
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
- A driven view draws from its one drive actor, on both sides; any other
  read fails `Unreachable`. Its drawing must depend on its props and that
  snapshot only. An event carries its value only, and reaches only a
  listener a patch has delivered. Patches are trusted server output. The
  socket is the application's.
- A host may implement `forget(node)`: the runtime calls it when the owner
  that drew the node ends. The recorder sends it as a `Forget` op, so a
  long session holds only live nodes.

See [the op wire design](../../docs/design/op-wire.md).

## Authorization

Every contract and every query names a policy. The root host requires a
policy table, and there is no default table and no default rule.

<!-- example: examples/features/ledger.ts#contract -->

```ts
// Every contract and every query names a policy. The name is a key into
// the host's table, which holds the rule.
export const Entry = Schema.TaggedStruct("Entry", { text: Schema.String });
export type Entry = Schema.Schema.Type<typeof Entry>;

export const Ledger = contract("Ledger", {
  version: 1,
  policy: "tenantMember",
  key: Schema.Struct({ tenant: Schema.String, id: Schema.String }),
  snapshot: Schema.Finite,
  message: Entry,
});

export const Totals = query("Totals", {
  version: 1,
  args: Schema.Struct({ tenant: Schema.String }),
  result: Schema.Finite,
  policy: "tenantMember",
  depends: [Ledger],
});
```

<!-- example: examples/features/authorization.server.ts#policy -->

```ts
const decodeLedgerKey = Schema.decodeUnknownOption(Ledger.key);
const decodeTotalsArgs = Schema.decodeUnknownOption(Totals.args);

// The tenant a subject names: a ledger's key, or the totals' arguments.
const tenantOf = (subject: Subject): Option.Option<string> => {
  if (subject._tag === "Actor") {
    return Option.map(decodeLedgerKey(subject.address.key), (key) => key.tenant);
  }
  return Option.map(decodeTotalsArgs(subject.key.args), (args) => args.tenant);
};

const decodeTenants = Schema.decodeUnknownOption(Schema.Array(Schema.String));

// The tenants a session published about its subject.
const tenantsOf = (who: Authenticated): ReadonlyArray<string> =>
  Option.getOrElse(decodeTenants(who.claims["tenants"]), (): ReadonlyArray<string> => []);

// One rule for actors and queries. `Policy.of` refuses Anonymous first.
const tenantMember = Policy.of(tenantOf, (who, tenant) =>
  Effect.succeed(tenantsOf(who).includes(tenant)),
);

// Every name a contract or query declares has a rule. Allow-all exists
// only by name.
const policies = Layer.succeed(Policies, Policies.of({ tenantMember, public: Policy.allowAll }));

export const host = ActorHost.layer({
  implementations: [LedgerLive],
  queries: [TotalsLive],
  store: ActorHost.memoryStore,
}).pipe(Layer.provide(policies));
```

<!-- example: examples/features/authorization.server.ts#principal -->

```ts
// The principal is derived once per request, and followed on a connection:
// one subscription per session, shared by every connection on it.
export const handler = Effect.gen(function* () {
  const sessions = yield* HttpServer.shareSessions({
    read: readSession, // (sessionId) => Effect<Principal>
    follow: followSession, // (sessionId) => Stream<Principal>, current first
  });
  const principal: HttpServer.DerivePrincipal = (request) =>
    Effect.succeed(
      Option.match(sessionIdOf(request), { onNone: () => Principal.anonymous, onSome: sessions }),
    );
  return yield* HttpServer.make({
    prefix: "/actors",
    principal,
    maxBodyBytes: HttpServer.defaultMaxBodyBytes,
    form: Option.none(),
  });
});
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
- `HttpServer.make({ prefix, principal, maxBodyBytes, form })` is the
  host's one handler. It answers each verb at exactly `prefix +
Wire.paths.*`, so the app hands it every path under the prefix unchanged.
  `principal` is a derivation `(request) => Effect<PrincipalSource>`, run
  once per request for the JSON verbs and the form route alike;
  `HttpServer.anonymous` is the derivation for a host with no sessions. A
  body over `maxBodyBytes` answers 413 before it is decoded
  (`HttpServer.defaultMaxBodyBytes` is one MiB).
- A changes stream reads its principal from the first value of one
  subscription to the source, and watches the rest of that same
  subscription. It ends with `Unauthorized` on the first value that is not
  equal to the connected one. The HTTP client never retries `Unauthorized`.
- `HttpServer.shareSessions({ read, follow })` keeps one subscription per
  session key, shared by every connection on it and released when the last
  one closes.
- `HttpServer.make` and celld's `defineFrameHost` run the derivation in
  the context the handler was built in, so a derivation may need
  `ActorTransport` and any service that context provides.
- `QueryCache` has `principalChanged`: every live entry drops its value and
  reads again. A reference whose change stream ends with `Unauthorized`
  calls it, so a client never shows a value read under a principal that is
  gone. Call it yourself after a sign-in or sign-out in a long-lived client.
- `ActorHost.layer` also provides `ActorHost.Recovery`. Its `wake(address)`
  opens an actor with no caller, so a durable host drains admitted commands
  after a restart. It checks no policy, returns no state, and is never on
  the wire.

See [the authorization design](../../docs/design/authorization.md).

## Browser inspection

The browser-safe `effect-frame/frame` entry exposes `Frame.layer` and
`Frame.inspect`. Build one Frame layer for each application root, in the
same layer graph as the query cache.

<!-- example: examples/features/inspection.ts#frame-layer -->

```ts
// One Frame layer per application root, in the same graph as the query
// cache, so the cache registers its entries in that root.
export const appLayer = Layer.merge(
  QueryCache.layer.pipe(Layer.provideMerge(Frame.layer({ name: "counter" }))),
  transport,
);
```

`Layer.provideMerge` gives the cache the Frame registry and keeps the Frame
service available to the mounted application. A test uses the same
composition, with the host in the same runtime in place of the HTTP
transport:

<!-- example: examples/features/inspection-test.server.ts#test-layer -->

```ts
// A test composes the same way, with the host in the same runtime in place
// of the HTTP transport.
export const testLayer = Layer.merge(
  QueryCache.layer,
  ActorHost.layer({
    implementations: [CounterLive],
    queries: [CounterNamesLive],
    store: ActorHost.memoryStore,
  }),
).pipe(Layer.provide(policies), Layer.provideMerge(Frame.layer({ name: "counter-test" })));
```

Keep the cache layer alive for the full mounted application scope. Providing a
cache only around a short setup effect closes its `RcMap` when that effect
returns, even if an outer view scope still holds a query consumer.

The browser-safe `effect-frame/inspection` subpath exports `Protocol` (the
versioned wire contract) and `attachGateway`. A development entry attaches
its root to a loopback gateway; a production entry imports nothing from
this subpath and carries none of it. The gateway and the reader are the
`effect-frame` executable in [`packages/inspect`](../inspect/README.md).
See [the inspection gateway design](../../docs/design/inspection-gateway.md).
