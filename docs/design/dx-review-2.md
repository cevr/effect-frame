# DX review 2: effect-frame against Solid, React, Octane, SvelteKit remote functions, and TanStack Router

Goal restated: an actor model, declarative, and explicit. Every dependency is a value the reader can see. Implicit tracking won when humans wrote the code. Explicit models are better for agents and for review.

This review sorts the gaps into three bands. Band A is designed but not built. Band B is not in the design and matters. Band C is small.

## Band A: designed, not built

The design already answers these. The build map (#33 to #43) owns them. They are listed so the review does not re-litigate them.

| Idea from elsewhere                                | Frame answer                                                      | Where    |
| -------------------------------------------------- | ----------------------------------------------------------------- | -------- |
| TanStack nested layouts and outlets                | layouts with `children`, an outlet, Transition lifecycle          | #18, #36 |
| TanStack `loader` with cache, `staleTime`, preload | declared route data, resolved concurrently, inherited by children | #18, #17 |
| SvelteKit single-flight mutations                  | `refreshed` values in the command reply, `stale` until settled    | #19, #17 |
| SvelteKit `withOverride`                           | query `override`, dropped by any authoritative value              | #19      |
| SvelteKit `form` without JavaScript                | `POST /actors/form`, `$command` hidden fields, 303                | #21, #41 |
| React and Octane streaming SSR                     | Placeholder, Patch, Closed records, `renderToStream`              | #22, #36 |
| SvelteKit `prerender`                              | `Route.prerender` with inputs                                     | #23, #38 |
| TanStack scroll restoration                        | `NavigationBehavior` Restore or Preserve                          | #31      |

## Band B: not in the design, and it matters

### B1. Commands as contracts, not only actor messages

SvelteKit has three server procedures: `query`, `command`, `form`. The frame has `query` and actor messages. A write that touches two actors, or no actor, has no contract. A "send an invite email" or "import a CSV" is a command with no mailbox.

Ask: `command("name", { args, result, policy, affects: [Contracts or queries] })` with a server implementation as an Effect. `affects` is the write-side twin of `depends`. The reply carries the single-flight refresh of every affected query. `form` becomes "a command with a field encoding" (B5), so #21 has one body under it.

### B2. Batching, or `View.list` makes N requests

`View.list` now lets every row open a query. SvelteKit `query.batch` groups same-tick calls into one request and hands the resolver an array. Without it, a list of 50 rows is 50 HTTP round trips.

Ask: a declared variant, not a transport trick. `Query.batched(contract, { resolve: (args[]) => Effect<(arg) => Result> })`. The client cache coalesces opens within one tick into one wire call. The contract says it is batchable, so the reader knows.

### B3. Typed links and typed navigation

The frame has `route.href(params, search)`, which is total and typed. The router takes a printed string. The implementation keeps that small boundary and composes typed links on top of it.

```tsx
const next = yield * link(Book, { id: "5" }, { q: "" });
const later = yield * link(Book, { id: "5" }, (previous) => ({ q: `${previous.q}x` }));
yield * next.go; // push
yield * next.replace; // replace
<Link link={later} replace>
  next
</Link>;
```

`link(route, params, search)` returns `{ href, active, go, replace }`. `href` is a live `Source<string>`, so a functional search link follows later URL changes. `go` and `replace` use the same URL updater as the anchor's normal click. `<Link>` renders a real anchor with `href` and `aria-current`; the delegated router listener leaves modified and middle clicks to the browser. `router.current` and `isActive(router, route)` are sources.

The #50 resolution rejects a `router.navigate(route, params, search)` overload. It duplicates `route.href(...)` and `link(...).go`, and it would make the router own route typing that already belongs to the route. The router keeps `navigate(href)` and `replace(href)` as its two operations. Intent preload remains out of scope until declared route data exists in #18.

### B4. Search params as state, with updaters and retention

egw-search wrote `toWorkspaceString` by hand and rebuilt the whole search record on every toggle. The route Schema now owns the URL spelling, including defaults, remapped keys, repeated values, and custom codecs.

```ts
const Search = Route.search(
  Schema.Struct({
    page: Schema.FiniteFromString.pipe(Route.withDefault(1)),
    pane: Schema.Array(Schema.String),
  }).pipe(Schema.encodeKeys({ page: "p" })),
);

const Book = Route.client("book", {
  path: "/books/:id",
  params: Schema.Struct({ id: Schema.String }),
  search: Search,
  retain: ["page"],
  view: BookView,
});
```

`href` omits values equal to `withDefault` and decoding fills them. `Schema.encodeKeys` keeps the decoded field name while changing the URL key. `Route.search` accepts only object fields that encode to strings or string arrays, and it prints fields in encoded Schema order. A custom `SearchRecord` codec remains valid; its emitted record order is kept for serializers such as a two-pane workspace.

The view receives `props.href(params, search)`, `props.updateSearch(update)`, and `props.replaceSearch(update)`. A functional update runs against the latest canonical URL when its queued operation executes. The router serializes URL computation, history mutation, and route publication, so concurrent updates do not overwrite each other. `updateSearch` pushes and `replaceSearch` replaces. A typed `link` accepts the same decoded value or updater. `retain` carries declared decoded keys across routes only when the caller omits them; an explicit caller value, including a default value that encodes to omission, wins.

Rate limiting has no router option. A view composes the source it navigates from with the time-based Source combinators in #57.

### B5. Fields: a form derived from a schema

SvelteKit `form.fields.title.as("text")` returns `name`, `value`, `aria-invalid`, and `issues()`. The frame has `bind` and `onInput` and nothing between them. Every input is wired by hand, and validation issues have no home.

Ask: `Form.make(command)` yields `{ fields, submit, issues, state }`. `fields.title.attrs` is a static props object. `fields.title.issues` is a `Source<ReadonlyArray<Issue>>` derived from the Schema decode. The command's arg Schema is the single source of the field set. `form.for(id)` is a `View.list` row.

### B6. Host node refs, portals, and focus

Solid has `ref`, React has `useRef`, both have portals. The frame cannot name a DOM node. Focus after navigation (#31), scroll into view, measuring, charts, and any third-party widget need one. Octane's `ReactCompat` and `OctaneCompat` show that interop is a node boundary; the frame has no boundary.

Ask:

- `View.node()` returns `{ attach, node }`. `attach` is a prop marker like `Prepared`. `node` is `Source<Option<HostNode>>`.
- `Portal` control: `<Portal into={node}>`, for modals and toasts.
- An `Island` control that hands a host node and a scope to foreign code and closes it with the scope. That is the interop story.

### B7. Route guards, redirects, and route-level boundaries

TanStack `beforeLoad` redirects before a route renders. `pendingComponent` and `errorComponent` with `pendingMs` avoid a flash. The frame's `RouteDefinition.view` is typed `View<…, never, R>`. A route whose setup fails has nowhere to go. #39 Auth needs protected routes and names no primitive.

Ask:

- `Route.client(name, { before: Effect<Continue | Redirect, never, R> })`. A typed outcome, run in the Transition before setup.
- `errored: (error: Source<E>) => Node` on the route, so `view` may be `View<…, E, R>`.
- `pending: { after: Duration, atLeast: Duration, node }` for declared data.
- `View.attempt(setup, fallback)` for a boundary inside a view tree. `View.list` rows carry `never` today, so each row handles its own errors with no helper.

### B8. Leaving guards and lazy views

TanStack `useBlocker` stops navigation with an unsaved draft. `lazyRouteComponent` splits code. The frame has neither. Both are small once named.

Ask: `Route.client(name, { leave: Effect<boolean, never, R> })`, asked in the Transition. `View.lazy(() => import("./page.js"))`, which is one `Effect.promise` inside a setup.

### B9. Sources that involve time or Effects

`select` and `zip` are synchronous. A typeahead needs debounce. An async validation needs a derived source that runs an Effect. Solid has `createResource`; the frame would route this through a query, which is wrong for a local computation.

Ask: `Source.debounce(source, duration)`, `Source.throttle`, and `Source.mapEffect(source, f)` that yields `Source<QueryState<B, E>>`, all scoped. The `Query` control then draws a local computation the same way it draws a server read.

### B10. Exhaustive control over a tagged union

`Show` with `is` narrows two ways. `Query` matches three fixed tags. A machine state with five tags needs five `Show`s or a `select` to a string.

Ask: `<Match on={state} cases={{ Idle: () => …, Running: (s) => …, Done: (s) => … }} />` over a `Source` of a tagged union, exhaustive at the type level. `Query` becomes `Match` over `QueryState`.

### B11. Inspection for agents

Explicit models pay off when the whole state can be printed. TanStack ships devtools. React ships devtools. For an agent, a text snapshot beats a panel.

Ask: `Frame.inspect: Effect<Snapshot>` with the mounted route and its params, every open query key with its state and age, every local actor with its revision, and the pending commands. A test asserts on it. A CLI prints it. The Effect spans already carry names; this is the read side.

### B12. Test doubles for the query host

Tests today drive a real host through the HTTP transport, or build `QueryState` by hand with `fakeQuery`. A view test wants a table of handlers and no wire.

Ask: `QueryCache.layerTest({ [contract.name]: (args) => Effect<Result> })` and `ActorTransport.layerLocal(host)`, so a view test names its data in the test.

## Band C: small, but people will ask

- `classList={{ on: source }}` or `class={bind(source, fn)}` is fine; document the idiom.
- A `Switch`-free `Show` chain reads well; keep it.
- `View.lazy` is in B8.
- Event modifiers (`stopPropagation`) are a `HostEvent` method; document them.
- Transitions and animation on enter or leave: out of scope until a proving example needs one.

## Where the frame is ahead, and should say so

- Explicit dependencies. A `Source` is a value. Octane needs a compiler to infer what a component reads. Solid needs a runtime to track it. The frame needs neither. This is the thesis and the docs should lead with it.
- Staleness by declaration. `depends` on a query and `affects` on a command (B1) make invalidation a printed graph. SvelteKit refreshes what the handler names at runtime. TanStack Query invalidates by key prefix. The frame can draw the graph before the app runs.
- One async vocabulary. `QueryState` is the shape of a server read, a local computation (B9), and a command reply. SvelteKit has `.loading`, `.error`, `.current` on some things and `.result` on others.
- Ownership by scope. Every subscription, fiber, and row dies with its scope. The other frameworks each have a "why is this still running" class of bug.
- Live data is an actor. SvelteKit `query.live` is an async generator with `reconnect()`. The frame says: if it changes on its own, it is an actor with a `changes` stream. One concept fewer.

## Suggested order

1. B6 refs and portals. Everything with focus or a widget is blocked on it, and #31 needs it.
2. B3 and B4 typed links, navigation, and search updaters. They make #36 land in a usable shape.
3. B1 command contracts, then B5 fields on top. This is #19 and #21 with one body.
4. B2 batching. It is the price of `View.list`.
5. B7 and B8 route boundaries and guards. #39 Auth cannot ship without B7.
6. B9 time-based sources and B10 `Match`. Both are one module each.
7. B11 inspection and B12 test doubles. Cheap once the above exist, and they are what makes the frame agent-friendly in practice.
