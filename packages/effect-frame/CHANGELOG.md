# effect-frame

## 0.28.0

### Minor Changes

- [`0cb0e0a`](https://github.com/cevr/effect-frame/commit/0cb0e0a0411fabafbc5f4445765866a1fae419b5) Thanks [@cevr](https://github.com/cevr)! - `View.bind(source, f)` paints in the same flush as the rest of its list. A `Bound` now keeps its source and its projection, and the runtime applies the projection where it draws, so a projected row item is read from the row as directly as the item itself. Before, `bind` stored `Source.select(source, f)`, which lost the row's direct read and repainted the row one scheduler turn after its siblings. The type `Bound<A>` changes shape: its `source` field is replaced by `open(read)`, which hands the source and the projection to `read`. `View.bind` is still the only way an app makes one.

- [`4f002a6`](https://github.com/cevr/effect-frame/commit/4f002a6a3d3388c4dc3ac5f8cac1662416ec3925) Thanks [@cevr](https://github.com/cevr)! - A segment and a branch hold their runtime under their brand, instead of in a module-level map beside the value. The brand's value type changes in the published declarations; its symbol is not public, so no call site changes.

- [`9ef269a`](https://github.com/cevr/effect-frame/commit/9ef269ae94906a3ce05c720bad6bed73151bc22f) Thanks [@cevr](https://github.com/cevr)! - `Route.Entered` carries what the router reads from a mounted route: `shell`, the last commit's shell, and `questions`, the leave checks it would ask for a candidate. The router no longer keeps them in a module-level map beside the value, and no longer invents a shell for a route it did not build.

- [`73daa4c`](https://github.com/cevr/effect-frame/commit/73daa4ca7fc38778518ec9d6c4bef1c06b0f0a1b) Thanks [@cevr](https://github.com/cevr)! - `View.errored`'s fallback reads a typed failure, `Source<Option<QueryFailure>>`, in place of `unknown`. `View.orErrored` routes a query state whose error is a `QueryFailure`, as every route read and cache entry carries; a `Source.load` state with its own error is drawn with `<Await>` or handled with `View.attempt`. A fallback narrows on `failure._tag` with no `Predicate.hasProperty` check.

- [`91c83f6`](https://github.com/cevr/effect-frame/commit/91c83f608c4064ee38e18ace4416fa1f6c3eca19) Thanks [@cevr](https://github.com/cevr)! - `View.event` and `View.submit` also take an Effect: a handler that reads no event is the Effect itself, run once per event. `onClick={View.event(addPane)}` replaces `onClick={View.event(() => addPane)}`. A handler that reads its event is written as before. What stays refused: a raw Effect, a raw function, or a raw `Source` in a prop, and an Effect whose error channel is not `never`.

- [`47dc02d`](https://github.com/cevr/effect-frame/commit/47dc02db3af09902331b8ccf37bc224188399cee) Thanks [@cevr](https://github.com/cevr)! - A failed refresh keeps the value it replaced. `QueryState.Failed` carries `last: Option<A>` beside `error`: `Some` of the value the entry held before the refresh failed, `None` after a first read failed or after `Unauthorized`. The state is still `Failed`, so `View.errored` still trips; `<Await failed={(error, last) => …}>` can draw `last`. `QueryState.Failed(error, last)` takes the held value, `QueryFailedState<A, E>` takes the value type, and `Source.load` shows a kept value stale while the next load runs. The wire is unchanged: a streamed failure seeds `None`.

- [`52e30dd`](https://github.com/cevr/effect-frame/commit/52e30dd36f1e09aae01926610440580d42131026) Thanks [@cevr](https://github.com/cevr)! - `<For>` takes an optional `fallback`, drawn while the list has no rows, as `<Show>`'s `fallback` is drawn while its branch hides: `<For each={tasks} keyBy={(task) => task.id} fallback={<li>no tasks</li>}>`.

- [`258a812`](https://github.com/cevr/effect-frame/commit/258a812e63bff432c40f350f131b949413772056) Thanks [@cevr](https://github.com/cevr)! - `View.form`'s `issues` is a `Source<ReadonlyArray<Form.FormIssue>>`, drawn with `<For each={add.issues} keyBy={(issue) => `${issue.field}:${issue.message}`}>`. A scripted submit that does not decode now shows the issues a plain post of the same input shows, where before it only logged a warning; a submit that decodes clears them. `View.form` now needs the view's `Scope`, which a view's setup has. A body that cannot nest, which a plain post answers 400, still sends nothing and logs.

- [`7b78fe3`](https://github.com/cevr/effect-frame/commit/7b78fe3ca6f9c756ff61799af74c41fb72239687) Thanks [@cevr](https://github.com/cevr)! - <!-- removed: HttpServer.WebHandler, Prerender.WebHandler, HttpTest.Handler -->

  The server edge speaks `HttpServerRequest` → `HttpServerResponse` from `effect/unstable/http`, and `effect` supplies both adapters. `HttpServer.make` returns an app, an Effect that answers the `HttpServerRequest` in context; the new `HttpServer.layer` mounts it on an `HttpRouter` at `prefix/*`, and `HttpEffect.toWebHandlerWith` (or `HttpRouter.toWebHandler`) serves it as a web `fetch`. `respondDocument(render, options)` takes `render` as `(url) => Effect<DocumentOutcome>`, reads the request's URL itself, and answers an `HttpServerResponse` whose body is a `Stream`; `onTimeout` answers an `HttpServerResponse`. `Prerender.serve` takes and returns an app; a HEAD's body is dropped by the web adapter. `HttpTest.client(app)` passes each client request to the app in process. `HttpServer.DerivePrincipal` and `HttpServer.readText` take an `HttpServerRequest` (cookies come parsed as `request.cookies`); `readText` still reads `request.stream` under the byte limit. `HttpServer.WebHandler`, `Prerender.WebHandler` and `HttpTest.Handler` are removed.

- [`7308437`](https://github.com/cevr/effect-frame/commit/730843725371ac2bdd276e0776d959d6f8804c8a) Thanks [@cevr](https://github.com/cevr)! - `LocalValueRef<A>` names the reference `Actor.local(Behavior.value(a))` returns: `LocalActorRef<A, SetValue<A>>`, with an optional `Refusal`. A prop that passes view state writes `draft: LocalValueRef<string>`, and `modify` takes it.

- [`c6d3d11`](https://github.com/cevr/effect-frame/commit/c6d3d11eb189d2e063211185a946a4700b3c441d) Thanks [@cevr](https://github.com/cevr)! - A local reference's `derive` and `modify` return a handle, as `send` does, and never fail. A stopped actor or a refusal is a `Rejected` state of that handle, so a view handler writes `View.event(modify(count, (n) => n + 1))` with no catch. A caller that needs the outcome reads `(yield* modify(ref, f)).settled`, which gives `Applied` or `Rejected`. `call` still fails with `ActorStopped` or the refusal: it asks for the reply, and a stopped actor has none.

  This corrects the 0.27.0 note on `Cell`'s removal: a local `send` after the actor's scope closed never failed; it gave a `Rejected(ActorStopped)` handle. Only `modify` failed, and now it does not.

- [`95b9a45`](https://github.com/cevr/effect-frame/commit/95b9a451bd2e92a620adb6e1f337ec349ac0f775) Thanks [@cevr](https://github.com/cevr)! - A browser `Location` carries its surface and its Back/Forward traversals on the value, under a symbol-keyed optional field of `LocationService` that is not public. A spread of a Location keeps them. A Location an app writes (a memory or test Location) does not change: the field is optional.

- [`b87236d`](https://github.com/cevr/effect-frame/commit/b87236d4c62694740e7c2d692312884c4c62b821) Thanks [@cevr](https://github.com/cevr)! - `memoryLocation(href)` from `effect-frame/router` is a `Location` held in memory, for a test or a terminal: `location` is the service, `current` the URL it holds, `history` every `push` and `replace` the router wrote, and `pop(href)` a Back or Forward move. The router's tests and the example apps' fixtures use it in place of a hand-built `LocationService`, and the fixtures read the app's own root id.

- [`8b0c3b3`](https://github.com/cevr/effect-frame/commit/8b0c3b35eb2ec60a46b8b41ff8d1f753eac1b353) Thanks [@cevr](https://github.com/cevr)! - Framework plumbing leaves the public namespaces of `effect-frame/actor/client` (and `effect-frame/actor`). No app or example used any of these; the view, router and post route import them by path.

  - `Wire` is no longer exported. A plain post goes to `endpoint` plus `/form`; the JSON verbs answer at `prefix` plus `/send`, `/call`, `/snapshot`, `/changes`, `/query` and `/query/batch`.
  - `Form` drops `FormMalformed`, `Tree`, `flatten`, `Fields`, `Structure`, `IssuesJson`, `frameworkFields`, `decode`, `withValues` and `without`. Decode a form body with `Form.codec(schema)`.
  - `Generated` drops `annotation`, `generationOf`, `memberNamed`, `drawFresh`, `membersOf`, `mint` and `mintAll`.
  - `Streaming` drops `ValueOutcome`, `ErrorOutcome`, `shell`, `declared`, `awaitDeclared`, `actorSeeds` and `settledPatches`.
  - `canonicalize` is no longer exported.

- [`dfb8891`](https://github.com/cevr/effect-frame/commit/dfb88911ca0194f7637def079de9c076782031e4) Thanks [@cevr](https://github.com/cevr)! - `Policy.forSubjects({ contracts, queries }, check)` is a rule over typed keys: it names the contracts and queries it reads, and `check` gets the subject's key or arguments decoded by that contract's or query's own codec. A subject it does not name, of another version, or whose key does not decode is refused. The types `PolicySubjects` and `PolicySubjectKey` name its input.

- [`dc9f354`](https://github.com/cevr/effect-frame/commit/dc9f354458ec4464de22249e0a69d4e0f542b0ab) Thanks [@cevr](https://github.com/cevr)! - A `<Portal>`'s `into` takes a `PortalTarget`, which only a host module makes: `Dom.target(element)` in the browser, `target(renderable)` from `effect-frame/view/opentui` in a terminal. A host draws only into a target it made. The HTML and Remote hosts make none, so a Portal in a server render or a driven view is now a defect, `View.PortalTargetRefused`, that names the drawing host and the host that made the target. Before, the HTML host drew nothing and said nothing. Write `<Portal into={Dom.target(document.body)}>` where `<Portal into={document.body}>` was written. A custom host that draws a Portal adds a `portal` member (`PortalHost`) that resolves the targets it made.

- [`5da306a`](https://github.com/cevr/effect-frame/commit/5da306aec21cd8295ca791afd192c5302cea960c) Thanks [@cevr](https://github.com/cevr)! - `router.push` and `router.replace` answer a `NavigationResult` (exported from `effect-frame/router`): `Committed` with the final URL after any redirect, `Unchanged` when nothing moved (a same-URL request, a redirect back, a stale route instance, a superseded prompt), or `Stayed` when a leave check kept the page. A mounted route's own `Route.RouteNavigation` answers the same way. A request to a router that has closed is interrupted instead of succeeding with nothing: it reached no result. The test-only receipt table the router kept beside each service is gone.

- [`0a6eaae`](https://github.com/cevr/effect-frame/commit/0a6eaae959d1055047fb304b7d795a945da64874) Thanks [@cevr](https://github.com/cevr)! - A refused plain post is redrawn by the router. `renderDocument` writes the
  refusal's issues after the document's `tail` when `Form.FormContext` is
  present, and the new `redrawDocument(render)` turns a document render into
  the form route's `render`, failing with `DocumentRedirected` on a redirect.
  `FormRoute.render` now takes the page `URL`, resolved against the posting
  request's own origin, instead of a path. Replace a hand-written redraw with
  `render: redrawDocument(renderPage)`, and drop the issues script from the
  document's `tail`.

- [`90ec90d`](https://github.com/cevr/effect-frame/commit/90ec90d47ea041b6a9480329646def6f41c585e1) Thanks [@cevr](https://github.com/cevr)! - A route value carries its checks, and a copy of it keeps them. Before, a spread of a route whose segment had `before` (`{ ...route, enter }`) mounted without its checks: a guarded page became an unguarded one. `Route.AnyRoute` gains a symbol-keyed field for the checks, a `Route.prerender` tree carries its build plan the same way, a `Route.driven` tree its driven-leaf resolver, and a `Route.inputs` value its enumeration. None of the symbols is public, so no call site changes.

- [`2477fdc`](https://github.com/cevr/effect-frame/commit/2477fdc19649b583f71ff8de259dabf7d5f3bd7e) Thanks [@cevr](https://github.com/cevr)! - `RouteMatch` carries `segments`, the matched route's segments (empty on not-found), and a route value carries its `segments`. A segment link's `current` reads the match: a segment is current only while a route that holds it is matched. Before, the check was a module-level table from each segment to the names of the trees that held it, filled at every mode constructor and never cleared, so a tree built elsewhere with the same name made an unmounted segment current.

- [`52b4f3e`](https://github.com/cevr/effect-frame/commit/52b4f3e1f446b87263fef1b5549b0d717272a901) Thanks [@cevr](https://github.com/cevr)! - A view's `pushSearch` and `replaceSearch` take a value or an updater of the latest search, as a `UrlState`'s `push` and `replace` and a link's search do: `props.replaceSearch({ filter: "open" })`. The one change shape is `Route.SearchChange<Search>`; the type `LinkSearch` is gone, so write `Route.SearchChange`.

- [`0925399`](https://github.com/cevr/effect-frame/commit/0925399f61af3f6887d74e4febccf11658b3456c) Thanks [@cevr](https://github.com/cevr)! - `Source.zip(a, b)` gives the pair, `Source<readonly [A, B]>`, as `Effect.zip` does. The combining form is `Source.zipWith(a, b, f)`: write `Source.zip(a, b, f)` as `Source.zipWith(a, b, f)`. The README has a table of the `Source` combinators.

- [`bbb277f`](https://github.com/cevr/effect-frame/commit/bbb277f2058c4c810b43e44107d78cbc457795b6) Thanks [@cevr](https://github.com/cevr)! - Add `View.show({ when, content, fallback? })` and `View.match(on, cases)`: a branch whose content runs a setup. The setup runs each time the branch is shown, and its scope closes when the branch hides, so a hidden branch holds no actor, follows no query and observes no source. `View.match` takes one setup per tag and is exhaustive, as `<Match>` is; a new value under the same tag reaches the case through its source without running the setup again. Both are built on `View.keyed`.

### Patch Changes

- [`06804f1`](https://github.com/cevr/effect-frame/commit/06804f1384e9179f51bebd953f0b3792cdd97f4b) Thanks [@cevr](https://github.com/cevr)! - An annotated `Route.search` codec keeps its keys. `Route.search(S).annotate({ title })` made a new Schema value that the codec's key table did not know, so the segment's keys became unknown, `UrlState.make` refused it as opaque, and `retain` lost its fields. `Route.search` now records its fields as a Schema annotation, which `.annotate()` keeps.

- [`4dce3a4`](https://github.com/cevr/effect-frame/commit/4dce3a4d11864a4ea1ae52f514468e1b9dc4d1fb) Thanks [@cevr](https://github.com/cevr)! - Every `@example` in the JSDoc is now a region of a compiled file, and five that no longer compiled are corrected: `Actor.remote` and `Actor.remoteCommands` take the contract's key struct, `Generated.send` takes the decoded message, `implementTransparent`'s example uses the counter's own behavior, and a `before` check calls its sign-in read with the tenant. The internal form decoder's example, which showed a call no app can make, is gone.

- [`66ca7a9`](https://github.com/cevr/effect-frame/commit/66ca7a919707aa865c521da9f8f6ded1894d141e) Thanks [@cevr](https://github.com/cevr)! - A Portal that a `Show`, `Match`, `View.show`, or `For` reveals after mount no longer halts reactivity. When the drawing host refused its target, the build threw inside Solid's flush: every later signal write in the process was dropped, and the branch's scope never closed. The refusal is now reported to the mount instead: the Portal draws nothing, and the mount's scope closes with the `View.PortalTargetRefused` defect. A refusal in the first build still fails `View.mount` with that defect.

- [`a71b92e`](https://github.com/cevr/effect-frame/commit/a71b92e8e1f5d1a7b08032dd2bcb2ff903c1026d) Thanks [@cevr](https://github.com/cevr)! - A prerender cleanup that fails logs a warning instead of dropping the failure silently: the build lock, a failed build's staging directory, an uncommitted pointer or generation, a lease, and older generations each name what was not removed. The build's result is unchanged.

- [`c51f860`](https://github.com/cevr/effect-frame/commit/c51f860aafeb6e33f0949b5b6f96542fe4f686e3) Thanks [@cevr](https://github.com/cevr)! - A prerender build writes each page, the client and the manifest uninterruptibly. Before, an interrupted or failed build could leave a staging directory behind: a page write that the build interrupted ran on in the platform and made the directory again after the staging was removed.

- [`fa4621d`](https://github.com/cevr/effect-frame/commit/fa4621d58af989d71d9ac39ce1f3a5e3c681a254) Thanks [@cevr](https://github.com/cevr)! - A row's or branch's setup that dies is no longer dropped. The setup of a `For` row, a `View.list`, `View.keyed`, `View.show` or `View.match` branch, or a route's view in an outlet runs on a fiber that nothing joined, so a defect in it left the row empty and reached no one. It now goes where a refused Portal goes: in the first build `View.mount` fails with it, and after mount the mount's scope closes with it, so the view's owner sees the defect and the rest of the process keeps running. A route whose `pending` fallback is showing hands its setup's defect to the mount the same way. A setup interrupted because its row left or its branch hid is not a defect and leaves the mount open.

- [`0a7b584`](https://github.com/cevr/effect-frame/commit/0a7b584d43a1d79f0a46026d8b90de63e1baed56) Thanks [@cevr](https://github.com/cevr)! - A layout entered under a `View.loading` that already shows its content draws again when its first read is still in flight. The layout's setup runs as a row of its parent's outlet, and its unsettled `View.ready` holds the boundary from inside that setup. The hold writes a signal, and the runtime ran the setup's synchronous part inside the row's Solid owner, so Solid's development build refused the write: the row died, the outlet stayed empty, and nothing was reported. The runtime now runs every Effect it starts (a row's setup, an event handler, a behaviour) outside Solid's owners; a build re-enters its own owner by name, and the place mark a hold leaves is made under the boundary's owner.

## 0.27.0

### Minor Changes

- [`5abcc5a`](https://github.com/cevr/effect-frame/commit/5abcc5ae5f22550563e74e42813eb41e5e428e7d) Thanks [@cevr](https://github.com/cevr)! - Exports with no caller, or with a second path to a used name, are removed:

  - `effect-frame/actor/client`: `isQueryFailure`, and the flat `FormContext`, `FormFields`, `FormIssue` and `FormIssues`. Write `Form.FormContext` and the other `Form.*` names.
  - `effect-frame/actor`: the flat `batched` (write `batchedQuery`), `queryServerOnly`, `MissingPolicy` (read it from `PolicyNamesMissing.missing`), and the types `QueryHostOptions` and `QueryServing`, whose producer is not public.
  - `Behavior.wakeOf` and `Behavior.refusalOf` are internal. `Behavior` holds what an author writes: `value`, `reducer`, `machine` and the types.

- [`2dc0c06`](https://github.com/cevr/effect-frame/commit/2dc0c0624e8b4b089383002e83589976d7060b44) Thanks [@cevr](https://github.com/cevr)! - `ActorHost.layer` and `ActorHost.make` require `store`. Omitted, the host used to give every actor a fresh in-memory store, so a production host that forgot it lost durability with no error. Pass `store: ActorHost.memoryStore` for a test, or for a host that keeps nothing across a restart. `ActorHost.layerMemory(implementations, queries)` is removed: write `ActorHost.layer({ implementations, queries, store: ActorHost.memoryStore })`.

- [`85e3518`](https://github.com/cevr/effect-frame/commit/85e35184badadc8666f31d3b37340e41336a2fd7) Thanks [@cevr](https://github.com/cevr)! - Placement is named at the call, after the `kind` the reference carries: `Actor.local`, `Actor.remote`, `Actor.remoteCommands`, and, on the server entry, `Actor.durable`.

  - `spawn(behavior)` is `Actor.local(behavior)`. A view's own state is `Actor.local(Behavior.value(initial))`.
  - `ref(contract, key, options)` is `Actor.remote(contract, key, options)`.
  - `commandRef(contract, key)` is `Actor.remoteCommands(contract, key)`.
  - `durable(options)` is `Actor.durable(options)`, from `effect-frame/actor` only: the browser entry's `Actor` has no `durable`, because a browser bundle never carries a store.

  The span names follow: `Actor.local`, `Actor.remote`, `Actor.remoteCommands`, `Actor.durable`.

- [`e7f503a`](https://github.com/cevr/effect-frame/commit/e7f503ae56b6d9a5ecf13a57807af8267829a55f) Thanks [@cevr](https://github.com/cevr)! - `attachGateway` returns `{ status }`, a `Stream` of `AttachStatus`, in place of the `onStatus` callback. It takes a required `retry: Schedule` and `openTimeout: Duration.Input` in place of `initialRetryMillis`, `maxRetryMillis` and `openTimeoutMillis`; `defaultRetry` (250 ms doubling to 5 s) and `defaultOpenTimeout` (2 s) name the old defaults. A schedule that ends stops the attachment with a new `Stopped` status.

- [`3246027`](https://github.com/cevr/effect-frame/commit/32460271c337cc84481b2c9e717a8b90333592ef) Thanks [@cevr](https://github.com/cevr)! - `Cell` is removed. A view's own state is a local actor: `Actor.local(Behavior.value(initial))`. Read it with `ref.state`, write it with `ref.send(Value.Set(next))` or `modify(ref, (value) => next)`. Unlike a cell, a write after the actor's scope closed fails with `ActorStopped`; a handler that can outlive its view catches it by name.

- [`b4bdbea`](https://github.com/cevr/effect-frame/commit/b4bdbeaa5083e4b106b0612082bbe86825d5c3ea) Thanks [@cevr](https://github.com/cevr)! - Delete `QueryTest`, `QueryCache.layerTest` and `ActorTransport.layerLocal`. A test writes the production wiring: `Layer.merge(QueryCache.layer, ActorHost.layer({ implementations, queries, store: ActorHost.memoryStore }))`, or `Layer.effect(ActorTransport, host)` for a hand-built transport.

- [`0277d0c`](https://github.com/cevr/effect-frame/commit/0277d0c691c1c334e5a76b7374a635bbdaeade5a) Thanks [@cevr](https://github.com/cevr)! - `Html.Document` takes a required `rootId`, and the renderer writes the mount element (`<div id="…">`) around the drawing; `head` now ends before it and `tail` starts after it. `Dom.root(id)` finds that element in the browser or fails with the new `Dom.RootNotFound`. A server document and a browser entry name the id once and import it.

- [`b785156`](https://github.com/cevr/effect-frame/commit/b7851566423c57245f25a2308c9c2bbada048f7c) Thanks [@cevr](https://github.com/cevr)! - `Route.drivenView` returns a `Route.DrivenView`: a view tagged
  `"DrivenView"` that carries its drive and view. `Route.driven` reads the
  drive off the value a leaf was given instead of looking the function up in
  a hidden module-level WeakMap. A view wrapped around a `DrivenView` is a
  plain view, and `Route.driven` refuses its leaf with `BranchRejected`, as
  before.

- [`5b4c991`](https://github.com/cevr/effect-frame/commit/5b4c99198c71f918e063a5182d19bdfe15dab181) Thanks [@cevr](https://github.com/cevr)! - A `Loading` with no registration now shows its content. It has nothing to wait for. Before, it showed its fallback until a first read registered, so a `Loading` around content that reads no query never drew that content, and the router registered a settled read on behalf of a failed or still-preparing segment to work around it. That workaround is gone. A read that registers later, unsettled, still puts the boundary back in its fallback before the registering view writes: a keyed row that sets up after mount may show the rest of the content first.

- [`b897620`](https://github.com/cevr/effect-frame/commit/b897620d5a17629cfc6e00b29d6e02a370591439) Thanks [@cevr](https://github.com/cevr)! - A form body has one decode, and `View.form` proves at compile time that the post can decode.

  - `Form.decode(schema)(fields)` strips the framework fields, nests the rest and decodes the message. `HttpServer.form` and a scripted `View.form` submit both run it. A body that cannot nest fails with `FormMalformed` (the route answers 400, as before); one that does not decode fails with the schema's error (the route redraws the page with its issues, as before).
  - `View.form`'s `message` must be one of the contract's own members (one schema of its union, or one variant of its machine event schema), not a copy with the same type: the post decodes with the contract's schema. A copy whose `Type` matches but whose encoding differs (`Finite` where the member has `FiniteFromString`) no longer compiles.
  - `View.form`'s `message` must have a form encoding (`Form.Codable`): a member with a field that does not encode to strings, or a boolean with no decoding default, no longer compiles. It used to compile and refuse every post at run time.

- [`b5a889a`](https://github.com/cevr/effect-frame/commit/b5a889a09ac7e159fb8f8f585d6d20db62422a38) Thanks [@cevr](https://github.com/cevr)! - `HttpTransport.layer` reads through the `HttpClient` in context
  (`effect/unstable/http`) instead of a Promise `fetch` that defaulted to
  `globalThis.fetch`. Its type is now
  `Layer<ActorTransport, never, HttpClient>`: a browser or server writes
  `.pipe(Layer.provide(FetchHttpClient.layer))`. An interrupted call aborts
  its request, and a `changes` stream aborts its connection when it ends.
  `HttpTransport.Fetch` and `HttpTransport.FetchLike` are removed.

  New: `HttpTest.client(handler)` from `effect-frame/actor/testing`, an
  `HttpClient` whose requests go straight into a web handler such as the one
  `HttpServer.make` builds, so a test crosses the real wire with no socket.

- [`0b64f8d`](https://github.com/cevr/effect-frame/commit/0b64f8d2923e43500033c5b82bf4fc9d22f998be) Thanks [@cevr](https://github.com/cevr)! - `hydrate` reads the issues of a refused plain post that the document carries (`Form.issuesScriptId`) and provides them to the first render. A routed app calls `hydrate({ routes, notFound, root, landing, traversalReadLimit })` and writes no page-load sequence of its own.

- [`d03dbe0`](https://github.com/cevr/effect-frame/commit/d03dbe0af34bd38375cafb3380a6b68bc43a2dd2) Thanks [@cevr](https://github.com/cevr)! - `Protocol.maxDeadlineMillis` and `Protocol.loopbackHosts` name the deadline bound and the loopback hosts. `Protocol.DeadlineMillis` is built from the bound; the attachment and the inspect reader read the hosts from it.

- [`e57471d`](https://github.com/cevr/effect-frame/commit/e57471d876516635d7fc64b757833de7104cc4f3) Thanks [@cevr](https://github.com/cevr)! - `View.lazy` returns a `LazyView<P, E, R>`: a View tagged `"LazyView"` that
  carries its import definition. A route reads the definition off the value
  it was given instead of looking the function up in a hidden module-level
  WeakMap. The `LazyView` type is exported from `effect-frame/view`. Hand a
  route the `LazyView` itself: a view wrapped around it is a plain View,
  and imports at setup.

- [`4e5c9fb`](https://github.com/cevr/effect-frame/commit/4e5c9fb0599b61b5bd1662b4539494173bad85f9) Thanks [@cevr](https://github.com/cevr)! - `link(to, params, search)` accepts a `Source` of params as well as fixed
  params (`LinkParams<Params>`). A layout that outlives a param move passes
  `props.params`, so its links print and move with the params it holds now.
  Before, a layout's links kept the tenant they were drawn with after a
  tenant switch. The dashboard's header and range links now follow
  `props.params`.

- [`91bd13a`](https://github.com/cevr/effect-frame/commit/91bd13afcc4b6e124d86970ba640587996276a91) Thanks [@cevr](https://github.com/cevr)! - `mount` and `hydrate` require `landing` and `traversalReadLimit`. The router no longer defaults to `NavigationBehavior.Restore` and 3 seconds behind the caller's back: `mount({ routes, notFound, host, root, landing: NavigationBehavior.Restore, traversalReadLimit: "3 seconds" })`.

- [`30a2261`](https://github.com/cevr/effect-frame/commit/30a2261e89269a4892ebf3b5cd6884ca946afa87) Thanks [@cevr](https://github.com/cevr)! - The actor host has one HTTP handler, and every edge decision is written at
  its call.

  - `HttpServer.make({ prefix, principal, maxBodyBytes, form })` serves the
    JSON verbs, `changes`, and the plain-form route. Each verb answers at
    exactly `prefix + Wire.paths.*` (a path that only ends in a verb is a
    404), so an app hands it every path under the prefix unchanged instead
    of stripping the prefix. The principal is derived once per request for
    every route.
  - `maxBodyBytes` is required. A body over it answers 413 before it is
    decoded, whether its length is declared or streamed.
    `HttpServer.defaultMaxBodyBytes` is one MiB. `HttpServer.readText`,
    `HttpServer.BodyTooLarge` and `HttpServer.BodyUnreadable` are the
    bounded reader, for a host that reads a body itself.
  - `form` is `Option.some({ contracts, login, render, commitWithin })` or
    `Option.none()`. `commitWithin` is required;
    `HttpServer.defaultCommitWithin` is ten seconds.
  - Removed: `HttpServer.form` and `HttpServer.FormPostOptions` (the `form`
    option replaces them; its type is `HttpServer.FormRoute`), and
    `HttpServer.toWebHandler` (build the handler with `HttpServer.make` in
    the runtime that holds the host).
  - `renderDocument` requires `principal`: every check and query the render
    reads runs under it, where it used to read an ambient `CurrentPrincipal`
    that defaulted to `Anonymous`.
  - New: `respondDocument(render, { onTimeout })` answers one page request.
    It owns the render's Scope, answers a redirect with 303 (path and
    search), a document with its status, a timeout with `onTimeout`, and a
    defect with 500, and closes the Scope on every exit but a returned body.

- [`3081ad0`](https://github.com/cevr/effect-frame/commit/3081ad013830f6d5cd4d940e687ce079074f30d2) Thanks [@cevr](https://github.com/cevr)! - `Link` and `followLinks` share one plain-click policy, so a `Link` click
  leaves the same cases to the browser as a plain anchor does: a modified or
  middle click, `target="_blank"`, a download, another origin, and a link
  that only changes the current page's fragment. `Link` no longer writes
  `data-frame-replace`, and `followLinks` no longer reads it: a plain anchor
  always pushes, and a move that replaces is a `Link` with `replace`.

- [`6beeebd`](https://github.com/cevr/effect-frame/commit/6beeebd9469c8ff00054bdf80132209f61a0e802) Thanks [@cevr](https://github.com/cevr)! - Each exported value has one path. `bun run declarations` now also fails when one value is exported flat and as a namespace member, or under two names.

  - `Value` (and the `SetValue` type) is a flat export of `effect-frame/actor/client` only; `Behavior.Value` is removed. `Behavior` holds what builds a behavior: `value`, `reducer`, `machine`, and their types.
  - `UrlStateConflict` and `UrlStateSchemaRejected` are `UrlState.UrlStateConflict` and `UrlState.UrlStateSchemaRejected` only; the flat exports of `effect-frame/router` are removed.

- [`6f61bf2`](https://github.com/cevr/effect-frame/commit/6f61bf233198a939ac8c821d59a1de2ee8ffb5dc) Thanks [@cevr](https://github.com/cevr)! - `QueryCache.layer` provides its command ownership and streamed-document access as a second, private service in Context instead of module-global WeakMaps. A custom or wrapped `QueryCache` owns no command's dependents: it is no longer invalidated when a command starts.

- [`de8c041`](https://github.com/cevr/effect-frame/commit/de8c0418cead37579a36d8a99c6c072249b54f8c) Thanks [@cevr](https://github.com/cevr)! - `query` and `batchedQuery` require `version` and `depends`, as `contract` requires its `version`. `version` used to default to 1 and `depends` to none, so a forgotten `depends` compiled and no commit ever marked the query stale. Write `version: 1` and `depends: []` where you meant the old defaults.

- [`7221d25`](https://github.com/cevr/effect-frame/commit/7221d25638871d3c770c6a910afa1856110becdb) Thanks [@cevr](https://github.com/cevr)! - One path to read a query from each place. A view reads a query through its route (`Route.query`); other code follows one with `followQuery` or reads it once with `runQuery`.

  - `useQuery` is removed. It was a pass-through to the cache's `open` under a React hook name. Code that needs the raw entry writes `QueryCache.use((cache) => cache.open(contract, args))`.
  - The flat `queryCacheLayer` is `QueryCache.layer`.

- [`9950cbf`](https://github.com/cevr/effect-frame/commit/9950cbf96b16cef16dfbffbfd9d7df8f61633949) Thanks [@cevr](https://github.com/cevr)! - `QueryState` has one owner, `effect-frame/actor/client`, and one path: `QueryState.Loading()`, `QueryState.Ready(value, stale)`, `QueryState.Failed(error)`, `QueryState.isLoading/isReady/isFailed` and `QueryState.match`.

  - The flat `Loading`, `Ready`, `Failed`, `isLoading`, `isReady`, `isFailed`, `match` and `markStale` exports of `effect-frame/actor` are removed. Write `QueryState.Ready(value, false)`.
  - The `QueryState` namespace of `effect-frame/view` is removed: its schemas, `loading`/`ready`/`failed` constructors (with the hidden `stale = false`), `hasValue` and `held` had no caller. Its test fake is `ViewTest.fakeQuery(initial)`, and it takes its initial state explicitly: `ViewTest.fakeQuery(QueryState.Loading<string, never>())`.

- [`0fa9509`](https://github.com/cevr/effect-frame/commit/0fa9509589aa6c0eb598169f020d1e3c34322af1) Thanks [@cevr](https://github.com/cevr)! - A remote reference carries its address. `RemoteActorRef` and `RemoteCommandRef` have `contract` and `key`, the ones they were opened for.

  - `View.form` takes `ref` and no `contract` or `key`: the plain post's `$contract`, `$version` and `$key` come from the reference, so the post and the scripted send can never name two actors. A command-only reference (`Actor.remoteCommands`) is enough.
  - `Generated.send(ref, contract, input)` is `Generated.send(ref, input)`.

- [`c3d9917`](https://github.com/cevr/effect-frame/commit/c3d9917d684d9431a5cbe675e5d0933dde65295e) Thanks [@cevr](https://github.com/cevr)! - A `Route.actor` binding has the query binding's shape: `props.data.x` is `Route.FollowedActor<C>`, `{ ref, state }`. `ref` is the `Source<RemoteActorRef<C>>` the binding used to be, and `state` follows the reference the route holds now, across key moves. Sends still name the reference: `props.data.x.get` becomes `props.data.x.ref.get`, and `Source.switchMap(props.data.x, (r) => r.state)` becomes `props.data.x.state`.

- [`f4164cd`](https://github.com/cevr/effect-frame/commit/f4164cdfcc70d79300267e2a39a07428084fe6d4) Thanks [@cevr](https://github.com/cevr)! - Add `Route.commandRef(contract, key)`: a send-only route declaration. The transition opens it with `Actor.remoteCommands`, moves it with the segment's params, and releases it like a `Route.actor`, but it reads no snapshot and follows no stream. The binding is `Route.FollowedCommands<C>`, `{ ref: Source<RemoteCommandRef<C>> }`: `Effect.flatMap(props.data.book.ref.get, (book) => book.send(message))`.

- [`8fe53eb`](https://github.com/cevr/effect-frame/commit/8fe53eb8f2ba2f60c1b797b9cbde155789a8c06c) Thanks [@cevr](https://github.com/cevr)! - `Route.Entered` carries `inspection`, the deepest mounted segment's decoded
  params and search (`Route.EnteredValues`). The router reads it off the
  mounted route instead of a module-level WeakMap, and the "inspection
  unavailable" fallback is gone: every route a mode constructor makes has one.

- [`8ccecb8`](https://github.com/cevr/effect-frame/commit/8ccecb8ebe122b6558499aabb9c5b384c7fab7b8) Thanks [@cevr](https://github.com/cevr)! - The navigation option is `landing`, not `behavior`: `Route.leaf(segment, view, { landing: NavigationBehavior.Preserve })` and `mount({ ..., landing })`. `behavior` on the route surface now means only an actor's reducer (`Route.actor(contract, key, { behavior })`).

- [`90368a2`](https://github.com/cevr/effect-frame/commit/90368a25a0a87004060ee5edbb1272b779f0bb84) Thanks [@cevr](https://github.com/cevr)! - The router's `Match` type (which route the document is on, and its URL) is renamed `RouteMatch`, so it never meets the view's `Match` tag in one file. `bun run declarations` now also fails when two published subpaths export one value name, apart from the declared re-exports (`actor` over `actor/client`, and the two JSX runtimes).

- [`d46866c`](https://github.com/cevr/effect-frame/commit/d46866c2d17e3a0f0d7441ccf2b9f90c261983ef) Thanks [@cevr](https://github.com/cevr)! - A route is a branded value only the mode constructors make, and it carries its own rendering mode; a hand-written `AnyRoute` no longer type-checks. `mount` and the server document die with `Route.RouteNameRejected` when two routes share a name or one is named `"not-found"`, the router's own route (a user route named `"not-found"` used to be served). `isActive` is deleted: `link(to, params, search).active` says whether the document is on a destination.

- [`fb695a0`](https://github.com/cevr/effect-frame/commit/fb695a07885a3d0857953991531c769c6945d1f5) Thanks [@cevr](https://github.com/cevr)! - The router's types have one export path, under `Route`: import `Route.AnyRoute`, `Route.PathRecord`, `Route.SearchRecord`, `Route.Entered`, and the rest from the namespace; the flat duplicates on `effect-frame/router` are gone, with `searchKeysOf`, `UrlStateOptions`, `UrlStateState`, and `RouteLink` (use `UrlState.Options`, `UrlState.State`, and `Link`). `Route.printPath`, `Route.mergeSearchRecord`, `Route.searchKeysOf`, `Route.SearchSchemaRejected`, `Route.SegmentProps`, and `Route.LayoutProps` are no longer exported: type a view's props with `Route.PropsOf<typeof segment>` or `Route.LayoutPropsOf<typeof segment, ChildR>`. `Route.printSearch` stays, as `Route.readSearch`'s inverse for an opaque search codec.

- [`4e766f9`](https://github.com/cevr/effect-frame/commit/4e766f937052dd2abbed09771927c807b3873bc8) Thanks [@cevr](https://github.com/cevr)! - The flat route form is removed. Every rendering-mode constructor (`Route.client`, `Route.ssr`, `Route.streamed`, `Route.awaitAll`, `Route.prerender`, `Route.driven`) takes a root segment's branch only. A one-page route is a tree of one leaf:

  ```ts
  const login = Route.segment("login", { path: "/login" });
  const Login = Route.client("login", Route.leaf(login, LoginView));
  ```

  Link and print through the segment (`link(login, …)`, `login.href(…)`), not the route. `Route.Route`, `Route.RouteDefinition`, `Route.DrivenDefinition`, `Route.PrerenderDefinition`, `Route.DrivenConstructor`, and the flat `RouteOf` and `RouteDefinition` exports are gone. A flat `behavior` field is the leaf's `landing` option; a flat prerender's `inputs` is `{ inputs: [Route.inputs(segment, enumerate)] }`.

- [`6b32f4c`](https://github.com/cevr/effect-frame/commit/6b32f4cf1f208e86eb7889e83f0201b23dbf8b3c) Thanks [@cevr](https://github.com/cevr)! - A segment's params follow its template. The `params` codec must encode exactly the names the segment's own template declares (`Route.ParamNames<Path>`); a misnamed, missing, or extra param does not compile. A child declares only its own params and inherits its ancestors': `Route.child(tenant, "post", { path: "posts/:postId", params: Schema.Struct({ postId: Schema.String }) })` sees `{ tenant, postId }`. `params` is optional when the template declares none. Migrate by dropping every ancestor param a child restates, and `params: Schema.Struct({})` where the template has no param.

- [`7908e9b`](https://github.com/cevr/effect-frame/commit/7908e9b2de7aee1604f870bc3647299de14ce1f3) Thanks [@cevr](https://github.com/cevr)! - Every router move is named `push` or `replace`. `RouterService.navigate` and
  `Receipts.navigate` are now `push`. A `Link`'s `go` is now `push`. A view's
  `updateSearch` is now `pushSearch`, beside `replaceSearch`. `UrlState`
  drops `set`, `update`, `push.set`, and `push.update` for `push(change)` and
  `replace(change)`, where a change is a value or an updater of the latest
  value (`UrlState.Change<A>`). `UrlState.make(codec, { keys })` is now
  `{ searchKeys }`.

- [`d4c6651`](https://github.com/cevr/effect-frame/commit/d4c6651493ad68f7d22aa9108e3598b009ee15dc) Thanks [@cevr](https://github.com/cevr)! - `Route.redirect` takes its destination directly, as `link` does: `Route.redirect(segment, params, search)`. `Route.target`, `Route.Target`, and `Route.Printable` are removed, and `Route.Redirect` carries the printed `href`. `Route.Linkable`, the one destination type, gains `href`.

  Add `Route.redirecting(name, segment, to)`: a route that only redirects. It has no view and no rendering mode; `to` receives the candidate's params, search, URL, and kind, and answers the `Route.redirect`. The segment's own `before` runs first.

  ```ts
  const home = Route.segment("home", { path: "/", params: Schema.Struct({}) });
  export const Home = Route.redirecting("home", home, () =>
    Effect.succeed(Route.redirect(lists, {}, {})),
  );
  ```

- [`3ced983`](https://github.com/cevr/effect-frame/commit/3ced9830216eea87919d1a79f58208bd9a95dc8d) Thanks [@cevr](https://github.com/cevr)! - An open readiness scope is a compile error where a view's services are
  final, named by its fix. `View.mount`, `Html.renderToString`,
  `Html.renderToStream`, `Html.renderAwaitAll`, `Remote.draw`,
  `Remote.client`, `Driven.session`, a router's `notFound` view, and every
  `Route` mode constructor (`client`, `ssr`, `streamed`, `awaitAll`,
  `prerender`, `driven`) take `View<P, E, R> & ScopesClosed<R>`. A
  `View.ready` with no `View.loading` above it reports
  `Property '"View.ready needs a View.loading above it"' is missing`, and a
  `View.orErrored` with no `View.errored` above it names that pair, at the
  call, instead of surfacing as `LoadingScope` where the application provides
  its layers. The `ScopesClosed<R>` type is exported from
  `effect-frame/view`; a generic helper that forwards a view to `View.mount`
  states it on its own parameter.

- [`5e870eb`](https://github.com/cevr/effect-frame/commit/5e870eb1b37d8fd7dea624166c121ec6153616b9) Thanks [@cevr](https://github.com/cevr)! - `Source.select`, `Source.debounce` and `Source.throttle` take the source first and have one signature. The data-last forms (`select(project)(source)`) are gone. With two overloads, an inline `select` in a JSX prop that was still being inferred resolved against `Source<readonly unknown[]>`, so `<For each={select(state, (s) => s.items)} keyBy={(item) => item.id}>` read `item` as `unknown`. It now infers the item, and `keyBy` needs no annotation.

- [`b3fa068`](https://github.com/cevr/effect-frame/commit/b3fa0681f0830ceeb69582208d1bdf9fba365ce1) Thanks [@cevr](https://github.com/cevr)! - The server half of an actor or a query takes one shape: the contract, then an options object.

  - `implementTransparent(contract, behavior)` is `implementTransparent(contract, { behavior })`.
  - `implementQuery(contract, handler)` is `implementQuery(contract, { run })`.
  - `Query.batched(contract, { resolve })` is `implementBatchedQuery(contract, { resolve })`. The one-member `Query` namespace is removed.
  - `query.batched(name, options)` is `batchedQuery(name, options)`: a plain function, not a namespace merged onto `query`.

- [`45b131b`](https://github.com/cevr/effect-frame/commit/45b131b02c777d4ee1525a36b68691ec8cc13b7b) Thanks [@cevr](https://github.com/cevr)! - `HttpServer.sessionBuffer` and `HttpServer.SessionBuffer` are removed. The
  shared session subscription still keeps the latest revision only
  (capacity 1, sliding, replay 1); the buffer is written at the one
  `Stream.share` that uses it.

- [`7925794`](https://github.com/cevr/effect-frame/commit/7925794f60a5e337916cb1008533ecec7a1b7eda) Thanks [@cevr](https://github.com/cevr)! - `Frame.CommandLifecycle` and `Frame.QueryValue` are exported schemas, and the internal records use them. In `Frame.Snapshot`, an `Uncertain` command's `admitted` is now `Option<number>` in the Type (it was `number | null`); the encoded JSON is unchanged (`null` when no pass was admitted).

- [`eee0604`](https://github.com/cevr/effect-frame/commit/eee060472338db2b3a902f232e9be55d75519355) Thanks [@cevr](https://github.com/cevr)! - Each `Source` combinator has one path: `Source.select`, `Source.zip`, `Source.all`, `Source.on`, `Source.debounce`, `Source.throttle`, `Source.mapEffect` and the rest, imported as `Source` from `effect-frame/actor/client` (or `effect-frame/actor`). The flat `select`, `zip`, `all`, `on`, `debounce`, `throttle` and `mapEffect` exports are removed, and so is `View.select`. Replace `import { select } from "effect-frame/actor/client"` and `select(source, f)` with `import { Source } from "effect-frame/actor/client"` and `Source.select(source, f)`. The `Source<A>` type is the same name.

- [`a496bf2`](https://github.com/cevr/effect-frame/commit/a496bf2fc45a299de81fd0bcc0830f4dc9603c0d) Thanks [@cevr](https://github.com/cevr)! - `Source` gains `switchMap`, `flatten`, `succeed`, `fromSubscriptionRef`, `dedupe` and a `mapEffect` with the `Stream.mapEffect` meaning, so an app no longer writes a `{ get, changes }` pair by hand.

  - `Source.switchMap(source, (value) => inner)` follows the source the latest value names; `Source.flatten` is the same with no projection.
  - `Source.succeed(value)` is a source that never changes. `Source.fromSubscriptionRef(ref)` reads a `SubscriptionRef`.
  - `Source.dedupe(source, equivalence)` drops a change equal to the one before it.
  - `Source.mapEffect(source, f)` runs `f` on a read and on each change, in order.
  - The old `Source.mapEffect`, which loads into a `QueryState` and switches on a new input, is renamed `Source.load`. Migrate `Source.mapEffect(s, f)` that expects a `QueryState` to `Source.load(s, f)`.

- [`61f807d`](https://github.com/cevr/effect-frame/commit/61f807d0e8dabfbe7b5c958273739194e561a074) Thanks [@cevr](https://github.com/cevr)! - JSX tags are a closed, typed map. `effect-frame/view` checks every HTML tag
  against `HtmlElements`: a prop is the attribute as HTML spells it (`class`,
  `for`, `tabindex`), a value is written once or bound with `View.bind`, and
  an `on*` prop takes a prepared handler. An unknown tag, an unknown or
  misspelled prop (`className`, `onClik`, `tabIndex`), and a child of a void
  element do not compile. A raw `Source` where a value goes reports
  `"wrap the source with View.bind(source)"`, and a plain function where a
  handler goes reports `"wrap the handler with View.event(handler)"`.

  `Prepared` carries a `kind` (`PreparedKind`, `"event" | "submit"`) in place
  of `preventDefault`: `View.event` gives `Prepared<"event">`, and
  `View.submit` and a `View.form` binding's `submit` give `Prepared<"submit">`,
  whose default action the host suppresses. A form's `onSubmit` takes only
  `Prepared<"submit">`, and a form takes no `method` or `action`: the runtime
  writes a command form's plain post.

  A terminal file names its runtime with `@jsxImportSource
effect-frame/view/opentui` (new subpaths `view/opentui/jsx-runtime` and
  `view/opentui/jsx-dev-runtime`) and gets `box`, `text`, and `input`, whose
  props are the OpenTUI renderables' own options.

  The HTML host no longer renames `className` and `htmlFor`, and a leaf root
  reads `tabindex` and `contenteditable` in their HTML spelling only. `Attr`,
  `HtmlElements`, and `PreparedKind` are exported types.

- [`1f3eafb`](https://github.com/cevr/effect-frame/commit/1f3eafbe183f466fb985bed6cd3f1db56d5e3ef9) Thanks [@cevr](https://github.com/cevr)! - Add `View.keyed(source, keyBy, row)`, a keyed region with one row. The row's setup runs again only when the key changes. It replaces a `View.list` over a one-item array.

- [`5fba240`](https://github.com/cevr/effect-frame/commit/5fba240e36d9f0690fb08fca3d64380227c3b80d) Thanks [@cevr](https://github.com/cevr)! - `effect-frame/view` follows one kind rule: a flat PascalCase value is a JSX tag (`For`, `Show`, `Match`, `Portal`, `Await`) or a namespace (`View`, `Dom`, `Html`, `Remote`), and every function and Effect is a lowercase member of `View`. A type test guards it.

  | Before                                 | After                                                 |
  | -------------------------------------- | ----------------------------------------------------- |
  | `Loading({ fallback, children })`      | `View.loading({ fallback, content })`                 |
  | `Errored({ fallback, children })`      | `View.errored({ fallback, content })`                 |
  | `ready`, `orErrored`, `readyWithStale` | `View.ready`, `View.orErrored`, `View.readyWithStale` |
  | `LoadingScope`, `ErroredScope`         | `View.LoadingScope`, `View.ErroredScope`              |
  | `mount(view, props, host, root)`       | `View.mount(view, props, host, root)`                 |
  | `render` (it only flushes)             | `View.flush`                                          |
  | `<Query state loading failed ready>`   | `<Await state loading failed ready>`                  |
  | `Await({ query, ... })`, an Effect     | removed: use the `<Await>` tag, whose prop is `state` |
  | `QueryProps`                           | `AwaitProps`                                          |

  The boundaries stay Effects: they run their content's setup with the scope provided and remove it from `R`, which a synchronous tag cannot do. `content` replaces `children` so the call does not read as a tag.

- [`2a9ecbf`](https://github.com/cevr/effect-frame/commit/2a9ecbf3b252a33e174672a2747a1cc8ec350f92) Thanks [@cevr](https://github.com/cevr)! - `effect-frame/view` no longer exports the interpreter's node model: `ControlNode`, `ElementNode`, `ElementProps`, `ForNode`, `MatchNode`, `PortalNode`, `ShowNode`, `PropValue`, `BoundaryKind`, `Component`, `Tag`, `MatchCases`, `ShowIfProps` and `ShowWhenProps`. None had a caller outside the package. An author needs `Node`, `Child`, and the props types of the tags it wraps (`ForProps`, `ShowProps`, `MatchProps`, `PortalProps`), which stay.

- [`865f393`](https://github.com/cevr/effect-frame/commit/865f393ea69b6689c19f258f26bda6d4c3eafd55) Thanks [@cevr](https://github.com/cevr)! - Each `effect-frame/view` export has one path.

  - `bind`, `event`, `submit` and `attach` are `View.bind`, `View.event`, `View.submit` and `View.attach` only; the flat function exports are removed.
  - The `View` namespace holds functions, Effects and the `View` type. Every other type is a flat export: `Bound`, `Prepared`, `Attached`, `Handler`, `Bind`, `PlainPost`, `CommandForm`, `FormBinding`, `ListOptions` and `LazyModule` (was `View.LazyModule`).
  - `ViewTest` moves off `effect-frame/view` to its own subpath: `import { ViewTest } from "effect-frame/view/testing"`. A browser entry that imports `effect-frame/view` no longer carries the test harness.

### Patch Changes

- [`e8da6b0`](https://github.com/cevr/effect-frame/commit/e8da6b09a22ad1ea3af4096e74b93663e24be9e2) Thanks [@cevr](https://github.com/cevr)! - `link` compares its own params with the current URL: `aria-current="page"` now marks only the link whose printed path is the current path, and `aria-current="true"` only a link whose printed path the current path continues below. Before, every link to the same segment was current whatever its params, so a list of `/counters/:name` links all carried `aria-current="page"`. The search never counts. `Linkable.currentAt` takes the link's params.

- [`5bd87f9`](https://github.com/cevr/effect-frame/commit/5bd87f9ec4d47dff4dd709c656cbfeaa3d410fba) Thanks [@cevr](https://github.com/cevr)! - A multi-word event prop now fires. `onKeyDown` listened for `keyDown` and `onPointerDown` for `pointerDown`, which no DOM event is called, so neither handler ever ran. The runtime now lowercases the whole name after `on`: `onKeyDown` listens for `keydown`.

- [`ed1e0ef`](https://github.com/cevr/effect-frame/commit/ed1e0ef067f3f0fab1fd3f033a71f9e3acdf560b) Thanks [@cevr](https://github.com/cevr)! - The package ships a README: a first app and one section per feature, each code block a region of an example the repository compiles and tests.

- [`b9626a8`](https://github.com/cevr/effect-frame/commit/b9626a8cbb3bcf1386cfcef700a93227e4230a17) Thanks [@cevr](https://github.com/cevr)! - The spans of `runQuery` and `followQuery` are named `Query.run` and `Query.follow`, in the `Area.operation` form every other span has (the new `frame/span-name` lint rule). They were `runQuery` and `followQuery`.

- [`fa52a41`](https://github.com/cevr/effect-frame/commit/fa52a41a291556fede7c8b601d1aff983bf6690a) Thanks [@cevr](https://github.com/cevr)! - The DOM host hands a `select`'s chosen value to an event handler as
  `HostEvent.value`, as it does an input's text. It handed `""` before.

## 0.26.2

### Patch Changes

- [`be70a93`](https://github.com/cevr/effect-frame/commit/be70a930845995101db1d68a53618040bc49ae1c) Thanks [@cevr](https://github.com/cevr)! - A streamed patch that the server wrote after its shell, and that the client read before hydration, now waits for hydration where the client claims the server's nodes. A view with no boundary hydrated with a mismatch, and a `Query` kept the loading branch's attributes (`aria-busy`, a skeleton class) since 0.20.1. The server marks such a patch `late: true`. The client holds it until `Resumed.hydrated`, and a readiness boundary (`ready`, `readyWithStale`, `orErrored`) may still draw it ahead through its marks, so `resolvedAhead` counts it as before.

  `Resumed.closed` and `Resumed.hydrated` stay independent: `closed` never waits for a held patch, and `hydrated` returns once each view that took one shows it. The server document and the client bundle must come from one build; a patch without `late` lands at once, as before.

## 0.26.1

### Patch Changes

- [`42a40c3`](https://github.com/cevr/effect-frame/commit/42a40c3a7a8a283a81e56a52be60e5e6748d57d8) Thanks [@cevr](https://github.com/cevr)! - The published declarations no longer widen types that cross the package's own subpaths. A clean build emitted them before `dist` existed, so `effect-frame/actor/client` and `effect-frame/view` did not resolve, and the emitter wrote `any` or `unknown` with no error. `hydrate` returned `Effect<{ report: any; resumed: any }, unknown, unknown>`, `Driven.session` had `unknown` error and requirements, `View.select` was `any`, `addressOf` and `Remote.resume` had `any` requirements, and `PrerenderQueryFailed.error` was `any`. The declarations are now emitted from source, and each of these types is the one the source infers.

## 0.26.0

### Minor Changes

- [`ec91915`](https://github.com/cevr/effect-frame/commit/ec91915aba4a50095b1212d208ffc2049d2590de) Thanks [@cevr](https://github.com/cevr)! - `Route.driven` mounts a tree whose leaves are drawn over the op wire ([#18](https://github.com/cevr/effect-frame/issues/18) §6, [#22](https://github.com/cevr/effect-frame/issues/22) §5). A driven leaf is `Route.leaf(segment, Route.drivenView({ drive, view }))`; the flat form is `Route.driven(name, { path, params, search, drive, view })`. The server's document draws the leaf's view over its drive. The client hydrates everything else and leaves the leaf's nodes alone. `hydrate({ routes, notFound, root, wire })` is the client half of a page load: it reads the records, mounts the tree over the server's nodes, and starts the op wire only once the record channel has ended and hydration is done. Then each driven leaf connects, adopts the nodes the document drew, and applies the session's patches. A change of params follows the new drive, and a dropped connection resumes. A driven view that needs a service other than `ActorTransport | Scope` does not compile, and `Route.driven` refuses a tree with a leaf whose view is not a `Route.drivenView` with `BranchRejected`. `Route.drivenAt(routes, url)` gives the server end what `Driven.session` needs. A page hydrated with no `wire` keeps each driven leaf as its document drew it, and a driven view's setup failure keeps its `errored` view through hydration. `Remote.Client` gains `detach`.

## 0.25.1

### Patch Changes

- [`9ce2574`](https://github.com/cevr/effect-frame/commit/9ce25747b712b864deb890c00a6551d0936b6571) Thanks [@cevr](https://github.com/cevr)! - `Form.codec` accepts an effect-machine event schema ([#105](https://github.com/cevr/effect-frame/issues/105)). Before, `Form.codec(contract.raw.message)` did not compile for a machine contract, because its message schema names `variants`, not `members`. Each variant is now checked as a union member is: a machine event whose fields all encode to strings builds a form codec, and one with a `Uint8Array` field, or a boolean with no decoding default, is still a compile error.

## 0.25.0

### Minor Changes

- [`fa5d4ff`](https://github.com/cevr/effect-frame/commit/fa5d4ff3bfade792660e3c6dd478691a8d401071) Thanks [@cevr](https://github.com/cevr)! - A plain form post now answers 303 after its command commits, not when it is admitted. Before, the page the browser read next could still draw the state from before the post: a multi-step form with no script could show the step it had just left. The form route now calls the host and waits for the commit, so the commit is readable before the 303, and a `$return` page rendered on request draws it ([#21](https://github.com/cevr/effect-frame/issues/21) §5). A prerendered page is a file, and shows the commit after it hydrates. A commit that does not come within `commitWithin`, or a host that does not answer in that time, answers 504 with the same `$command`, and the identical resubmit reaches the stored receipt. `HttpServer.form` takes `commitWithin` (default ten seconds).

## 0.24.0

### Minor Changes

- [`a0f557c`](https://github.com/cevr/effect-frame/commit/a0f557cc8c3cb4a8dc446f6db282982e25a6cef0) Thanks [@cevr](https://github.com/cevr)! - A durable behavior can name when a state next needs the actor running with no request: `Behavior.wakeAt`, and `Behavior.machine(definition, { wakeAt })` for a machine. The durable engine stores the wake with each commit, so a machine deadline or work in flight survives a restart or an eviction. A host that can wake an idle actor, such as a Durable Object, arms its alarm in the same transaction.

  `MailboxStore.commit` and `MailboxStore.advance` take the wake as a new argument, and `Committed` carries it as `wake`. A custom store must store it with the state and return it from `latest`. The conformance suite checks this.

## 0.23.1

### Patch Changes

- [`dac55a4`](https://github.com/cevr/effect-frame/commit/dac55a47468babbede189cbc86e4e4b4d05e70fb) Thanks [@cevr](https://github.com/cevr)! - A `Loading` that a late view has made pending no longer shows its content again for a moment. When a registered query changed just before the late view registered, the scope could read that change over the registrations it had before, find them all settled, and put the content, the new view included, back in the document until the next read hid it. The scope now reads over the registrations it has when it reads, and the boundary acts on its current value, not on the value its subscription delivered.

## 0.23.0

### Minor Changes

- [`e99c736`](https://github.com/cevr/effect-frame/commit/e99c736b7761ad0537f5266a872e0aa44ab5e830) Thanks [@cevr](https://github.com/cevr)! - A prerender build now fails by name when an actor the page reads refuses `Anonymous` ([#23](https://github.com/cevr/effect-frame/issues/23) §2.3). Before, only a refused query failed with `PrerenderUnauthorized`; a declared `Route.actor` whose policy refused `Anonymous` died with the transport's raw `Unauthorized`. Now both fail with `PrerenderUnauthorized`, and nothing is written.

  Breaking: `PrerenderUnauthorized { route, href, query }` is now `PrerenderUnauthorized { route, href, read, contract }`. `contract` replaces `query` and names the refused contract; `read` is `"query"` or `"actor"`. A caller that reads `error.query` reads `error.contract` instead.

- [`6630efc`](https://github.com/cevr/effect-frame/commit/6630efc3f58a8a6a877d647768e55200df7b6858) Thanks [@cevr](https://github.com/cevr)! - A server that loaded a prerendered generation keeps its files however many builds follow. Before, a build kept only the new generation and the one before it, so after two rebuilds a running server's files were gone and every page it had built answered through the router. Now `Prerender.load` holds the generation it reads with a lease under `<out>/leases/`, and a build removes no generation a lease names. The lease goes when the scope closes, and the next build removes the generation.

  Breaking: `Prerender.load` now needs a `Scope`. Run it in the scope the server lives in (for a server started with `runPromise`, a `Scope.make()` you close when the server stops). A build keeps the previous generation only while a loaded site holds it. The output directory has a new `leases/` directory beside `generations/`.

- [`bfa4cb7`](https://github.com/cevr/effect-frame/commit/bfa4cb77ba1f8ef0dd7e94778bb849330de43a15) Thanks [@cevr](https://github.com/cevr)! - `Prerender.load` fails with the new `PrerenderLeaseFailed { out, generation, reason }` when it cannot take its lease under `<out>/leases/`. Before, it served the generation unheld, so the next build could remove the files the server was reading. `load`'s error type now includes `PrerenderLeaseFailed`, which is exported from `effect-frame/router/prerender`.

- [`4164d39`](https://github.com/cevr/effect-frame/commit/4164d39c20179ea7a52221259a64f27752896b79) Thanks [@cevr](https://github.com/cevr)! - `runQuery(contract, args)` reads one query once, as a value. It declares the key for the length of the read, waits for the first value or failure, and lets go; a failed read fails with its `QueryFailure`. A prerender route's `inputs` read the list its pages come from with it, and in a build that read is shared with every page that declares the same key.

### Patch Changes

- [`29e1a45`](https://github.com/cevr/effect-frame/commit/29e1a45a98a0d53d78ea8b91ab59af19bf5e9e4f) Thanks [@cevr](https://github.com/cevr)! - An `AwaitAll` render no longer reads the page from inside the drawing's reactive update. A boundary that switched, or a list row whose setup ended, woke the render at once, and the render could write a page whose bound text still showed its old value. The render now reads on a turn of its own.

- [`0de1a7e`](https://github.com/cevr/effect-frame/commit/0de1a7eb2102265271ce191e325da9b511434e61) Thanks [@cevr](https://github.com/cevr)! - A `Prerender.load` that fails or is interrupted after it took its lease now releases the lease at once. Before, the lease stayed in the caller's scope until that scope closed, so a server that gave up on a load kept a generation from being cleaned up.

- [`95f083c`](https://github.com/cevr/effect-frame/commit/95f083c2eb6567dbe7b746f41125550174358f96) Thanks [@cevr](https://github.com/cevr)! - A build whose clean-up cannot read `<out>/leases/` no longer removes held generations. Before, any failure to read the directory counted as "no leases", so clean-up removed the generation a running server had loaded. Now only a missing directory means no leases; any other failure skips that build's clean-up, and the next build removes what is left.

## 0.22.0

### Minor Changes

- [`f20a683`](https://github.com/cevr/effect-frame/commit/f20a6837325f60d0bb0d904562aacf519f522c75) Thanks [@cevr](https://github.com/cevr)! - `commandRef(contract, key)` is a remote reference that only sends. It reads no snapshot and opens no change stream, so a page that commands an actor it does not draw holds no live stream for it. Its `send` and `call` go through the same command owner a full `ref` uses: the same identities, retries and receipts, and the reply refreshes the page's active dependents in one round trip. It never predicts.

- [`0a91eea`](https://github.com/cevr/effect-frame/commit/0a91eea7475c2aeda9697de29407bdc2e0806c8f) Thanks [@cevr](https://github.com/cevr)! - `FollowedQuery` has `override`, as `QueryEntry` does, and so does every `Route.query` binding. It acts on the entry the arguments name at the call, and derives its value from that entry's own Ready value (see the function form in `override-derives-from-own-entry`). The value shows at once, marked stale, and any authoritative value replaces it; a command's rejection does not take it back. After a transition moves the binding, an override acts on the new entry, never the one that exited. With no arguments, nothing is written.

- [`43bd02c`](https://github.com/cevr/effect-frame/commit/43bd02cb75e9d3d9aae6d13fd89845824ec64ff1) Thanks [@cevr](https://github.com/cevr)! - A machine actor no longer takes its state back after a message. `Behavior.machine`'s `changes` also carries the start state and every transition its own messages make, and the actor committed each one it received as a new revision, after any message processed since. Three quick increments committed 0, 1, 2, 3, then 0, 1, 2, 3 again. A durable session could read `Empty` right after a sign-in committed.

  A behavior's turn can now name its own state as `current`. When a change arrives, the actor commits that read, not the value the change carried. `Behavior.machine` sets it. A custom behavior whose `changes` only carries states it made on its own needs nothing new.

- [`828bfd1`](https://github.com/cevr/effect-frame/commit/828bfd13f58c6f5853fcd1a8b001863181cdd71e) Thanks [@cevr](https://github.com/cevr)! - `Behavior.machine(definition, { refuse })` takes a refusal rule, as `reducer` and `value` do. The rule reads the event alone. A refused event never reaches the machine, commits no revision, and settles `Rejected(Refused)`.

- [`7d9311c`](https://github.com/cevr/effect-frame/commit/7d9311ccff609af2e456043f449ae46b9f3fac7b) Thanks [@cevr](https://github.com/cevr)! - Breaking: `override` takes a function, `override((current) => next)`, and returns whether it wrote. This applies on `QueryEntry`, `FollowedQuery` and a route's query binding. The function receives the entry's own Ready value, which is read in the same step that writes the result, under the principal generation of that moment. While the entry is Loading or Failed nothing is written and the result is `false`.

  The plain `override(value)` form is removed. A caller built its value from what a view showed, and during a key switch a followed query still shows the old key's value while `override` writes the new key's entry, so one key's data could be written into another. The function form cannot take a value from another entry.

### Patch Changes

- [`8576999`](https://github.com/cevr/effect-frame/commit/85769995ba6d9404cab5ec31d57048f3150ac43c) Thanks [@cevr](https://github.com/cevr)! - A durable `call` now returns only after the actor's state shows its commit. Before, the reply could arrive while `state.get` and `state.changes` still showed the previous revision, so a read that followed the reply could miss the write.

- [`3caa844`](https://github.com/cevr/effect-frame/commit/3caa8441f813d89742b25d5984143b004a800e65) Thanks [@cevr](https://github.com/cevr)! - A view that registers with a settled `Loading` after first paint no longer reaches the document before the fallback returns. The registration now tells the boundary at once, inside the registering setup: the content leaves the document before the new view writes a node, an empty mark keeps its place, and the fallback is drawn there. Before, a late row was connected for about a millisecond before `Loading` hid it.

- [`3e51d02`](https://github.com/cevr/effect-frame/commit/3e51d0221e6aecb2bed2944e8e82f1ddebd217c1) Thanks [@cevr](https://github.com/cevr)! - `zip`, and so `Source.all`, no longer loses a change that lands between its first read and its subscriptions. It read both sides up front and then dropped each side's first element, so a value that changed in between was never seen: a view bound to it stayed on the old value. It now reads once both sides are followed, then once per later element.

## 0.21.0

### Minor Changes

- [`f0c7d95`](https://github.com/cevr/effect-frame/commit/f0c7d95ae75083303bb767f596418ab8f4a1f9c0) Thanks [@cevr](https://github.com/cevr)! - A behavior can refuse a message. `Behavior.reducer({ initial, reduce, refuse })` and `Behavior.value(initial, { refuse })` take an optional pure rule `refuse: (message) => Option<Refused>`; `reduce` stays total. A refused message is never applied and commits no revision: its handle settles `Rejected(Refused { reason })`. A durable or hosted actor refuses a new command at admission (nothing is appended), a command it already holds is answered from its record, the HTTP wire answers 422 with the decoded `Refused`, a plain form post answers 422 with the reason as its issue, and a reference that predicts with the same behavior never predicts a refused message. The command owner treats `Refused` as conclusive and never retries it. The refusal is typed: `Behavior`, `ActorRef`, `LocalActorRef`, `Rejection`, `CallError`, `CommandState`, `CommandSettled`, and the handle types take a `Refusal` parameter that defaults to `never`, so a behavior without a rule keeps its exact error types; a remote reference always includes `Refused`.

- [`f925b5c`](https://github.com/cevr/effect-frame/commit/f925b5c78e1465863f7ee7fc5e8d127eaae9155d) Thanks [@cevr](https://github.com/cevr)! - A route actor is seeded into the document. A route that declares `Route.actor` holds its reference's committed snapshot while it draws, and the document carries it beside the drawing: `SSR` and `AwaitAll` in a `frame-actor-seed` script, `Streamed` as `ActorSeed` records in the first chunk. The client's route opens its reference from it while the page hydrates and reads no snapshot; seeds are dropped at `Resumed.hydrated`. `Streaming.StreamRecord` now includes `ActorSeed`, and `Streaming.actorSeeds`, `Streaming.actorSeedId` and `Streaming.ActorSeedJson` are new. `Route.actor(contract, key, { behavior })` gives the route's reference a behavior, so a view sends through it with prediction.

- [`8691948`](https://github.com/cevr/effect-frame/commit/8691948eef6e6fbf8d94d04b87518e363ac0f66f) Thanks [@cevr](https://github.com/cevr)! - `mount` takes `traversalReadLimit` (a `Duration.Input`, default 3 seconds): how long a traversal waits for the reads its page declared before it places the saved position. At the limit it lands on the page as it is (the scroll may clamp) and never places again when the reads settle later, and the Navigation API's traversal is released. Before, a declared read that never settled held the traversal for ever.

### Patch Changes

- [`d84ac96`](https://github.com/cevr/effect-frame/commit/d84ac96d3d060166901a5b5e3be050123d9ee880) - Predict a command whose ID the framework minted. `Generated.send` and `View.form` pass the ID they minted for one send, and that send now predicts at once, as a plain `send` does ([#67](https://github.com/cevr/effect-frame/issues/67) §3). An ID an application supplies, and an ID the server drew into a form's markup, still waits for its receipt. Not breaking.

- [`32205b9`](https://github.com/cevr/effect-frame/commit/32205b9aaef96d79737da6668a02db40c7cdd4a6) Thanks [@cevr](https://github.com/cevr)! - A minted command ID is known by identity ([#67](https://github.com/cevr/effect-frame/issues/67) §3). The framework recorded that it minted an ID by a private symbol on the send options, and checked it with `in`, so a `Proxy` whose `has` trap answers true passed as minted: an application's own, possibly reused ID then predicted, and a first refusal counted as conclusive. The options the framework mints are now recorded in a module-private `WeakSet` and frozen. Not breaking.

- [`9b23449`](https://github.com/cevr/effect-frame/commit/9b234495d5c4eade84cf23cbdc4f762436670e17) Thanks [@cevr](https://github.com/cevr)! - A framework-minted command ID is fresh for one send only. The reference's check consumes the minted options' record, so an application wrapper that keeps the frozen options and sends them again sends a supplied ID: it waits for receipt evidence instead of predicting over a used ID.

- [`657197b`](https://github.com/cevr/effect-frame/commit/657197bf70a9e573ca2561e91cf5b41d8742d486) - The first frame holds a layout's outlet ([#37](https://github.com/cevr/effect-frame/issues/37)). A layout that yields its outlet inside `Loading` now draws a settled child on the first frame: an `SSR` document writes the child, not the fallback, and hydration of an `SSR` or `AwaitAll` document claims it with no `resolvedAhead`. A child that presents `pending` still starts in its row, when the parent is drawn. Not breaking.

- [`c5ce77c`](https://github.com/cevr/effect-frame/commit/c5ce77cf4940abbce3ce0f43ad14a6930712bad6) Thanks [@cevr](https://github.com/cevr)! - Declarations of one route actor address in one tree share one reference. A layout and its leaf that declare the same actor now draw one revision and the document carries one seed for it; before, a commit between their opens could draw two revisions, and the leaf did not hydrate.

- [`a0aae72`](https://github.com/cevr/effect-frame/commit/a0aae72447855ce2f6ef9f7f2a25040a9285dc85) Thanks [@cevr](https://github.com/cevr)! - A Back or Forward lands once its page is drawn ([#31](https://github.com/cevr/effect-frame/issues/31)). The router placed a traversal's saved position at shell commit, while a declared query of the page could still be read again, so the position landed clamped against a short page (always in WebKit, sometimes in Chrome). A traversal now waits until every query the drawn branch declared has settled and the drawing shows it, then restores the position. A push or replace still lands at shell commit. Not breaking.

## 0.20.1

### Patch Changes

- [`511d546`](https://github.com/cevr/effect-frame/commit/511d546af5b6104d9a9d7ffcb9e028f919a3b7e6) - A server drawing shows every value its seed carries ([#22](https://github.com/cevr/effect-frame/issues/22)). An `AwaitAll` document, a streamed shell, and an `SSR` document could draw a value older than the seed, for example "searching…" from a `followQuery` view with no `Loading` boundary while the seed carried the results. The client then drew the results, and hydration did not agree.

  - A source's `get` is its value now. `followQuery`, a route's query binding, `ready`, `readyWithStale`, `orErrored` and a readiness scope read their upstream in `get` and do not return a copy that a fiber moves.
  - The HTML host reads its records, brings every binding to its source's current value, and reads the records again until the two reads agree. A new optional `Host` capability, `sourceBound`, tells a host of each source the runtime binds.

- [`511d546`](https://github.com/cevr/effect-frame/commit/511d546af5b6104d9a9d7ffcb9e028f919a3b7e6) - Back and Forward restore the entry's saved scroll position under `NavigationBehavior.Preserve` with `browserNavigation`, as they do with `browserLocation` ([#31](https://github.com/cevr/effect-frame/issues/31)). `Preserve` keeps a push or replace where the page is; a traversal returns to where the entry was. Focus under `Preserve` still does not move.

- [`ad93c5b`](https://github.com/cevr/effect-frame/commit/ad93c5bd880cbe5c005120977884a986e4a47e38) Thanks [@cevr](https://github.com/cevr)! - A server render whose drawing and seed still disagree at the time limit no longer writes a document. Before, `AwaitAll`, the streamed shell and `SSR` wrote the last read, and a query that settled between the drawing's catch-up and that read put a newer value in the seed than in the HTML, so the page did not hydrate. Now `Html.renderAwaitAll` and `Html.renderToStream` fail with the new `Html.RecordsUnsettled`, and `renderDocument` fails with `DocumentTimedOut { phase: "agree" }` (the prerender build: `PrerenderTimedOut { phase: "agree" }`), so the caller answers another way, for example with a client-only page. A caller that matches `phase` exhaustively has a new case to handle.

- [`5efe89b`](https://github.com/cevr/effect-frame/commit/5efe89bb2d120fd520c3afe85625ded9976d20c0) Thanks [@cevr](https://github.com/cevr)! - A read that a document's seed calls for (a value the server showed stale or baked at build time, a failure that is not final, `StreamEnded`) now starts when the client runs `Resumed.hydrated`, not when the seed lands. Until then the entry shows what the server drew, so a reply that comes before the client's first drawing no longer draws a newer value against the server's markup. Run `resumed.hydrated` after `hydration.finish`, as the README shows: a client that never runs it never reads those keys again.

- [`652b8b4`](https://github.com/cevr/effect-frame/commit/652b8b4d6488af953bfa9d58ab8bc4a877ef6fd8) - Review round 1 of the seed fix ([#22](https://github.com/cevr/effect-frame/issues/22)):

  - `followQuery`, a route's query binding, `ready` and `readyWithStale` keep their state in one place and move it by one step over the upstream now. A read never runs ahead of `changes`, a late delivery never undoes a newer value, the value shown last stays stale while the next key loads, and an equal value is not emitted twice.
  - A patch and a seed carry `stale: true` when the server showed the value stale, and the client seeds it stale, so a view that draws the flag hydrates with no mismatch.
  - A server render that brings its drawing to the seed stops at the document's limit, in `AwaitAll`, the streamed shell and `SSR`.

## 0.20.0

### Minor Changes

- [`4208632`](https://github.com/cevr/effect-frame/commit/42086324b9ffb8c6f5e7c735d58e91cfb2b01a8c) - Stream host operations to a server-driven client, and reconnect from the actor's snapshot ([#15](https://github.com/cevr/effect-frame/issues/15), [#27](https://github.com/cevr/effect-frame/issues/27), [#87](https://github.com/cevr/effect-frame/issues/87)).

  New exports on `effect-frame/view`: `Remote`, the client half of the op wire. `Remote.recorder` (a `Host` that records each operation, with a shadow that drops writes that would not change the client's tree, and an optional `limit` on undrained operations), `Remote.client` (`resume`, `apply`, `position`, `retained`), `Remote.draw`, `Remote.payloadOf`, `Remote.digestOf`, `Remote.addressOf`, `Remote.sameAddress`, `Remote.root`, the wire schemas `Remote.Op`, `Remote.Patch`, `Remote.RemoteEvent`, `Remote.PatchJson`, `Remote.RemoteEventJson` and one schema per operation (with `Remote.Forget`), the errors `Remote.ForeignSession`, `Remote.StaleClient`, `Remote.UnknownNode`, and `Remote.Diverged`, and the types `Remote.Recorder`, `Remote.RecorderOptions`, `Remote.Retained`, `Remote.ClientRetained`, `Remote.RemoteNode`, `Remote.Drive`, `Remote.Target`, `Remote.Client`, `Remote.Drawn`.

  New subpath `effect-frame/view/driven` (server only): `session(view, props, drive, { limit })` returns a `Session` with `resume`, `patches`, `fire`, and `retained`; `Backlogged` ends `patches` when a client falls more than `limit` operations behind (`defaultLimit`, 10 000).

  New optional `Host.forget(node)`: the runtime calls it when the owner that drew a node ends. A host that keeps state for each node uses it to forget the node; the recorder sends a `Forget` operation.

  A connection starts with the session id, the drive's snapshot, and a digest of the drawing, never with an operation log. A reconnect costs the snapshot at any age. Every patch names its session, and a client refuses a patch from another session. The server's mount holds back the drive's changes until its first drawing is drained, and reads only its drive, as the client does. A client whose drawing from the snapshot differs from the server's fails `Diverged` and applies nothing. An event reaches only a listener a patch has delivered. The wire carries every property value a host can receive, including `NaN`, the infinities, and `-0`. Patches are trusted server output.

  No breaking changes: `Host.forget` is optional.

### Patch Changes

- [`4208632`](https://github.com/cevr/effect-frame/commit/42086324b9ffb8c6f5e7c735d58e91cfb2b01a8c) - Fix: `mount` now runs pending reactive work before it creates its root. Before, a list row added in another mounted view just before a mount (a server render, for one) was created under the new mount's root, and closing that mount disposed the row's bindings: the row stayed drawn but no longer followed its item.

## 0.19.0

### Minor Changes

- [`e3837e6`](https://github.com/cevr/effect-frame/commit/e3837e6361676500e1a5278f5444cdb2c007f87f) - A plain form redrawn after a lost reply keeps its command id until the command settles ([#21](https://github.com/cevr/effect-frame/issues/21), [#29](https://github.com/cevr/effect-frame/issues/29)).

  - The 504 redraw draws a new framework field, `$uncertain`, into the form. When a post that carries it does not decode (for example, a required redacted field was not typed again), the route answers 200 with the issues and keeps the same `$command` and `$uncertain`. Before, it minted a fresh id, so the corrected post could apply the message a second time. A post without the marker still gets a fresh id.
  - The route now decodes and encodes each plain post twice. When the two payloads differ, it answers 500, logs the contract name, and sends nothing. A form message codec must be repeatable: mint a value that needs entropy or a clock at render with `Generated`, never at decode.
  - The hydrated `View.form` binding spends an id when it sends, not when the form fails to decode. A submit that does not decode sends nothing, and the next submit still carries the adopted id. Choosing the id, decoding, and spending it run under one permit per form, so two submits in flight never share an id: the second mints its own.

  **Breaking:** `FormIssues` has a required `outcome: "Refused" | "Uncertain"` (`Form.FormOutcome`), and `Form.IssuesJson` carries it. Code that builds a `FormIssues` by hand must set it. `Form.frameworkFields` has `uncertain: "$uncertain"`.

### Patch Changes

- [`e3837e6`](https://github.com/cevr/effect-frame/commit/e3837e6361676500e1a5278f5444cdb2c007f87f) - A mailbox store no longer takes a different payload under a used command ID for a `Duplicate` when the two payload hashes are equal. `MailboxStore.layerMemory` compares the stored payload text once the hashes match, and answers `CommandConflict` when the text differs. `Hash.string` gives `{"title":"00008t"}` and `{"title":"0000fj"}` one hash, so before this fix a second message under one ID could be read as a retry of the first. The store conformance suite has a new case, "a new payload with an equal hash under a used ID fails with CommandConflict". A custom `MailboxStore` must compare the payload text too.

## 0.18.0

### Minor Changes

- [`83beec3`](https://github.com/cevr/effect-frame/commit/83beec395fdc365a970f8554bc739dbd0af19bef) - Prerender route trees at build time, serve what the build wrote before the router, and resume a loaded page ([#23](https://github.com/cevr/effect-frame/issues/23), [#86](https://github.com/cevr/effect-frame/issues/86)).

  New exports on `effect-frame/router`:

  - `Route.prerender(name, branch, { inputs })` and `Route.prerender(name, { ...definition, inputs })`: the fifth mode constructor. A call without `inputs` does not compile. The tree registers `AwaitAll`, so `renderDocument` renders a prerender URL with no built file through the same pipeline.
  - `Route.inputs(segment, enumerate)`: how one segment enumerates the params it adds. A root segment's `enumerate` is an Effect of its params records; a child's is a function of its ancestors' params that returns only its own. A child's inputs run once for each parent.
  - `Route.PrerenderAncestorNotEnumerable { route, leaf, ancestor, param }`: `Route.prerender` throws it when a segment adds a path param and names no inputs. `Route.PrerenderInputsRejected { route, segment, reason }`: inputs for a segment outside the tree, or twice for one segment.
  - The types `Route.Inputs`, `Route.AnyInputs`, `Route.Enumerate`, `Route.OwnParams`, `Route.Prerendered`, `Route.PrerenderError`, `Route.PrerenderServices`, `Route.PrerenderOptions`, `Route.PrerenderDefinition`, `Route.PrerenderConstructor`, and `Route.NoParams`.

  New server-only entry `effect-frame/router/prerender`:

  - `build({ routes, notFound, document, client, out, timeLimit, concurrency? })`: render every input of every prerender tree among `routes` through the router's server document, in `AwaitAll`, as `Anonymous`, at the URL `href` prints. It writes `<href>/index.html`, `client.js` (from the `client` Effect), and `manifest.json` into `out/staging/<id>`, moves it to `out/generations/<id>`, and publishes it by renaming a new `out/current.json` over the old one. A build that fails or is interrupted before that rename leaves the previous generation published. One previous generation is kept; older ones, and what crashed builds left, are removed after the pointer moves. One build writes one output: it holds `out/build.lock`, and a second build fails at once. `timeLimit` covers each page from `document(page)` on.
  - `oneInstant(transport)`: the build's transport. It reads each query key, batch key, and actor snapshot once, answers every later ask from that read, and gives an empty change stream, so a page and its resume script show one revision. A failed batch fails every reader of its keys.
  - Build failures: `PrerenderUnauthorized` (a query refused `Anonymous`), `PrerenderQueryFailed`, `PrerenderRedirected`, `PrerenderNotMatched`, `PrerenderTimedOut` (its `phase` includes `"document"`), `PrerenderBuildLocked { out, lock }`, `PrerenderSearchRejected { route, href }`, `PrerenderPathCollision { first, second }` (two hrefs whose files fold to one name, in NFC and lower case), and `PrerenderBrokenLink { route, href, link, target }` (a local link to a prerender route that no input built).
  - `load(out)`: read the generation `current.json` names; when the pointer is missing or names no whole generation, the newest generation with a manifest. `Site.generation` is that directory, and the `Site` reads only its files. `lookup(site, pathname)` and `serve(site, fallback)`: answer a built page from its file before the router runs, with a strong `ETag` and `cache-control: public, max-age=0, must-revalidate`. The file is read first; a matching `If-None-Match` then answers 304. HEAD answers as GET does, with no body. Anything else, a page whose file cannot be read included, goes to `fallback`.
  - `Manifest`, `ManifestPage`, `clientScript`, `clientFile`, `manifestFile`, `Site`, `SitePage`, `WebHandler`, `BuildOptions`, `PageDocument`, and `PrerenderManifestInvalid`.

  **Breaking:**

  - `Streaming.Patch` has an optional `builtAt` (milliseconds). A patch with `builtAt` lands in the query cache as `Ready { stale: true }`, and the entry reads once to confirm it; before, every seeded value landed fresh. A patch without `builtAt` is unchanged.
  - `Route.Segment` has an eighth type parameter, `Inherited`, the params its ancestors add (`NoParams` for a root segment). Code that spells `Segment` with seven arguments still compiles; code that matches it with `infer` in all positions must add one.

## 0.17.0

### Minor Changes

- [`44d961a`](https://github.com/cevr/effect-frame/commit/44d961a77991b37aedda88fe993ce7a68151720a) - Render a route tree's server document by its rendering-mode constructor, and resolve declared route data before render ([#18](https://github.com/cevr/effect-frame/issues/18) §3.3, §6, with [#22](https://github.com/cevr/effect-frame/issues/22) and [#85](https://github.com/cevr/effect-frame/issues/85)).

  New exports on `effect-frame/router`:

  - `Route.ssr(name, root)`, `Route.streamed(name, root)`, and `Route.awaitAll(name, root)`, beside `Route.client(name, root)`. Each takes a branch of a root segment or the one-leaf flat definition, as `Route.client` does. A mode is the constructor; no route value carries a mode field.
  - `Route.ModeConstructor`, the type of the four constructors, and `Route.RenderingMode` (`"ClientOnly" | "SSR" | "AwaitAll" | "Streamed"`, the [#22](https://github.com/cevr/effect-frame/issues/22) names).
  - `renderDocument({ routes, notFound, url, document, closeWhen })`: answer one request, in the request's Scope. It matches the URL and runs the matched route's checks first, for every mode, `Route.client` included. It returns a `DocumentOutcome`:
    - `{ _tag: "Redirect", location }` when a check redirects: answer 303. The render does not follow it.
    - `{ _tag: "Rendered", route, mode, status, body }`. `route` is `{ _tag: "Matched", route }` or `{ _tag: "NotFound" }`; `status` is 404 for not-found and 200 otherwise; `mode` is the settled tree's (a hand-written route and not-found render as `SSR`); `body` is a `Stream<string>` that needs nothing and cannot fail.
    - `SSR` resolves every query the matched branch declares, in parallel, before any view draws. It draws once and writes the settled values in one seed script. The client hydrates with no read.
    - `Streamed` writes the shell first, with a `Placeholder` for each declared query, then one `Patch` per query as it settles ([#22](https://github.com/cevr/effect-frame/issues/22)).
    - `AwaitAll` writes one document once every read settled ([#22](https://github.com/cevr/effect-frame/issues/22)).
    - `ClientOnly` writes the document with an empty mount element and reads nothing.
    - The checks and the drawing read through one query cache per request, held by the request Scope ([#28](https://github.com/cevr/effect-frame/issues/28)). A query both read is read once and written once; a query only a check read is not written.
    - Every read goes through `ActorTransport` under the caller's `CurrentPrincipal`, so each route query's named policy checks it ([#85](https://github.com/cevr/effect-frame/issues/85)). A refusal is seeded as the refusal, never as the value.
  - `DocumentTimedOut { phase: "settle" | "draw" }`: `closeWhen` completed before the checks, the declarations, or the first drawing ended. Nothing was written, and what the render opened is closed.
  - `DocumentOptions`, `DocumentOutcome`, `DocumentRedirect`, `DocumentRoute`, `DocumentServices`, `RenderedDocument`.
  - `Route.UrlValueRejected { name, reason }`: a route prints only what a URL carries both ways. A path segment must be well-formed text that is not empty and not `.` or `..`; a search key or value must be well-formed text. **Breaking:** `href`, `hrefAt`, `hrefFrom`, `Route.printPath`, and `Route.printSearch` now die with `UrlValueRejected` for another value, where they used to print a URL that parsed as other values (or threw a `URIError` for a lone surrogate in a path). Parse refuses the same values: a raw pathname with `%2E` or `%2E%2E` no longer matches.

  Changes to existing types (no behavior change):

  - `Route.client` is now a `ModeConstructor` value, with the same two call forms.
  - `Html.renderToStream` and `Html.renderAwaitAll` spell their requirement type through one alias; it is the same set of services.
  - The `Html` namespace lists its exports. Its public names are unchanged.

## 0.16.0

### Minor Changes

- [`a987c57`](https://github.com/cevr/effect-frame/commit/a987c57152508e4da496f4b1cd831177c825b251) - Require a named policy for every actor and query, and end a live connection when its principal changes ([#20](https://github.com/cevr/effect-frame/issues/20), [#30](https://github.com/cevr/effect-frame/issues/30)).

  New exports on `effect-frame/actor`: `Policy` (`allowAll`, `authenticated`, `of`, `all`, `any`, `byAction`), `Policies`, `PolicyNamesMissing`, `MissingPolicy`, and the types `PolicyTable`, `Subject`, `Action`. `HttpServer.anonymous` and the type `HttpServer.DerivePrincipal`.

  New exports on `effect-frame/actor/client`: `Principal` (`anonymous`, `constant`, `equals`, `fromSource`, `isAuthenticated`, `revisions`), `Anonymous`, `Authenticated`, `Claims`, `CurrentPrincipal`, and the types `PrincipalSource` and `PrincipalRevision`. A `PrincipalSource`'s `changes` emits numbered revisions, and a connection ends at the first revision after the one it connected under.

  Breaking changes:

  - `contract(...)` and `query(...)` require `policy`, a policy name.
  - `ActorHost.make`, `ActorHost.layer`, and `ActorHost.layerMemory` require `Policies` and fail with `PolicyNamesMissing` when the table lacks a declared name. `ActorTransport.layerLocal` and `QueryCache.layerTest` carry the host's error and requirements.
  - Removed: `Authorizer`, `AuthorizerService`, the host's `Action`, `QueryPolicies`, `QueryPolicy`, `allowAll`, and `publicPolicy`. Write `Policy.allowAll` under a name instead.
  - `HttpServer.make` takes `{ principal }`. `HttpServer.toWebHandler` takes the same options.
  - `HttpServer.form` requires `principal` and `login: Option<string>`. An anonymous refusal answers 303 to `login` with `next`.
  - `FrameHost` options require `principal`, and the host layer must provide `Policies`.
  - The HTTP client never retries `Unauthorized`, and decodes a terminal `event: error` on a changes stream.
  - `HttpServer.toWebHandler` and `defineFrameHost` keep the derivation's requirements and supply them from their runtime.
  - `ActorHost.layer` and `ActorHost.layerMemory` also provide `ActorHost.Recovery`. The celld alarm wakes through it, not through the public wire.
  - `QueryCacheService` has `principalChanged`. A custom cache must implement it. The built-in cache starts a new principal generation on a reference's `Unauthorized` stream end, a refused `send` or `call`, and a refused read of a key it was granted under the same generation. A reply that settles after a new generation does not land, and `followQuery` does not carry a value across generations.

  Also new: `HttpServer.shareSessions` (one subscription per session, shared by every connection, with a bounded `HttpServer.sessionBuffer` of the latest revision), `HttpServer.SessionPrincipals`, and `HttpServer.SessionBuffer`.

- [`a987c57`](https://github.com/cevr/effect-frame/commit/a987c57152508e4da496f4b1cd831177c825b251) - Place scroll and focus at shell commit ([#31](https://github.com/cevr/effect-frame/issues/31)).

  New exports on `effect-frame/router`:

  - `NavigationBehavior`: a namespace with the `NavigationBehavior.NavigationBehavior` type and its two values, `Restore` (the default) and `Preserve`.
  - `browserNavigation`: the browser `Location` on the Navigation API, with the History API as the fallback.
  - `mount({ behavior })`, `Route.leaf(segment, view, { behavior })`, and `behavior` on a flat `Route.client` definition. A layout takes none.
  - The `Route.LeafOptions` type.

  Changed behavior:

  - Under `Restore`, a push or replace scrolls to the top or to the URL's fragment when the new branch is in the document, and Back or Forward restores the browser's saved position. Focus moves to the entering leaf's root, or to the first `autofocus` element inside it. A stayed leaf keeps focus.
  - A leaf's root element renders with `tabindex="-1"`, unless the view wrote a tab index (`tabindex` or `tabIndex`) or the element is focusable by the platform already (for example a `<button>` or an `<a href>`).
  - `browserLocation` now scrolls and focuses the same way through the History API.
  - `followLinks` no longer follows a link that only changes the current page's fragment.
  - A cancelable Back or Forward on an engine without a precommit handler (WebKit) is no longer canceled. It is followed and reported with `reason=noncancelable`, because a canceled traversal there leaves the back-forward list out of step with the page.

- [`a987c57`](https://github.com/cevr/effect-frame/commit/a987c57152508e4da496f4b1cd831177c825b251) - Stream a server render: the shell and its fallbacks first, then each query value as it settles, in JSON records that no script runs ([#22](https://github.com/cevr/effect-frame/issues/22)). Each server render holds its own query cache ([#28](https://github.com/cevr/effect-frame/issues/28)).

  New exports on `effect-frame/actor/client` (and `effect-frame/actor`):

  - `Streaming`: the records `Placeholder`, `Patch`, `Closed`, `StreamRecord`, their JSON codecs `RecordJson` and `SeedJson`, `recordId(key)`, `containerId`, `recordClass`, `seedId`; the server half `shell(options)`, `declared`, `awaitDeclared`, `settledPatches`, `ShellRecords`, `ShellOptions` (with a required `closeWhen`); the client half `resume(records)`, `DocumentRecords`, `Resumed` (`closed`, and `hydrated`, which drops the seeds no view took).
  - `StreamEnded`: a new member of `QueryFailure`. A query still open when its document ends fails with it, then reads again over `POST /query`. The wire answers it with 502.
  - A value in the document never replaces a newer read the client made. Only `QueryFailed` in the document is final; any other failure reads again. `Resumed.closed` completes once every live entry shows its value or failure.

  New exports on `effect-frame/view`:

  - `Html.renderToStream(view, props, document, options)`: a streamed document over a per-request cache. `options.closeWhen`, the time limit, is required.
  - `Html.renderAwaitAll(view, props, document, options)`: one document once every declared query settled and no `Loading` boundary shows its fallback, with a seed script and no record channel. `options.closeWhen` is required: at the limit the drawing is written as it is, and the client reads what is still open.
  - `Html.Document`, `Html.streamRecord(record)`.
  - `Dom.readRecords`: the records present and the records still to come, or an `AwaitAll` seed.

  Changes to existing types:

  - `HydrationReport` has a new `resolvedAhead: number` field: boundaries the client drew with the other branch because their query settled before hydration.
  - `Host` has three optional capabilities, `boundaryMarks(kind)`, `adoptBoundary(shown)` and `setupStarted()`, and the new type `BoundaryMarks`. A custom host may omit them.
  - `RetainedNode` has a new required field `kind: "Loading" | "Errored"` (the new type `BoundaryKind`, exported from `effect-frame/view` and `effect-frame/view/jsx-runtime`). `Loading` and `Errored` set it; code that builds a `RetainedNode` by hand must set it too.
  - The HTML host writes a comment pair around each readiness boundary: `<!--frame-boundary:fallback-->` or `<!--frame-boundary:content-->`, then `<!--/frame-boundary-->`. `Html.HtmlNode` has a new `Comment` member.
  - A streamed record is followed by an empty comment, so the client reads a large record as soon as it is whole.

## 0.15.0

### Minor Changes

- [`b885a3e`](https://github.com/cevr/effect-frame/commit/b885a3e7f8eaa5dc09fc47cc213bb5530a2cb997) Thanks [@cevr](https://github.com/cevr)! - Send a command from a plain HTML form with no JavaScript ([#21](https://github.com/cevr/effect-frame/issues/21)), and generate message values that no form field carries ([#32](https://github.com/cevr/effect-frame/issues/32)).

  New exports on `effect-frame/actor/client`:

  - `Generated`: `fromCommandId(schema)`, `freshId(schema, width?)`, `send(ref, contract, input)`, `Input<M>`, `Generated<S>`, `Minted`, `Mintable`, `Generation`. A generated field is minted at render or at send, never at decode, and it cannot carry a decoding default.
  - `Form`: `codec(schema)`, `Checkbox`, `Structure`, `Tree`, `Fields`, `FormContext`, `FormIssue`, `FormIssues`, `FormFields`, `FormMalformed`, `issuesOf`, `encodeKey`, `decodeKey`, `isReturnPath`, `frameworkFields`, and the field-map helpers `fromEntries`, `toEntries`, `fromBody`, `toBody`, `last`, `strip`, `submitted`, `withValues`, `without`, `tree`, `flatten`.
  - `Form.IssuesJson`, `Form.encodeIssues`, `Form.decodeIssues`, `Form.issuesScriptId`, and `Form.provideIssues`: a refused page carries its `FormIssues` to the hydrating client, so the first client render matches the server.
  - `Form.maxDepth` (32) and `Form.maxFields` (1000): the structural limits of a form body.
  - `FormContext`, `FormFields`, `FormIssue`, `FormIssues` at the top level.
  - `Wire.paths.form` (`/form`).

  New exports on `effect-frame/actor`:

  - `HttpServer.form({ contracts, render })`: the `POST {base}/form` handler. It answers 303 on success, 200 with the page on a validation failure, 504 with the same id on a lost reply, and 400 or 415 before any send.

  New exports on `effect-frame/view`:

  - `View.form(options)`: a command form binding. `name` sets the posted `$form` identity; the default is the member tag. The runtime draws `method`, `action`, and the hidden framework fields in every host. The DOM host cancels the native post and sends the same message; its first send adopts the rendered id.
  - `View.CommandForm`, `View.FormBinding`, `View.PlainPost`.

  Changes to existing types:

  - `HostEvent` has a new `form: Option<FormFields>` field. A custom host sets it to `Option.none()` unless it reads a form.
  - `Prepared` has a new `post: Option<PlainPost>` field. `View.event` and `View.submit` set it to `Option.none()`.

## 0.14.0

### Minor Changes

- [`5436837`](https://github.com/cevr/effect-frame/commit/54368373a506f9b7c8a35eeceaab47f9695e400a) Thanks [@cevr](https://github.com/cevr)! - Show optimistic sends on remote references ([#19](https://github.com/cevr/effect-frame/issues/19), [#67](https://github.com/cevr/effect-frame/issues/67)).

  New public surface on `effect-frame/actor` and `effect-frame/actor/client`:

  - `Behavior.predict`: an optional pure copy of `apply`. `Behavior.value` and `Behavior.reducer` have it. `Behavior.machine` does not.
  - `RefOptions.behavior`: give `ref` the actor's behavior. When it has `predict`, a send with a fresh command ID shows its predicted state at once.
  - `ActorRef.displayed: Source<Displayed<State>>` and `Displayed<State> = Applied<State> | Provisional<State>`. A provisional value has `revision: {_tag: "Provisional", base, depth}` and no number of its own.

  Behavior changes:

  - `ActorRef.state` on a remote reference is now `displayed.state`. With no `predict`, `displayed` is `applied` and nothing changes. `applied` stays committed.
  - A `predict` that throws during a replay drops only that command's prediction and logs `command.predict.defect`; the reference keeps following.
  - A committed state replaces the prediction. A rejected command leaves the pending log and the rest replays over the same base. An `Uncertain` command keeps its prediction. A supplied command ID never predicts.
  - Local and durable references never predict. Their `displayed` is their `applied`.

  Migration: a custom `ActorRef` implementation must add `displayed`. A custom `Behavior` needs no change.

## 0.13.0

### Minor Changes

- [`cd81747`](https://github.com/cevr/effect-frame/commit/cd817471f58fb461e5fef3871e03c17c0a787c28) Thanks [@cevr](https://github.com/cevr)! - Publish nested routes on the `Route` namespace of `effect-frame/router`, and `View.lazy` on `effect-frame/view`.

  New exports on `Route`:

  - Addresses: `segment`, `child`, `Segment`, `SegmentOptions`, `AnySegment`. A segment's type holds only its name, parent, search keys, printers, and `currentAt`.
  - Branches: `leaf`, `layout`, `Branch`, `AnyBranch`, `Tree`, `BranchRejected`. Segments and branches are branded: only the constructors make them.
  - Mount: `client(name, root)` mounts a tree from a branch of a root segment. `client(name, definition)` stays the flat form. It is now the one-leaf shorthand of the same model and runs on the same runtime.
  - Data: `query`, `actor`, `Declaration`, `Declarations`, `QueryDeclaration`, `ActorDeclaration`, `RouteData`, `Values`. A segment with declarations requires `data`.
  - Props: `SegmentProps`, `LayoutProps`, `PropsOf`, `LayoutPropsOf`. Segment views get `href`, `updateSearch`, and `replaceSearch`.
  - Presentation: `Pending`, `Presentation`, `Recovery`.
  - Checks: `target`, `redirect`, `Continue`, `Target`, `Redirect`, `Verdict`, `Before`, `BeforeInput`, `NavigationKind`, `Printable`, `RouteFailure`, `CheckNavigation`, `RedirectCycle`.
  - Links: `Linkable` (the shape `link` accepts) and `Current` (`"page" | "ancestor" | "none"`).

  New on `Link`: `current: Source<Route.Current>`. `Link` draws `aria-current="page"` on the destination and `aria-current="true"` on a segment the URL continues below. A segment is never current on not-found or on another route.

  New exports on `View`: `lazy`, `LazyImportFailed`, `LazyModule`.

  Leave checks, the browser commit, and navigation receipts stay private ([#56](https://github.com/cevr/effect-frame/issues/56)).

  Migration:

  - Routes built with `Route.client(name, definition)` need no source change.
  - `link` now takes `<Params, Search>` (decoded types) and accepts a flat route or a segment. Remove explicit type arguments: `link<"book", typeof P, typeof S, never>(book, ...)` becomes `link(book, ...)`. Inferred calls do not change.
  - `Route.Route` now extends `Linkable`, so it also has `searchAt` and `currentAt`. A `Route` object written by hand must add both.
  - `Route.client` is overloaded. A wrong flat definition is reported as TS2769, with the flat form's own error below it on the same property.
  - A flat route's `params` and `search` Sources now publish together, and only when the raw path record or the route's encoded search changes. A hash-only move, a write of a key the route does not decode (such as a `UrlState` key), a reordered query, and a search that decodes and encodes the same publish nothing. A raw path change that decodes to equal params (`/books/05` after `/books/5`) still publishes.

## 0.12.0

### Minor Changes

- [`1fb583f`](https://github.com/cevr/effect-frame/commit/1fb583f85a162c5f6de839c3e6f9e16eb8f0e4e0) Thanks [@cevr](https://github.com/cevr)! - Add the browser-safe `effect-frame/inspection` subpath for live inspection of a Frame root.

  - `Protocol`: the versioned (v1) wire contract.
    - `Protocol.wire` holds the fixed strings: `version`, `subprotocol`, `attachTokenPrefix`, `versionHeader`, `attachPath`, `rootsPath`, and `inspectPath`.
    - The schemas hold every bound: `InspectRequest` (with `RootSelector`, 1 to 256 characters with no control characters, and `DeadlineMillis`, an integer from 1 to 30000), `RootInfo` (with `RootId` and `RootName`), `SnapshotTooLarge`, `GatewayError`, and the reader documents `RootsResponse`, `InspectResponse`, `ErrorResponse`, and `ReaderResponse`.
    - `RootRpcs` and its one `Inspect` RPC are **unstable**: they are built with `effect/unstable/rpc`, so their types follow that module and can change with an Effect release. The wire format is versioned by `Protocol.wire.version`.
  - `attachGateway({ url, token })`: connects the current root's `Frame.Service` to a loopback inspection gateway (`127.0.0.1` or `localhost`) over one browser-originated WebSocket. It returns at once, retries with a delay that doubles from `initialRetryMillis` to `maxRetryMillis`, resets the delay only after a connection stayed open for one second, and stops when its scope closes. A throwing `onStatus` observer never stops the loop. It fails with `InvalidAttachOptions` for a malformed or non-loopback gateway URL, a malformed token, a non-finite or non-positive retry or open timeout, a `maxRetryMillis` below `initialRetryMillis`, or a root name with control characters.

  The subpath imports only `effect` core and `effect-frame/frame`. Import it from a development entry only; a production entry that does not import it carries no inspection, RPC, or socket code.

## 0.11.1

### Patch Changes

- [`4bf2d80`](https://github.com/cevr/effect-frame/commit/4bf2d80d3f0e9786d6b0f4c64003df4608743191) Thanks [@cevr](https://github.com/cevr)! - The `MailboxStore` conformance suite in `effect-frame/actor/testing` has two new cases. "a seen command ID is never admitted again" re-sends a committed ID after later commands and an advance and requires `Duplicate` with the first admission and its receipt, no pending entry, and no admission number spent. "a receipt outlives the retry bound" re-sends and reads the receipt once per pass of the 8-pass bound while other commands and autonomous changes commit, then requires the same receipt for a manual retry. A store that prunes receipts or re-admits a seen ID now fails the suite.

## 0.11.0

### Minor Changes

- [`900c30d`](https://github.com/cevr/effect-frame/commit/900c30da1eed6992a0ad1225f798a8a913796900) Thanks [@cevr](https://github.com/cevr)! - `send` now returns a command handle for local, durable, and remote references, and never fails. A handle has a `state` source (Sent, Admitted, Applied, Rejected, or Uncertain) and a `settled` effect. Durable and remote handles also carry `commandId` and `retry`. A local handle is never Uncertain.

  Durable and remote references own each command. The framework creates a fresh command ID with native secure crypto, or keeps a supplied `commandId`. A remote command runs one send and one same-ID call per pass, for up to 8 passes with a 10 second pass deadline and capped, jittered backoff. At exhaustion it stays `Uncertain{attempt: 8}` until `retry` settles it with the same ID and bytes.

  Breaking: `Applied.revision` is now a `CommittedRevision` (`{_tag: "Committed", value}`), and `ProvisionalRevision` is added. Wire, store, and change stream revisions stay numeric; `resumeCodec` decodes them as committed. `Receipt`, `SendError`, and the `Admitted` export are removed. `call` options for durable and remote references take an optional `commandId`. A remote `call` no longer fails with `Unreachable`: a lost reply or an unreachable host ends the wait with `Uncertain`, because the command may still commit. `CallError["remote"]` is now the remote rejections (`ActorStopped`, `CommandConflict`, `Unauthorized`, `ContractMismatch`, `UnknownContract`) or `Uncertain`.

  Remote commands claim their contract's live query entries, which stay stale until the last command settles and refresh after it applies. The claim is private to the cache that `queryCacheLayer` builds: `QueryCacheService` is unchanged, and a custom or wrapped cache keeps the public contract: the contract is invalidated when a command starts, and the reply's refreshes are applied when it settles. `Frame.inspect` now reports `commands` as `Available` with its retained records.

## 0.10.1

### Patch Changes

- [`adba70c`](https://github.com/cevr/effect-frame/commit/adba70c5b1182b35e5304e9d75e6dd66d355d548) Thanks [@cevr](https://github.com/cevr)! - Type `Frame.DiagnosticValue` as a `Schema.Codec`, not a `Schema.Schema`. A `Frame.Snapshot` schema then has no unknown encoding or decoding services, so a typed encode, decode, or RPC schema of a snapshot type checks. The runtime schema is unchanged.

## 0.10.0

### Minor Changes

- [`59211aa`](https://github.com/cevr/effect-frame/commit/59211aa3b290783512aa0857c5f62845151a9288) Thanks [@cevr](https://github.com/cevr)! - Add `View.attempt(setup, fallback)`. It runs one setup in a child Scope of its caller and keeps it open on success. On a typed failure, it closes the failed child and waits for its finalizers before the fallback starts in a fresh child. Defects and interruption skip the fallback, and a closed owner never starts either Effect. The result keeps the fallback's own error and requires `R | R2 | Scope`.

## 0.9.2

### Patch Changes

- [`ed2d341`](https://github.com/cevr/effect-frame/commit/ed2d341918a110cb3390f98e32673139b6812dfe) Thanks [@cevr](https://github.com/cevr)! - Fix keyed list reorder when rows swap. A moved row could anchor on a row that moved later, so a swap left rows out of order. A reorder now keeps the longest run of rows already in order and moves only the others, walking backwards so each anchor is already in its final place.

## 0.9.1

### Patch Changes

- [`982f1a9`](https://github.com/cevr/effect-frame/commit/982f1a9b1066447916909814bb85061f72dba84c) Thanks [@cevr](https://github.com/cevr)! - Type the router's not-found view with its own requirements. `mount` now requires the union of the routes' and the not-found view's services, so a not-found view can use `Router` or another service that no route needs.

## 0.9.0

### Minor Changes

- [`8bec38f`](https://github.com/cevr/effect-frame/commit/8bec38fe1e895401fd588860e1ac1a8c8c3cab45) Thanks [@cevr](https://github.com/cevr)! - Keep readiness content owners live while fallback presentation is active, including deferred keyed rows and nested boundaries. A queued attachment runs once after its node reaches the document, and it is dropped when its owner ends first.

  Add an optional host capability for constructing hidden nodes without claiming connected hydration nodes.

## 0.8.1

### Patch Changes

- [`b6b37a5`](https://github.com/cevr/effect-frame/commit/b6b37a586a142d9e62ddf31c8a19a212ed043481) Thanks [@cevr](https://github.com/cevr)! - Keep local actors and hosted durable implementations on their private command engines while preserving the existing actor and transport contracts.

## 0.8.0

### Minor Changes

- [`6359ee8`](https://github.com/cevr/effect-frame/commit/6359ee89d8f3367982507cddbd363ea9fb24f08a) Thanks [@cevr](https://github.com/cevr)! - Include bounded, optional Frame snapshots in failed ViewTest condition receipts.

## 0.7.2

### Patch Changes

- [`a7a6382`](https://github.com/cevr/effect-frame/commit/a7a6382750393bcf0c043968a21a1faf39d646c6) Thanks [@cevr](https://github.com/cevr)! - Keep dependent query entries stale after an admitted command send until a
  committed receipt or an authoritative refresh arrives. Committed duplicate
  sends retain their existing refresh behavior without applying the command
  again.

## 0.7.1

### Patch Changes

- [`6e2b399`](https://github.com/cevr/effect-frame/commit/6e2b399fd762928039aeac4ee81a147cdf33a5be) Thanks [@cevr](https://github.com/cevr)! - Release host event listeners with the branch, row, and mount scope that owns their element. Start view work only after that owner accepts it, so a closed owner cannot start stale handlers or attachment setup.

## 0.7.0

### Minor Changes

- [`e717f0a`](https://github.com/cevr/effect-frame/commit/e717f0ae7b1ed841043143273c4a66685604cd10) Thanks [@cevr](https://github.com/cevr)! - Add the browser-safe `effect-frame/frame` entry for scoped, schema-backed runtime inspection snapshots.

## 0.6.0

### Minor Changes

- [`a29c9b9`](https://github.com/cevr/effect-frame/commit/a29c9b900e3df3ed4891da62eceb331e23f14234) Thanks [@cevr](https://github.com/cevr)! - Add a scoped view testing harness that observes production host writes, owns
  mounted work, and reports bounded timeout diagnostics.

## 0.5.0

### Minor Changes

- [`d4eed34`](https://github.com/cevr/effect-frame/commit/d4eed349bd528dc1fba51f33adc5c3dd7efb1562) Thanks [@cevr](https://github.com/cevr)! - View-owned URL state with scoped encoded-key claims, canonical URL sources, serialized set and update operations, and explicit push operations.

### Patch Changes

- [`2647ee1`](https://github.com/cevr/effect-frame/commit/2647ee1e574eeb56628717a3e2e5225d8e524b48) Thanks [@cevr](https://github.com/cevr)! - Readiness registrations now leave `Loading` and `Errored` scopes with their owner scope, so removed or disposed view branches cannot keep a boundary pending or failed.

## 0.4.0

### Minor Changes

- [`2bf0bd8`](https://github.com/cevr/effect-frame/commit/2bf0bd8ee1eae2324495558ff83c154bb6c40568) Thanks [@cevr](https://github.com/cevr)! - Add local transport and query-host helpers for testing the real query cache.

## 0.3.0

### Minor Changes

- [`47cdfb0`](https://github.com/cevr/effect-frame/commit/47cdfb06f6dbc209085a0b6cb8e46d99178b3f5d) Thanks [@cevr](https://github.com/cevr)! - Attached behaviours and `Portal`. An element takes `attach={...}`: one or more behaviours, each an Effect given the host node (`Dom.attach((element) => Effect)`, `Tui.attach`), run once the node is in the document, in the scope of the branch or row that owns the element, so a listener, an observer, or a fiber the behaviour opened ends when the element leaves. There is no node reference. The server host never runs a behaviour. `<Portal into={node}>` draws children under another host node, owned by the branch that opened it. Hosts gain one operation, `attach`.

- [`e3ddec5`](https://github.com/cevr/effect-frame/commit/e3ddec54ede6d73bb77e79f9a44ad426e87a8f72) Thanks [@cevr](https://github.com/cevr)! - Add declared batched query contracts with per-key states, HTTP batching, authorization isolation, and single-flight refresh support.

- [`841a233`](https://github.com/cevr/effect-frame/commit/841a2331f1d046c6bb1fae152c3ebd4d9da4b8e6) Thanks [@cevr](https://github.com/cevr)! - Composable DOM behaviours: `Dom.focus(options)`, `Dom.scrollIntoView(options)`, and `Dom.observeSize(onSize)` are attachments a view lists on an element, `attach={[Dom.scrollIntoView({ block: "nearest" }), Dom.focus()]}`, each run once the element is in the document and ended with it. `Dom.afterPaint` is the Effect a behaviour yields when it needs layout first.

- [`c40ed46`](https://github.com/cevr/effect-frame/commit/c40ed46709abd122d78f2da64cb3f799f258c6dc) Thanks [@cevr](https://github.com/cevr)! - `Match`: exhaustive control over a source of a tagged union. `<Match on={state} cases={{ Idle: () => ..., Running: (s) => ... }} />` takes the case table of Effect's `Match.tagsExhaustive`, draws one branch, hands each case a source of its own member, and updates a kept tag in place. `Query` is now one `Match` over `QueryState`. `QueryState.match` takes the same case shape (`Ready: (state) => ...`, not `(value, stale)`) and has a curried form, `match(cases)`, that builds its matcher once for hot paths; `tests/perf/match.bench.ts` records why.

- [`ccf6470`](https://github.com/cevr/effect-frame/commit/ccf6470b26e461df5f65e3872c0f01286955f51d) Thanks [@cevr](https://github.com/cevr)! - Add scoped `Source.debounce`, `Source.throttle`, and `Source.mapEffect` derivations.

- [`8946cbf`](https://github.com/cevr/effect-frame/commit/8946cbf73f994a980b732889af6d834e80dc0db6) Thanks [@cevr](https://github.com/cevr)! - Typed links. `link(route, params, search)` yields a `Link` in a view's setup: the live href printed through the route's own Schemas, `active` (a source, `true` while the document is on that route), and separate `go` (push) and `replace` effects. `<Link link={l} replace class>` draws it as an anchor with a real `href` and `aria-current="page"`. `router.current` is a source of the current match (route name and URL), and `isActive(router, route)` derives from it.

- [`dd95567`](https://github.com/cevr/effect-frame/commit/dd95567ad5d4d51ec6ecf49db87d3c6269a1c0fd) Thanks [@cevr](https://github.com/cevr)! - Schema-driven route search state: omitted defaults, encoded key mapping, repeated values with lossless empty-array markers, string literal and union fields, serialized functional updates, retained keys, and separate push and replace navigation.

- [`c5917f5`](https://github.com/cevr/effect-frame/commit/c5917f51c84d9f993069c6f1c465d4efbcbdb73b) Thanks [@cevr](https://github.com/cevr)! - A view is a function. `View.make` is removed: a view is `(props) => Effect<Node, E, R>`, and a named view is `Effect.fn("Name")(function* (props) { ... })`. Compose a child with `yield* Child(props)`. `Loading`, `Errored`, and `Await` are now plain views: call them with their props and `yield*` the result. `View.list` names its row view `row`, not `setup`. `Route.spa` is renamed `Route.client`.

### Patch Changes

- [`a9d6665`](https://github.com/cevr/effect-frame/commit/a9d666500e0fb39c433a771d6f5c40f7967334bd) Thanks [@cevr](https://github.com/cevr)! - A keyed list (`For`, `View.list`) now moves only the rows whose position changed. Before, every emission re-inserted every row's nodes, which moved them in the document and dropped focus, selection, and scroll inside a row that had not moved.

## 0.2.0

### Minor Changes

- [`8559a4b`](https://github.com/cevr/effect-frame/commit/8559a4b3004d363a7e47e1a6c60c1fb7850534db) Thanks [@cevr](https://github.com/cevr)! - `Cell.make(initial)` is the local value a view keeps: `{ state, get, set, update }`, a `Behavior.value` actor underneath, and a write after its scope closed is a no-op. `Source.all({ a, b })` and `Source.all([a, b])` build one source from several with `zip`'s re-read rule, and `Source.on(source, f)` follows a source on a fiber in the current scope. The combinators are also exported flat (`all`, `on`, `select`, `zip`).

- [`8559a4b`](https://github.com/cevr/effect-frame/commit/8559a4b3004d363a7e47e1a6c60c1fb7850534db) Thanks [@cevr](https://github.com/cevr)! - `View.bind`, `View.event`, `View.submit` and `View.select` are module functions, and `View.Context` and `Capabilities` are gone. `bind` was already data, and a prepared event is now data too: the runtime forks the handler into the scope of the branch or row that owns the element, when the host fires. A plain function that returns a `Node` needs nothing from the view that calls it; a setup that reads no service needs no generator. Migration: delete `const view = yield* View.Context` and replace `view.bind` with `View.bind` (and so on), and drop `View.Context` from any `R` you named.

- [`8559a4b`](https://github.com/cevr/effect-frame/commit/8559a4b3004d363a7e47e1a6c60c1fb7850534db) Thanks [@cevr](https://github.com/cevr)! - Contracts and hosts say less. `query()` defaults `version` to 1, `depends` to none and `policy` to `"public"`, and every host resolves `"public"` without a `QueryPolicies` layer (a table entry of that name still replaces it). `ActorHost.layer` no longer requires `store`: omitted, each actor gets an in-memory mailbox, which is what a query-only host or a test wants.

- [`8559a4b`](https://github.com/cevr/effect-frame/commit/8559a4b3004d363a7e47e1a6c60c1fb7850534db) Thanks [@cevr](https://github.com/cevr)! - `View.list({ each, keyBy, setup })` is a keyed list whose rows run a setup Effect in a scope of their own: a row may make cells, follow queries and add finalizers, and the scope closes when the row leaves. A setup that completes at once builds before the mount returns; one that suspends lands in its place when it completes, and the mount closing interrupts it. `list` is an Effect, not a JSX element, because it captures the context it is yielded in and the enclosing view's `R` names what the rows need. `<For>` is unchanged and is the plain case of the same node.

- [`8559a4b`](https://github.com/cevr/effect-frame/commit/8559a4b3004d363a7e47e1a6c60c1fb7850534db) Thanks [@cevr](https://github.com/cevr)! - `Show` narrows. `when` takes any source with an `is` test (a type predicate narrows), the children may be a function of a source of the tested value that exists only while the branch is shown, and `fallback` draws otherwise. `Query` is the one control for a query's three states: `loading`, `failed(error)` and `ready(value, stale)`, each a source, with no placeholder value to name. `Await` is `Query` as a view and drops `before`. `QueryState` gains `isLoading`, `isReady`, `isFailed` and `match` (also under the `QueryState` name in both entries), and `QueryFailure` is a Schema with an `isQueryFailure` guard, so an `Errored` fallback narrows its `unknown` in one call.

### Patch Changes

- [`8559a4b`](https://github.com/cevr/effect-frame/commit/8559a4b3004d363a7e47e1a6c60c1fb7850534db) Thanks [@cevr](https://github.com/cevr)! - Document that an event handler's write lands after the host callback returns: the handler runs on a fiber of its own, so a script that fires an event and reads an actor in the same tick reads the old value.

- [`8559a4b`](https://github.com/cevr/effect-frame/commit/8559a4b3004d363a7e47e1a6c60c1fb7850534db) Thanks [@cevr](https://github.com/cevr)! - Give `ready`, `readyWithStale`, `orErrored`, `fakeQuery` and `Router.mount` explicit signatures. tsgo emitted their `Effect.fn` generics as unbound type parameters with `unknown` error and requirement types, which made every consumer of the published declarations infer `unknown` and fail to type check.

- [`8559a4b`](https://github.com/cevr/effect-frame/commit/8559a4b3004d363a7e47e1a6c60c1fb7850534db) Thanks [@cevr](https://github.com/cevr)! - A `Show` branch and a `For` row are built untracked inside the effect that switches them, so their first reads no longer trigger Solid's strict-mode untracked-read warning.

## 0.1.0

### Minor Changes

- First published release: actors, queries, views and the router, as proven by the egw-search port.
