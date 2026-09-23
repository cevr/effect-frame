# Prerender

This note records how #86 builds the prerender design of #23: the inputs a
prerender route lists, the build that renders them, the server that answers
with what the build wrote, and how a loaded page resumes. It lists the
decisions that the ticket left to the build and the places where the build
differs from the ticket text, because the stack changed after #23 was
written. The ticket stays the source of the design.

Sources:

- `packages/effect-frame/src/router/prerender.ts` (browser safe):
  `Route.inputs`, the definition-time refusal, and the enumeration.
- `packages/effect-frame/src/router/branch.ts`: `Route.prerender`, the
  mode constructor.
- `packages/effect-frame/src/router/prerender.server.ts` (server only,
  `effect-frame/router/prerender`): `build`, `load`, `serve`, the manifest,
  `oneInstant`, and the build failures.
- `packages/effect-frame/src/router/prerender-output.server.ts` (server
  only): the output directory, its lock, its generations, and publishing.
- `packages/effect-frame/src/router/document.ts`: `settleAndPrepare`, the
  settle-then-prepare half of `renderDocument` that the build shares.
- `packages/effect-frame/src/view/hosts/html.ts`: `awaitAllPage`, the
  `AwaitAll` document with its seed stamped with `builtAt`.
- `packages/effect-frame/src/actor/streaming.ts` and `query-client.ts`:
  `Patch.builtAt`, and the stale seed that revalidates.

## The model

