# Declared route data and the rendering modes

> Decision record: it explains a choice as of its day, and its code may be
> out of date. The reference is [the package README](../../packages/effect-frame/README.md)
> and the JSDoc.

This note records how #36 finishes the package half of #18: declared route
data on the server, the rendering-mode constructors, and the server
document the router renders. It builds on the nested transition
([nested-transition.md](nested-transition.md)), the public route model
([route-public.md](route-public.md)), streamed documents (#22,
[streaming.md](streaming.md)), and authorization (#85,
[authorization.md](authorization.md)).

## The model

A route tree is one value. Its mode constructor decides how the server
renders it; the same segments, views, and declarations run on both sides.

```ts
const App = Route.ssr("app", Route.layout(tenant, [Route.leaf(post, PostView)], TenantView));

// In the request's Scope:
const outcome =
  yield * renderDocument({ routes: [App, Login], notFound, url, document, closeWhen, principal });
// outcome: { _tag: "Redirect", location }                      -> answer 303
//        | { _tag: "Rendered", route, mode, status, body }     -> answer status, stream body
// route:  { _tag: "Matched", route: App } | { _tag: "NotFound" }
// fails:  DocumentTimedOut { phase: "settle" | "draw" | "agree" } -> for example 504
```

A request goes through three steps:

1. **Settle.** Match the URL, as `mount` does, and run the matched route's
   checks, parent first, whatever its mode. A redirect is the answer.
2. **Prepare.** Choose the pipeline from the settled route's mode, mount
   the router on the HTML host with that settlement (no check runs again),
   and draw the first frame.
3. **Write.** Return the body. Only a `Streamed` body goes on writing after
   the first chunk, from the drawing that step 2 left in the request Scope.

`closeWhen` runs once, in the request Scope. Steps 1 and 2 must end before
it completes, or the render fails with `DocumentTimedOut` and closes what
it opened. After step 2, `AwaitAll` serializes what it has and `Streamed`
writes `Closed` when it completes, as in #22.

