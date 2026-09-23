# effect-frame

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