```ts
const org = Route.segment("org", { path: "/:org", params: OrgParams });
const post = Route.child(org, "post", { path: "posts/:slug", params: PostParams });

const Posts = Route.prerender("posts", Route.layout(org, [Route.leaf(post, PostView)], OrgView), {
  inputs: [
    Route.inputs(org, listOrgs), // Effect<ReadonlyArray<{ org }>>
    Route.inputs(post, ({ org }) => listPosts(org)), // once per org
  ],
});

// A build script, server side:
const buildSite = Effect.gen(function* () {
  yield* Prerender.build({
    routes: [Posts, About, App],
    notFound,
    document: (page) => Effect.succeed(documentFor(page)),
    client: bundleText, // Effect<string>: the app's browser bundle
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

A build goes through four steps:

1. **Enumerate.** Each prerender tree runs its inputs, parent first. A
   child's inputs run once for each parent record, and a leaf is one page
   per product. Each page prints its URL with its leaf's `href`.
2. **Render.** Each page renders through `settleAndPrepare`, the same
   settle and prepare `renderDocument` runs, in `AwaitAll`, as `Anonymous`,
   with its own query cache, at the URL `href` printed.
3. **Write.** Each page is written to `<href>/index.html` in a staging
   directory under `out`, with `client.js` and then `manifest.json`.
4. **Publish.** The staging directory moves into `generations` with one
   rename, and `current.json` is replaced with one rename. A build that
   fails or is interrupted before that last rename leaves the previous
   generation published.

```text
<out>/current.json          { "generation": "<id>" }: the published build
<out>/generations/<id>/     one complete build: pages, client.js, manifest.json
<out>/staging/<id>/         a build still being written; never served
<out>/build.lock            held by the one build that writes <out>
```

`load(out)` reads one generation, and the `Site` it returns reads only
that generation's files. The server looks up the raw pathname in its
manifest before the router runs. A hit reads the file, then compares
`If-None-Match` with the page's strong `ETag`: a match answers 304, and
anything else answers the bytes. A file that cannot be read, and any other
path, goes to the router, which renders the same tree in `AwaitAll`, so a
missing file is a slower answer, not a different one. HEAD answers as GET
does, with no body.

## Decisions

1. **Inputs are entries of the mode constructor, not a layout mode.** #23
   §1.2 wrote `Layout.prerender(...)` for a parent that enumerates. In the
   stack as built, a mode is per tree (`docs/design/route-data.md`
   decision 1), and a segment carries no mode. So a tree names its inputs
   in its constructor, `Route.prerender(name, branch, { inputs: [...] })`,
   one `Route.inputs(segment, enumerate)` per segment that adds a param.
   The flat form takes `inputs` in its definition. A call without `inputs`
   does not compile.
2. **The refusal is at definition time, and names the ancestor and the
   param.** A segment that adds a path param and names no inputs cannot be
   enumerated, so `Route.prerender` throws
   `PrerenderAncestorNotEnumerable { route, leaf, ancestor, param }`. The
   leaf itself counts as an ancestor: a leaf that adds a param must name
   its inputs too. A segment that adds no param needs no inputs and gives
   one page per parent. Inputs for a segment outside the tree, or twice for
   one segment, are refused with `PrerenderInputsRejected`.
3. **Inputs return only a segment's own params.** A child's function
   receives what its ancestors enumerated and returns the params it adds.
   The build merges them and checks the result with the leaf's params
   Schema before it prints. The types enforce it: a child that returns no
   own param does not compile.
4. **The inputs' failures and services ride on a phantom.** Mounting a
   prerender tree in a router does not require what its inputs need. The
   build requires it, through `PrerenderError` and `PrerenderServices`.
5. **A prerender tree registers `AwaitAll`.** The server fallback for a
   prerender URL with no file is the same pipeline, so its document is the
   built one without `builtAt` (proven byte for byte).
6. **Each page has its own query cache; the build reads one instant.**
   The build puts one transport, `oneInstant`, in front of
   `ActorTransport`. It reads each query key, each batch key, and each
   actor snapshot once, and answers every later ask from that read. Its
   actor change stream is empty, so an actor does not move while the
   build runs. A failed or interrupted batch completes every key it owned
   with its failure before it forgets the key, so a second reader of that
   key fails at once, and does not wait forever.
   Each page still has its own cache, so its seed holds only what it
   declared. A key that an inputs Effect and a page read, or that two
   pages read, is one handler invocation. A first version shared one cache
   across the build; its seeds leaked other pages' queries, and a test
   caught it.
7. **The build is `Anonymous`, and a failed read fails the build.** The
   build provides `CurrentPrincipal` as `Anonymous` outermost, so a caller
   cannot change it. A seed that holds `Unauthorized` fails the build with
   `PrerenderUnauthorized { route, href, read: "query", contract }`;
   `contract` names the contract, which names its policy. An actor the page
   declares or opens that refuses `Anonymous` fails the mount with the
   transport's `Unauthorized` as a defect, not a seed; the build maps that
   defect to `PrerenderUnauthorized { read: "actor" }` at the page's
   boundary, so both kinds of read fail by name. Another failed read fails with
   `PrerenderQueryFailed`. A redirect fails with `PrerenderRedirected`, a
   URL that renders another route with `PrerenderNotMatched`, and a page
   that is not complete at `timeLimit` with `PrerenderTimedOut`. The limit
   starts before `document(page)` runs, so a document that never answers
   fails with `PrerenderTimedOut { phase: "document" }`. A page whose
   drawing and seed still disagree at the limit fails with
   `PrerenderTimedOut { phase: "agree" }` (streaming review round 2).
8. **`builtAt` is one value per build, from `Clock`.** Every patch the
   build writes carries it, and the manifest records it. A test clock gives
   a byte-identical rebuild.
9. **The `ETag` is the hash of the file's bytes.** It is a strong
   validator, the SHA-256 of what was written, in base64url. A rebuild at
   another instant changes the `ETag` of every page with a baked query,
   because the file holds `builtAt`. The rebuild test compares two builds
   at one instant byte for byte, and two builds at two instants with
   `builtAt` and `etag` masked: their content is identical apart from build
   metadata.
10. **A build publishes an immutable generation with one pointer rename.**
    Round 1 of the review found that the first design, two renames of
    `out`, could leave no tree after a crash between them, and that a
    loaded site read files a later build had replaced, so its `ETag`
    named other bytes. Now a build writes into `staging/<id>`, renames it
    to `generations/<id>`, writes `current.json.<id>.tmp`, and renames it
    over `current.json`. That last rename is the commit point. A failure
    before it removes the new generation and the temporary pointer, and
    the previous generation stays published. A generation is never written
    again. Review round 2 found that an interruption could still delete a
    committed generation: a rename can replace `current.json` before its
    Effect resumes, and the old rollback then removed the generation the
    pointer named. Now both renames run with interruption masked, so each
    ends as a known success or a known failure, and the new generation is
    removed only after a rename failed. Reading the old pointer and writing
    the temporary one stay interruptible, and so does the clean-up after
    the commit.

    The durability claim is exact: publishing is safe against a process
    crash and against interruption on POSIX file systems, where `rename`
    replaces an existing file atomically. The build does not `fsync`, so it
    does not claim durability across power loss, and it does not claim
    Windows replacement semantics.

11. **Recovery: the pointer wins, then the newest whole generation.**
    `load` serves the generation `current.json` names when that generation
    has a manifest. When the pointer is missing, does not decode, or names
    a generation without a manifest, the newest generation with a manifest
    wins, by `builtAt` and then by name. A generation without a manifest
    is never served, and `staging` is never read. The next build removes
    what a crash left: staging directories, temporary pointers, and
    generations no loaded site holds.
12. **A loaded site holds its generation (leases).** `load` runs in a
    scope and takes a lease on the generation it reads: a directory
    `leases/<generation>.<random>`, made whole by one `mkdtemp` and removed
    when the scope closes. Clean-up runs after the pointer moved, and keeps
    the new generation and every generation a lease names. So a server
    that loaded a site keeps its bytes across any number of rebuilds, and
    the first build after it stops removes them. The first design kept one
    previous generation (N=1); counsel round 1 on #38 (M5) found that a
    server lost its files after a second rebuild, and its pages fell
    through to the router. A larger N only moves that edge, so the holder
    now says what it holds. `load` writes its lease before it resolves the
    published generation again: clean-up runs only after the pointer
    moved, so a generation still published once its lease exists is one
    clean-up sees held; otherwise the lease goes and `load` holds the new
    one. Only a missing `leases/` directory means no leases: a build that
    cannot read it skips clean-up (counsel round 2). A lease a crashed process left keeps its generation until it is
    removed by hand, as `build.lock` is. When no lease can be written,
    `load` fails with `PrerenderLeaseFailed { out, generation, reason }`
    and holds nothing: a site served unheld would lose its files to the
    next build (counsel round 2 found the first version served it unheld). Clean-up is best effort: when it fails, the
    build still succeeds, and the next build removes what is left.
13. **One build writes one output.** A build creates `build.lock` with the
    exclusive `wx` flag and removes it when its scope closes. A second
    build fails at once with `PrerenderBuildLocked { out, lock }`; it does
    not wait. A hard crash can leave the lock file; the error names it, to
    remove by hand once no build runs.
14. **The build refuses a page it could not serve as written.**
    `PrerenderSearchRejected` refuses an href with a search part: the
    server looks up the pathname only, so a search part could never reach
    its file. `PrerenderPathCollision` refuses two hrefs whose files fold
    to one name, compared in NFC and lower case, as a case-insensitive file
    system compares them; it names both hrefs. The href printer
    percent-encodes every non-ASCII character, so file names are ASCII and
    the NFC step is inert today; it stays as the rule the comparison
    states. `PrerenderBrokenLink` refuses a page with a local link that the
    first matching route would answer as a prerender route, but that no
    input built. A link that a route renders per request, or that no route
    matches, is not the build's to check. So a mistyped link such as
    `/tgas/a`, which matches no route, passes the build.
15. **The build takes the client bundle as an Effect.** The package does
    not call `Bun.build`: the app bundles its browser entry and hands the
    text over. The build writes it as `client.js`, and every page loads it
    with `Prerender.clientScript`, which the build writes as the document's
    bootstrap.
16. **An island's resume script is the app's, through `document(page)`.**
    #23 §3.1 found no new mechanism for actors: the page embeds
    `resumeCodec(Contract)` over `{ revision, state }` as SSR does, and
    the client passes it to `ref(..., { resume })`. The build calls
    `document(page)` once per page, in the page's scope, so the app reads
    the snapshot there and writes the script into the document. Because
    `oneInstant` reads each snapshot once and freezes changes, the script
    and the view hold the same `Applied` revision, even when the store
    commits between the two reads.
17. **Two inputs that print one href are one page.** The first one is kept.
    Pages are listed by href, so the manifest does not depend on the order
    in which the inputs answered.
18. **A baked patch lands stale and revalidates once.** A `Patch` with
    `builtAt` lands as `Ready { stale: true }`, and the entry reads once
    when `Resumed.hydrated` runs (streaming review round 2); it reaches
    `Ready { stale: false }`. A patch without `builtAt`, from an
    SSR or streamed document, is fresh and is not read again.
19. **A reset store whose revisions restarted below R is out of scope.** As
    #23 §3.1 says, a store that no longer holds R but is past it answers
    with its latest, and the client converges. A store whose revision
    clock restarted below R does not converge; that is the store's identity
    rule, and it stays in the map's "Not yet specified".
20. **The router test document keeps the platform's web classes.** The
    build writes real files in the same process as happy-dom, and the
    platform file system refuses happy-dom's `AbortSignal`. So
    `tests/router/dom-setup.ts` puts the platform classes back after it
    registers, as `tests/view/dom-setup.ts` already did.

## Evidence

All tests are in `packages/effect-frame/tests/router/`.

| Claim                                                     | Test                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prerender without inputs does not compile                 | `prerender-definition.test.tsx` — "prerender without inputs does not compile, and a child's inputs see its parent's"                                                                                                                                                          |
| The refusal names the ancestor and the param              | `prerender-definition.test.tsx` — "a prerender leaf under a layout that adds a param with no inputs is refused, naming the ancestor and the param", "a leaf that adds a param itself must …"                                                                                  |
| A param-free layout is allowed                            | `prerender-definition.test.tsx` — "a prerender leaf under a layout that adds no param is allowed"; `prerender-build.test.tsx` — "a prerender leaf under a plain layout … builds"                                                                                              |
| Every input renders at the URL `href` prints              | `prerender-build.test.tsx` — "prerender renders every input through the SSR pipeline, at the URL href prints"                                                                                                                                                                 |
| Every link points at a built page                         | `prerender-build.test.tsx` — "every link a prerendered page renders points at a page that was built"                                                                                                                                                                          |
| The nested product                                        | `prerender-build.test.tsx` — "nested prerender routes enumerate the product of parent and child inputs"                                                                                                                                                                       |
| Duplicates collapse, pages are listed by href             | `prerender-build.test.tsx` — "two inputs that print one href are one page, and pages are listed by href"                                                                                                                                                                      |
| A prerendered document is `AwaitAll`                      | `prerender-build.test.tsx` — "a prerendered document is AwaitAll: only a seed of patches, stamped builtAt"                                                                                                                                                                    |
| One read for a shared query                               | `prerender-build.test.tsx` — "the build issues one read for a query two routes share"                                                                                                                                                                                         |
| A rebuild is the same content, apart from build metadata  | `prerender-build.test.tsx` — "a rebuild over an unchanged store produces the same content, apart from builtAt and the ETags it changes"                                                                                                                                       |
| A crashed build leaves the previous generation            | `prerender-build.test.tsx` — "a crashed build leaves the previous tree serving, and leaves no staging behind"                                                                                                                                                                 |
| An interruption after the pointer rename keeps the commit | `prerender-publish.test.tsx` — "an interruption after the pointer rename leaves the new generation published"                                                                                                                                                                 |
| A fault at each publishing step leaves a whole generation | `prerender-publish.test.tsx` — "a fault at each publishing step leaves a whole generation served"                                                                                                                                                                             |
| Recovery after a crash                                    | `prerender-publish.test.tsx` — "after a crash, the pointer wins, else the newest whole generation, and staging is never served"                                                                                                                                               |
| One build per output                                      | `prerender-publish.test.tsx` — "one build writes an output at a time: another fails with PrerenderBuildLocked"                                                                                                                                                                |
| A loaded site's bytes match its ETag after a rebuild      | `prerender-publish.test.tsx` — "a loaded site serves the bytes its ETag names, after a rebuild too"                                                                                                                                                                           |
| A loaded site keeps its generation across rebuilds        | `prerender-publish.test.tsx` — "a loaded site keeps its generation across two rebuilds, and releases it when its scope closes"; `apps/blog/tests/serve.test.ts` — "a running server keeps serving the generation it loaded across two rebuilds, and lets it go when it stops" |
| A matching ETag for a missing file goes to SSR            | `prerender-publish.test.tsx` — "a matching If-None-Match for a file that is gone renders through the router"                                                                                                                                                                  |
| HEAD has no body                                          | `prerender-publish.test.tsx` — "HEAD answers with the GET's status and headers, and no body"                                                                                                                                                                                  |
| Case collision, search part, broken link, document limit  | `prerender-publish.test.tsx` — "two hrefs that differ only in case …", "a page whose href has a search part …", "a link a prerender route matches but no input listed …", "one limit covers a page from its document on …"                                                    |
| A failed batch fails every reader                         | `prerender-publish.test.tsx` — "a failed batch fails every reader of its keys at once"                                                                                                                                                                                        |
| A policy that refuses `Anonymous` fails the build         | `prerender-build.test.tsx` — "a query whose policy refuses Anonymous fails the build with PrerenderUnauthorized and writes no file"; `prerender-actor-refusal.test.tsx` — "fails the build with PrerenderUnauthorized naming the actor's contract, and writes nothing"        |
| A built file is served before the router, 304 on match    | `prerender-build.test.tsx` — "a prerendered file is served before the router runs, with an ETag, and If-None-Match answers 304"                                                                                                                                               |
| A missing file answers through SSR, with no `builtAt`     | `prerender-build.test.tsx` — "a prerender route with no file on disk answers through SSR, and its patches carry no builtAt"                                                                                                                                                   |
| A baked value paints stale and revalidates once           | `prerender-resume.test.tsx` — "a baked query value paints at once, marked stale, and revalidates once to Ready{stale:false}"                                                                                                                                                  |
| An actor resumes from R and catches up                    | `prerender-resume.test.tsx` — "a prerendered page's actor resumes from the baked revision R, calls changes after R, and shows the later state"                                                                                                                                |
| A store past R converges, and no scope hangs              | `prerender-resume.test.tsx` — "a client whose baked revision the store no longer holds takes the newest, and no scope hangs"                                                                                                                                                  |
| The HTML and the resume script show one revision          | `prerender-resume.test.tsx` — "the page's HTML and its resume script show one revision, although the store moved between them"                                                                                                                                                |
| An actor does not move during the build                   | `prerender-resume.test.tsx` — "an actor does not move while the build reads it: the build's change stream is empty"                                                                                                                                                           |
| A real browser hydrates a built island through the bundle | `prerender-browser.test.ts` — "the built page loads the client bundle, hydrates with no mismatch, and resumes past its baked revision" (WebKit and Chrome)                                                                                                                    |

## Mutations

Each mutation was applied alone, the named test file was run, and the
change was reverted.

| Mutation                                                           | Result   | Test that failed                                                         |
| ------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------ |
| The ancestor check runs for leaves only                            | Killed   | the ancestor refusal                                                     |
| `landSeed` lands a stale seed as fresh                             | Killed   | the baked query test                                                     |
| `stateOf` ignores `builtAt`                                        | Killed   | the baked query test                                                     |
| The build does not provide `Anonymous`                             | Killed   | the `PrerenderUnauthorized` test                                         |
| A seed failure is ignored                                          | Killed   | the `PrerenderUnauthorized` test                                         |
| The build reads through the plain transport                        | Killed   | the one-read test, the crash test                                        |
| The inputs read outside the shared transport                       | Killed   | the one-read test                                                        |
| Pages are written into `out` directly                              | Killed   | the render, link, and `AwaitAll` tests                                   |
| A failed build keeps its staging directory                         | Killed   | the crash and `PrerenderUnauthorized` tests                              |
| `builtAt` is not stamped                                           | Killed   | the `AwaitAll` test                                                      |
| `If-None-Match` never matches                                      | Killed   | the serve test                                                           |
| `W/` is not stripped                                               | Killed   | the serve test                                                           |
| The manifest lookup is skipped                                     | Killed   | the serve test                                                           |
| The file path decodes the href                                     | Killed   | the render test                                                          |
| Pages are not sorted                                               | Killed   | the duplicate test                                                       |
| Duplicate hrefs are kept                                           | Killed   | the duplicate test                                                       |
| The manifest is written under another name                         | Killed   | the render and serve tests                                               |
| `ref` resumes from revision 0                                      | Killed   | both actor tests                                                         |
| The drawing's Scope is not closed (`view/hosts/html.ts`, existing) | Survived | none; it existed before this work, and a leak test needs a render census |

Review round 1 added these. Each ran against the files named in the table.

| Mutation (round 1)                              | Result   | Test that failed                                       |
| ----------------------------------------------- | -------- | ------------------------------------------------------ |
| The build takes no lock                         | Killed   | the lock test                                          |
| The pointer is written in place                 | Killed   | the publishing-fault test                              |
| A new generation is kept when the pointer fails | Killed   | the publishing-fault test                              |
| A failed build keeps its staging directory      | Killed   | the publishing-fault test                              |
| A clean-up failure fails the build              | Killed   | the publishing-fault test                              |
| Crash leftovers in staging are not removed      | Killed   | the recovery test                                      |
| The pointer is trusted without a manifest       | Killed   | the recovery test                                      |
| Recovery picks the oldest generation            | Killed   | the recovery test                                      |
| Recovery serves a generation without a manifest | Killed   | the recovery test                                      |
| A lease does not keep its generation            | Killed   | the two-rebuild test                                   |
| `If-None-Match` is compared before the read     | Killed   | the missing-file test                                  |
| Names are not lower-cased                       | Killed   | the collision test                                     |
| Names are not NFC-normalized                    | Survived | none; equivalent: file names are percent-encoded ASCII |
| `document(page)` is not under the limit         | Killed   | the document-limit test                                |
| Snapshots are not read once                     | Killed   | the one-revision test                                  |
| The change stream is not frozen                 | Killed   | the no-move test                                       |
| A search part is not refused                    | Killed   | the search test                                        |
| A failed batch does not settle its waiters      | Killed   | the batch test (its reader timed out)                  |
| Links are not checked                           | Killed   | the broken-link test                                   |
| Links to per-request routes are checked         | Killed   | the broken-link test                                   |
| The page has no module tag                      | Killed   | the browser test, in WebKit and Chrome                 |
| HEAD has a body                                 | Killed   | the HEAD test                                          |

Review round 2 added these.

| Mutation (round 2)                                   | Result | Test that failed                   |
| ---------------------------------------------------- | ------ | ---------------------------------- |
| `publish` runs with no interruption mask             | Killed | the interruption-after-rename test |
| The two commit renames are restored to interruptible | Killed | the interruption-after-rename test |

## What stays open

- A local link that matches no route is not checked. The link check covers
  only links that a prerender route matches (decision 14); a mistyped
  path passes the build and answers 404 at run time.
- Publishing is not durable across power loss (no `fsync`), and Windows
  replacement semantics are not claimed (decision 10).
- ~~An actor that a route declares is not baked.~~ It is now: a
  `Route.actor` declaration is baked as an `ActorSeed` in the page's
  `frame-actor-seed` script, and the client opens its reference from it
  (`route-data.md` decision 16). `apps/blog/tests/document.test.tsx` reads
  the seed of a built post, and `apps/blog/tests/island.test.tsx` resumes
  from it. The package's island proof still writes its own resume script
  through `document(page)`.
- On-demand regeneration, per-route TTL, and purge (#23 "Not yet
  specified").
- The `apps/blog` rows are proven in the app too (#38,
  `docs/design/blog-example.md`), except the nested product: the Blog has
  no nested param, so that row stays proven in the package only.