| Constructor      | Mode         | The server, after its checks passed                                                                |
| ---------------- | ------------ | -------------------------------------------------------------------------------------------------- |
| `Route.client`   | `ClientOnly` | Writes the document with an empty mount element. It draws nothing and reads nothing.               |
| `Route.ssr`      | `SSR`        | Resolves every query the matched branch declares, in parallel, then draws once with a seed script. |
| `Route.awaitAll` | `AwaitAll`   | Draws, then waits until every read settled and no `Loading` shows its fallback (#22).              |
| `Route.streamed` | `Streamed`   | Writes the shell at once, a `Placeholder` per declared query, then one `Patch` per query (#22).    |

`renderDocument` mounts the same router the client mounts, on the HTML
host, over a fresh query cache (#28), with a `Location` that stays at the
request URL. `SSR` provides `ResolveBeforeRender`: the transition's
`acquire` waits for each declared query to leave `Loading` before the view
sets up. The transition already acquires a branch's declarations in
parallel, so the layout's and the leaf's reads start together, and the
query cache counts interest, so a key the layout and the leaf both declare
opens one entry.

Every read goes through `ActorTransport` under the `CurrentPrincipal` the
caller provides. Each route query names its policy on its contract (#85),
so a refused read is seeded as the refusal, and the value never reaches
the document.

## The route domain

A route is a codec, and a URL cannot carry every string both ways. The
domain is:

- a path segment, a scalar param's or each item of a tail's, is
  well-formed text (no lone surrogate), not empty, and not `.` or `..`;
- a search key or value is well-formed text.

Inside the domain, `parse(href(params, search))` is the same values.
Outside it, the printers (`href`, `hrefAt`, `hrefFrom`,
`Route.printSearch`, and every link and target that prints through them)
die with `Route.UrlValueRejected { name, reason }`, where `reason` is
`"empty segment"`, `"dot segment"`, or `"lone surrogate"`. They never write
a URL that parses as other values. Parse refuses the same values: a raw
pathname with `%2E`, `%2E%2E`, or an escape that is not UTF-8 does not
match. An empty segment is no segment both ways: `href` refuses one, and
`matchPath` reads `/a//b` as `a` and `b`.

## Decisions

1. **A mode is the mount constructor.** No author writes a mode field.
   The constructor stamps the mode under the route's brand (`RouteBrand`
   in `codec.ts`), so only a mode constructor makes a route, and every
   route knows how it renders. Not-found's mode is the named constant
   `notFoundMode`. The names
   are #22's: `ClientOnly`, `SSR`, `AwaitAll`, `Streamed`. `driven` is not
   built.
2. **`Route.client` keeps its name.** It is the `ClientOnly` constructor.
   Renaming it would break every caller for no gain. The other three are
   `Route.ssr`, `Route.streamed`, and `Route.awaitAll`. All four have the
   same two call forms: a branch of a root segment, or the one-leaf flat
   definition.
3. **`ClientOnly` draws nothing on the server.** #18 §6 names it the spa
   mode: the server reads nothing. #22 once described it as "a shell with
   fallbacks", but a shell that the client throws away costs a render and
   proves nothing. The client mounts into the empty element. Its checks
   still run on the server (decision 7).
4. **`SSR` is not `AwaitAll`.** `SSR` waits only for the matched branch's
   declared route data, then draws once. A read a view starts in its own
   setup is not route data, so the client reads it. `AwaitAll` keeps the
   drawing live until every read settled. Both write one seed script and
   no record channel.
5. **`closeWhen` bounds the whole preparation (round 1 review).** The
   settlement and the first drawing race the limit. When the limit wins,
   `renderDocument` fails with `DocumentTimedOut { phase }`, a typed error,
   and no outcome member: nothing was written, so the caller answers as it
   chooses (for example 504, or a `ClientOnly` document of its own). The
   race interrupts the check or the drawing, and the drawing's Scope is
   closed at once. After the first drawing, a drawing whose seed still
   disagrees with it at the limit fails `DocumentTimedOut { phase: "agree" }`
   (streaming review round 2). An `SSR` render whose declared data has not settled at
   the limit is therefore `DocumentTimedOut` too: the mode's promise is a
   document with its route data, so a document without it is not an
   `SSR` document. The first version drew what had settled; that is
   withdrawn. A limit that has already completed times out any
   preparation that must wait at all, so `closeWhen` should not be
   immediate.
6. **Resolve-before-render is server-only.** `ResolveBeforeRender` defaults
   to false, so a client transition never blocks its commit on data; it
   keeps the nested-transition rules (`Loading`, `pending`).
7. **The request settles before the mode is chosen (round 1 review).**
   The first version chose the route and its pipeline before the router
   ran the checks, so an `SSR` route that redirected to a `ClientOnly`
   route drew the destination on the server and reported the source, and
   a `ClientOnly` route answered without its check. Now `settleRequest`
   matches the URL and runs the matched route's checks first, for every
   mode, because a check guards access and a redirect is a server answer.
   A redirect is the outcome `Redirect { location }`, for a `303 See
Other`; the render does not follow it, and the browser's next request
   runs the target's checks. A redirect to the request URL itself is the
   `RedirectCycle` defect. The router the render mounts receives the
   settlement through the internal `SettledRequest` reference and runs no
   check again. A server check sees a `Router` at the request URL whose
   `push` and `replace` die with `CheckNavigation`, as a client
   check's do.
8. **A rendered document names its route by identity, with a status.**
   `route` is `{ _tag: "Matched", route }`, the route value itself, or
   `{ _tag: "NotFound" }`, so a user route named `"not-found"` is never
   taken for the fallback. `status` is 404 for not-found and 200 otherwise.
   A hand-written `AnyRoute` and not-found render as `SSR`.
9. **`renderDocument` runs in the request Scope.** The limit runs there
   once, for both steps, and a `Streamed` body keeps its drawing there, so
   the caller runs the body before it closes that Scope. The body itself
   needs nothing and cannot fail.
10. **One query cache per request, for the checks and the drawing (round
    2 review).** Round 1 gave the checks a cache of their own, so one
    request held two caches, against #28. Now `renderDocument` builds one
    cache in the request Scope and gives it to the settlement and, through
    an internal `CacheSource` parameter, to the `SSR`, `AwaitAll`, and
    `Streamed` pipelines. The public `Html.renderToString`,
    `renderToStream`, and `renderAwaitAll` still build a fresh cache each.
    The checks' interests live in a Scope of their own that closes once
    the mounted router has declared the drawing's data, before any value is
    written. So a query that a check and the page both read is read once,
    its entry is reused, and it is written once; a query only a check read
    is released and never written into the document. The cache is released
    when the request Scope closes.
11. **The `Html` namespace lists its exports.** The router needs the #22
    pipelines over its own drawing, not over one view: `Drawing`,
    `streamPrepared`, `streamDrawing`, `awaitAllDrawing`, `renderSeeded`,
    `requestCache`, and `CacheSource`. They stay internal. `html-public.ts` lists the
    public names, which are unchanged.
12. **A `Streamed` tree needs `Loading` around what waits.** The first
    frame is the shell. A view that binds a query's state directly, with no
    boundary, draws `Loading` text that the later patch changes, and the
    client reports a text mismatch. With a boundary, the client claims the
    fallback and swaps it when the patch lands. Gap: no development-time
    diagnostic finds such a view yet. A constructor cannot inspect an
    effectful view for what it will read.
13. **The route domain is enforced where a URL is printed and parsed
    (round 1 review).** The first version proved the round trip only over
    Schemas narrowed to the domain, while a public `Schema.String` route
    printed wrong URLs outside it. Now the printers refuse a value outside
    the domain with the `UrlValueRejected` defect, and parse refuses the
    same values (see "The route domain"). The domain is not refined into
    each params Schema: the printers are the one place every href goes
    through, url-state included, and a Schema refinement would still need
    them for the path printer and `Route.printSearch`.
14. **Prerender is a fifth mode constructor (#86).** `Route.prerender`
    takes `inputs`, and a call without them does not compile. It registers
    `AwaitAll`, so a prerender URL with no built file renders through this
    same pipeline. The build calls `settleAndPrepare`, the settle and
    prepare half of `renderDocument`, once per input. See
    [prerender.md](prerender.md).
15. **The first frame holds the outlet's first instance (#37).** The
    outlet was a keyed list of at most one instance, and a list row sets
    up after the frame. So a layout that yields its outlet inside
    `Loading`, the pattern in [nested-transition.md](nested-transition.md),
    drew that `Loading`'s fallback in an `SSR` document although the data
    had settled, and an `AwaitAll` document drew the content that the
    client's first frame then threw away (`resolvedAhead` 1). The Notes
    example found it. Now the outlet sets up the instance it holds when the
    layout yields it, inside the layout's setup, as the tree already did
    for its root, and that instance's row takes the node. Its `ready` reads
    register while the `Loading` sets up, so a settled branch draws its
    content on the first frame on both sides. Each setup still runs in the
    instance's own view Scope. An instance that presents `pending` is left
    to its row, so its timing still starts when the parent is drawn (route
    pending, 10a and 10b). A streamed document whose patches all arrived
    before hydration now draws the patched content on the client's first
    frame, and the report counts one `resolvedAhead`, as #22 specifies.
    Mutants: setting the held instance up in its row again makes both new
    tests red (killed); holding an instance that presents `pending` too
    makes route pending 10a and 10b red (killed).
16. **A route actor is seeded into the document (#37).** A route that
    declares `Route.actor` opened a reference that read the actor's
    snapshot, on the server and again on the client. The client's first
    frame had no snapshot, so a view that drew the actor drew it one
    frame late, and a page that needed the value on the first frame read
    it through a query as well. The Notes example did this: `ListNotes`
    was a query that only carried the notes actor's state to the first
    frame. Now the server's route holds its reference's committed
    projection (revision and encoded snapshot) in the request cache's
    document while the route holds the reference. The document carries
    each held projection beside the drawing: `SSR` and `AwaitAll` in
    `<script type="application/json" id="frame-actor-seed">`, `Streamed`
    as `ActorSeed` records at the head of the first chunk. The
    projection is read with the query seed inside `readDrawn`, so the
    seed is the revision the drawing shows. The client's route opens its
    reference with `resume` from the seed, at the seed's revision, and
    reads no snapshot. A seed is not taken away: every opening of the
    actor while the page hydrates starts from it. `Resumed.hydrated` drops every
    actor seed with the query seeds, so a route opened later reads the
    actor. A seed whose snapshot does not decode is ignored, and the
    route reads.

    `Route.actor(contract, key, { behavior })` gives the route's
    reference the actor's behavior, so the view sends through the route's
    one reference and a fresh send is predicted at once. The alternative
    was a second reference in the view, resumed from the binding. It
    would hold a second change stream and a second command owner for the
    same actor on one page, and its prediction and the route's view of
    the actor could disagree. The behavior is erased inside the
    declaration's `open`, so any contract's declaration is still one
    `Declaration`.

    Declarations of one address in one tree share one reference (review
    round 2). The tree keeps its route actor references in an `RcMap`
    keyed by the address, so a layout and its leaf that declare one actor
    hold one reference, released when the last of them exits. Before, each
    declaration opened its own. On the server the layout could open at
    revision 1, a commit land, and the leaf open at revision 2 while the
    layout's change stream lagged: the drawing showed both revisions, the
    document carried two seeds for one address, the client kept the first,
    and the leaf did not hydrate (`text "5" became "4"`). The alternative
    was to key a seed to the declaration that drew it. It would hydrate,
    but it keeps two references to one actor on one page: two change
    streams, two command owners, and two views of the actor that can show
    different revisions after hydration too. One reference per address
    makes one revision the only thing there is to draw. The first
    declaration to open the address decides its options (its `behavior`).

    The seeding lives at the document the query seeds already use, the
    lowest owner that both hosts and the router reach. The actor stays a
    reference, not a query: its commands, predictions and refusals keep
    their one path.

## Evidence

All tests are in `packages/effect-frame/tests/router/`.

| Claim                                                                                | Test                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A route prints what it parses, in its domain                                         | `route.test.tsx` — "parse(href(params, search)) is the same values, or href refuses: …", five templates over `Schema.String` params, 300 runs each                                                                                                                                                                        |
| Out of the domain, href refuses and parse refuses                                    | `route.test.tsx` — "href refuses each value a URL cannot carry both ways, and names the param", "parse refuses what href refuses: …"                                                                                                                                                                                      |
| A search reorder and an absent optional key                                          | `route.test.tsx` — "a search reorder and an absent optional key still match, with the same values"                                                                                                                                                                                                                        |
| A three-deep branch and a tail with children                                         | `route-data.test.tsx` — "a three-deep branch matches one URL, …", "a parent that ends in a tail cannot have children"                                                                                                                                                                                                     |
| A layout wraps its child at the outlet                                               | `route-data.test.tsx` — "a layout's view wraps its child's at the outlet"                                                                                                                                                                                                                                                 |
| SSR resolves declared data before render                                             | `route-data.test.tsx` — "an SSR render resolves the branch's declared data before render, and the client hydrates with no read"                                                                                                                                                                                           |
| Streamed, AwaitAll, ClientOnly                                                       | `route-data.test.tsx` — one test per mode                                                                                                                                                                                                                                                                                 |
| A settled outlet inside `Loading` draws its content on the first frame               | `route-data.test.tsx` — "an SSR layout that puts its outlet in Loading draws the leaf, and the client claims it", "an AwaitAll layout that puts its outlet in Loading draws the leaf, and the client claims it"; both red before decision 15                                                                              |
| Not-found is 404, and no user route may be named not-found                           | `route-data.test.tsx` — "a URL no route matches renders not-found as SSR, with status 404", "a document refuses a route named not-found: the name is the router's own"                                                                                                                                                    |
| The request settles first; a redirect is the answer                                  | `route-data.test.tsx` — "an SSR route that redirects to a ClientOnly route answers Redirect, and draws nothing", "a ClientOnly route runs its checks on the server, and a redirect is the answer"                                                                                                                         |
| One cache per request: a query read once and written once, released with the request | `route-data.test.tsx` — "a query the check and the page both read is read once and written once: SSR / AwaitAll / Streamed", "closing the request Scope releases the request cache and stops its reads"                                                                                                                   |
| The mounted router does not settle again                                             | `route-data.test.tsx` — "a route that passes its checks is settled once: …"                                                                                                                                                                                                                                               |
| The limit bounds the preparation                                                     | `route-data.test.tsx` — "a check that never answers times out at the limit, and is interrupted", "an actor snapshot that never answers times out at the limit, and the render closes: SSR / Streamed / AwaitAll", "an SSR render whose declared data has not settled at the time limit times out, and releases its reads" |
| A mode is a constructor                                                              | `route-data.test.tsx` — "each mode is its own constructor, and no route value carries a mode"                                                                                                                                                                                                                             |
| Only unshared keys are released                                                      | `route-data.test.tsx` — "the leaf exits and the shared key stays; the layout exits and it goes"                                                                                                                                                                                                                           |
| Reads are checked under the request's principal                                      | `route-data.test.tsx` — "an anonymous SSR render of a protected route query seeds the refusal, never the value", "the same render under a signed-in principal seeds the value"                                                                                                                                            |
| A route actor is seeded, and the client reads no snapshot                            | `route-actor-seed.test.tsx` — "SSR / Streamed / AwaitAll: the client's route opens the actor from the document and reads no snapshot"                                                                                                                                                                                     |
| The actor seed is the revision the drawing shows                                     | `route-actor-seed.test.tsx` — "SSR / Streamed / AwaitAll: the seed and the drawing agree while the actor moves"                                                                                                                                                                                                           |
| After hydration a route reads the actor; an untaken seed is dropped                  | `route-actor-seed.test.tsx` — "after hydration, a route that opens the actor again reads it, never the seed", "a seed no route took by the end of hydration is dropped: the route reads"                                                                                                                                  |
| A layout and its leaf share one reference: one revision drawn, one seed              | `route-actor-seed.test.tsx` — "a layout and its leaf that declare one actor both open it from the seed", "a layout and its leaf on one actor draw one revision when a commit lands between their opens" (red before the shared reference: two seeds, `[[1,"4"],[2,"5"]]`, and the mismatch `text "5" became "4"`)         |
| A route actor with a behavior predicts                                               | `route-actor-seed.test.tsx` — "a route actor with a behavior predicts a send before its reply"                                                                                                                                                                                                                            |
| A cross-origin link is left to the browser                                           | `router.test.tsx` — "a link to another origin is left to the browser"                                                                                                                                                                                                                                                     |

## Mutations

Each mutation was applied alone, the named test file was run, and the
change was reverted.

| Mutation                                                      | Result           | Test that failed                                                           |
| ------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------- |
| Remove the SSR wait in `acquire` (`resolved` returns at once) | Killed           | the SSR tests (6)                                                          |
| Every constructor registers `SSR`                             | Killed           | the Streamed, AwaitAll, ClientOnly, and constructor tests (4)              |
| `ClientOnly` draws the page as `SSR`                          | Killed           | "a ClientOnly render draws nothing and reads nothing"                      |
| A tail param is not percent-encoded                           | Killed           | the round-trip property (6 tests)                                          |
| A literal is not percent-encoded                              | Killed           | "… or href refuses: /c#s?/:id"                                             |
| `printPath` does not refuse an out-of-domain segment          | Killed           | the round-trip property and the refusal cases (4)                          |
| `printSearch` does not refuse a lone surrogate                | Killed           | the round-trip property and the refusal cases (5)                          |
| Parse admits an out-of-domain segment                         | Killed           | "parse refuses what href refuses: …"                                       |
| Dot segments are in the domain                                | Killed           | the refusal cases (2)                                                      |
| `settleRequest` runs no check                                 | Killed           | the redirect, settled-once, and check-timeout tests (4)                    |
| The mounted router settles again                              | Killed           | "a route that passes its checks is settled once: …"                        |
| Not-found answers 200                                         | Killed           | the two not-found tests                                                    |
| A route named `"not-found"` is taken for the fallback         | Killed           | "a document refuses a route named not-found: the name is the router's own" |
| The settlement does not race the limit                        | Killed (timeout) | "a check that never answers times out at the limit, …"                     |
| The drawing does not race the limit                           | Killed (timeout) | the three actor-snapshot tests and the SSR limit test                      |
| The drawing's Scope is not closed when the preparation fails  | **Survived**     | none: see below                                                            |
| The checks read a cache of their own                          | Killed           | the three read-once tests                                                  |
| The SSR drawing builds its own cache                          | Killed           | "… read once and written once: SSR"                                        |
| The AwaitAll drawing builds its own cache                     | Killed           | "… read once and written once: AwaitAll"                                   |
| The Streamed drawing builds its own cache                     | Killed           | "… read once and written once: Streamed"                                   |
| The checks' interests outlive the drawing                     | Killed           | the three read-once tests (the check-only query is written)                |
| The request cache outlives the request Scope                  | Killed           | "closing the request Scope releases the request cache and stops its reads" |
| The render's Scope is not a child of the request Scope        | Killed           | "closing the request Scope releases …" (the view never closes)             |
| `followable` drops the origin check                           | Killed           | "a link to another origin is left to the browser"                          |
| An exited slot closes its view but does not release           | Killed           | "the leaf exits and the shared key stays; the layout exits and it goes"    |
| The client's route ignores the actor seed                     | Killed           | the three "reads no snapshot" tests (`route-actor-seed.test.tsx`)          |
| The server's route does not hold its projection               | Killed           | the three "reads no snapshot" tests (no seed is written)                   |
| `expire` does not drop the actor seeds                        | Killed           | "a seed no route took by the end of hydration is dropped …"                |
| `Route.actor` drops `behavior`                                | Killed           | "a route actor with a behavior predicts a send before its reply"           |
| The first route that opens the actor takes the seed away      | **Survived**     | none: see below                                                            |
| Each declaration opens its own reference (no `RcMap`)         | Killed           | "a layout and its leaf on one actor draw one revision when …"              |
| `SSR` reads the actor seeds before the drawing, not with it   | Killed           | "SSR: the seed and the drawing agree while the actor moves"                |
| `AwaitAll` reads the actor seeds after the agreed read        | **Survived**     | none: see below                                                            |

The surviving mutation: when the race interrupts a drawing, each
declaration's own Scope closes on the interruption, so the reads it
opened stop, and `SSR` and `AwaitAll` close their own Scope as well. For
`Streamed`, the explicit close of the drawing's Scope releases only the
request cache, which by then holds no entry, and the request Scope would
release it later anyway. No test can see the difference, so the close
stays as a guarantee that does not depend on how the pipeline is built.

The first surviving actor-seed mutation: a tree opens each address once,
so a seed taken away by that opening is never missed there. A second
opening during hydration would need a second tree over the same cache,
such as a deferred module that mounts before `Resumed.hydrated`, or the
shared reference closing and opening again before then. No test does
either; the seed is kept until `expire` so that such an opening starts at
the revision the markup shows.

The second: `AwaitAll` serializes its live tree
after the last read, and the tree has caught up with the actor by then,
so an actor seed read after the agreed read still names what the markup
shows. The agreement stays so that the three modes read one instant the
same way.
