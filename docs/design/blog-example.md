# Blog: prerender, typed links, one client island (#38)

Blog is the example that builds its pages before anyone asks for them. It
builds the Blog section of #25 §2 on the prerender design of #23
(`prerender.md`). Each acceptance row there, and each #23 row, has a test
in `bun run gate`. Two rows stay Open on one owner decision, per-reader
form identity (B1, under Open): the Blog's two-reader row and the #23
rebuild row. The rows are in `acceptance.md`, under "Blog — prerender,
typed links, one client island" and under #23. This document gives the
tests, the mutation that turns each one red, the decisions the build made,
and what stays Open.

## The shape

| Route          | Mode                              | Data                                                                |
| -------------- | --------------------------------- | ------------------------------------------------------------------- |
| `/posts`       | `Route.prerender("blog", …)`      | `PostIndex({})`                                                     |
| `/posts/:slug` | the same tree                     | `PostBody({slug})`, actor `Reactions({slug})` with its behavior     |
| (not mounted)  | `Route.prerender("drafts", …)`    | `Draft({slug})`, `editor` policy: the build must refuse it          |
| (not mounted)  | `Route.prerender("org-posts", …)` | an `org` layout adding `:org` with no inputs: refused at definition |

The one tree is a `chrome` layout (it adds no param) over the index and the
post. The post's inputs are `runQuery(PostIndex, {})`: the key the index
page reads, so the build reads it once. The two unmounted trees live in
`tests/fixture-routes.tsx`.

The build (`src/prerender.server.ts`) runs `Prerender.build` over the real
host as `Anonymous`, writes `dist/prerender/generations/<id>/<href>/index.html`,
`client.js` and `manifest.json` into staging, and publishes by renaming the
generation and then `current.json`. The app's `build` script is the deploy
build: `build:client`, then `prerender` (#38). The repository gate runs
`turbo run build` for every other package and `build:client` for the Blog,
so it never reads content (#23 §2.1). `tests/deploy-build.deploy.ts` runs
`bun run build` as a process and reads the page tree it published. Its
name is not a test name, so `bun run test` and the gate skip it;
`bun run test:deploy` runs it, and CI runs that as its own step after Test. The server (`src/server.ts`) loads the published generation at
start, holds it until it stops, and puts `Prerender.serve` in front of the router.
A start that fails, such as a port already taken (`ServerNotStarted`),
releases the lease, and `stop` releases it however the stop ends (counsel
round 2).

## Rows, tests and mutations

Each mutation was applied alone. The named test file was run from
`apps/blog` with `bun test --conditions=source`, and then the change was
reverted. The runner restores every file after each mutation.

| Row                                             | Test (file: name)                                                                                                              | Mutation                                                               | Result                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | -------------------------------------------------------- |
| A file's path is what `href` prints             | `build.test.ts`: "each built page sits at the href its route prints, and the manifest says so"                                 | `prerender.server.ts` `fileOf` writes `page.html`                      | Killed (4 tests)                                         |
| (same row)                                      | (same test)                                                                                                                    | The build writes no bootstrap (`bootstrap: ""`)                        | Killed                                                   |
| Every link points at a built page               | `build.test.ts`: "every link a built page renders points at a page that was built"                                             | `postInputs` drops the first post                                      | Killed (7 tests: the build fails, `PrerenderBrokenLink`) |
| (same row)                                      | (same test)                                                                                                                    | The same, with the build's link check switched off                     | Killed (4 tests, this one included)                      |
| Refused at definition under an `org` layout     | `build.test.ts`: "a prerender post leaf under an org layout that adds a param is refused at definition"                        | `prerender.ts` `refuse` returns instead of throwing                    | Killed                                                   |
| A plain layout is allowed                       | `build.test.ts`: "the Blog tree, whose chrome adds no param, is accepted at definition"                                        | The ancestor check refuses a segment that adds no param                | Killed (the file fails to load)                          |
| `AwaitAll`: one Patch per query, `builtAt`      | `document.test.tsx`: "a built page is one finished document: no streamed records, one Patch per declared query …"              | `html.ts` `stamp` leaves the seed unstamped                            | Killed (3 tests)                                         |
| `PrerenderUnauthorized`, nothing written        | `build.test.ts`: "a route whose query refuses Anonymous fails the build …"; "the prerender command exits non-zero …"           | The build does not map `Unauthorized`                                  | Killed (2 tests)                                         |
| One read for a shared query                     | `build.test.ts`: "the build reads PostIndex once for N + 1 pages"                                                              | The build's transport reads each key per page (no `once`)              | Killed                                                   |
| A rebuild differs only in metadata (Open, B1)   | `build.test.ts`: "a rebuild over an unchanged store is the same tree but for builtAt and each form's minted identity"          | `builtAt` from `Date.now()` instead of `Clock`                         | Killed                                                   |
| A running server keeps its generation           | `serve.test.ts`: "a running server keeps serving the generation it loaded across two rebuilds, …" (counsel round 1, M5)        | clean-up ignores leases; a lease is never released                     | Killed (3 tests; 4 tests)                                |
| A crashed build leaves the previous generation  | `build.test.ts`: "a build aborted mid-way leaves the previous tree serving, and no staging"                                    | `stage` keeps the staging directory on failure                         | Killed (3 tests)                                         |
| The actor resumes from R and catches up         | `island.test.tsx`: "the hearts resume from the baked revision R, call changes after R, …"                                      | `branch.ts` opens the route actor with no seed                         | Killed (2 tests)                                         |
| A store past R is followed to its newest        | `island.test.tsx`: "a store that no longer holds the baked revision is followed to its newest"                                 | (the same mutation)                                                    | Killed                                                   |
| A baked value paints at once, marked stale      | `document.test.tsx`: "the baked body paints with no skeleton, marked stale, and one read confirms it to Ready{stale:false}"    | `streaming.ts` seeds a `builtAt` patch as fresh                        | Killed (2 tests)                                         |
| A baked value revalidates and confirms          | (same test); "a post edited after the build shows its new title once the baked value is confirmed"                             | `Resumed.hydrated` is `Effect.void`                                    | Killed (2 tests)                                         |
| No file: SSR answers the same page              | `serve.test.ts`: "a built page is its file, before the router; a missing one falls through to the router and is the same page" | A file that is gone answers 404                                        | Killed                                                   |
| A file is served before the router              | (same test: a hit opens no `Branch.create` span)                                                                               | `serve` runs the router, then reads the file                           | Killed                                                   |
| `ETag` and 304                                  | (same test)                                                                                                                    | `If-None-Match` never matches                                          | Killed                                                   |
| #32: a generated field minted at render, stable | `island.test.tsx`: "with no script, the built form posts one heart: its id is not the command id, and a second post …"         | `view/form.ts` mints the generated `id` as the command id              | Killed                                                   |
| (same row)                                      | (same test)                                                                                                                    | `form-post.ts` sends each post with a fresh command id                 | Killed                                                   |
| The first scripted heart counts, page stays     | `browser.test.ts` (real Chrome and WebKit): "the first scripted heart goes over the transport and counts once the server …"    | the island's form has no `onSubmit`, so it posts natively              | Killed (2 tests)                                         |
| The browser entry reaches no server module      | `boundary.test.ts`: "an import of posts.server.js in page.tsx is refused with its path chain"                                  | `tooling/checks/src/boundary.ts` matches `.srv.` instead of `.server.` | Killed                                                   |

No mutation survived. The nested-product row of #23 has no Blog test: the
Blog has no nested param. It stays proven by the package
(`prerender-build.test.tsx`).

The two framework changes this ticket made carry their own red-on-old tests:

- `runQuery` (`ee6b21b`, changeset `run-query`, minor):
  `tests/actor/run-query.test.ts` failed on the old code with "Export named
  'runQuery' not found".
- The `AwaitAll` wake (`6c24309`, changeset `await-all-wake`, patch): see
  decision 8. `tests/router/await-all-wake.test.tsx` "catches the drawing up
  from outside its reactive update" failed on the old code on each of three
  runs, and passes on the new code on each of three.

## Decisions

1. **One tree, mode by constructor.** `Route.prerender("blog", layout)` is
   the only place that says the Blog is built. No view knows whether it
   draws at build, per request, or in the browser.
2. **The inputs read the index through `runQuery`.** #25 §2 wrote the
   inputs as a call that reads `PostIndex` once. The framework had no way to
   read one query as a value through the cache, so `ee6b21b` adds
   `runQuery(contract, args)`: it opens the entry, waits for the first
   settled state, and closes it. Through the build's one cache, the inputs
   and the index page share one read.
3. **A body is blocks, not HTML.** #25 §2 names a `html` field. The view
   layer has no raw-HTML node, and adding one is an escaping decision this
   ticket does not own. `PostBody` carries `Heading` and `Paragraph` blocks,
   and the page draws them as nodes.
4. **The hearts snapshot keeps the ids.** `{ hearts, ids }`: "one heart per
   click" is then observable in the store, not only as a count.
5. **The deploy build prerenders; the gate does not.** `build` is
   `build:client` and then `prerender`; `start` runs `build` and then the
   server. The root `build` runs `turbo run build` without the Blog, then
   `turbo run build:client`, so the gate compiles the Blog's client and
   never reads its posts (#23 §2.1). The Blog's `turbo.json` turns caching
   off for its `build`, whose output depends on content turbo does not see.
   Counsel round 1 (B2) found the first version, where `build` bundled the
   client only, so a deploy that ran the build step published no pages.
   Counsel round 2 found that the proof of it, a test in the default suite,
   ran the deploy build, and so prerender, inside the gate. The proof is now
   `tests/deploy-build.deploy.ts`, run only by `test:deploy` and the CI
   step "Deploy build".
6. **The output is the package's layout, not a flat tree.** #23 wrote
   `dist/prerender/<href>/index.html` with `manifest.json` written to a temp
   dir and renamed. The released build (`prerender.md` decisions 10–13)
   writes whole generations under `generations/<id>/` and publishes by
   renaming the generation and then `current.json`. That is the same
   guarantee at the granularity of a whole tree; the Blog uses it as is.
   The manifest's `route` is the tree's name, `"blog"`.
7. **A page with a form is not byte-identical across rebuilds.** Each render
   mints its own `$command` (#19, from `crypto.randomUUID`) and its own
   generated `id` (#32, from `Random`). The rebuild and fallthrough tests
   compare with those two values masked (`withoutMinted`) and assert that
   they are the only difference.
8. **An `AwaitAll` render reads on a turn of its own (framework fix).** The
   serve test found it: a page rendered on request sometimes had an empty
   title and no body although its seed held the post. A boundary that
   switched, or a list row whose setup ended, woke the render synchronously
   inside the drawing's reactive update. The catch-up then could not write
   or flush, and the page was serialized half updated. The app showed it on
   9 of 30 renders with a read that answers a tick late, and on 0 of 60
   after the fix. Solid's development build names it:
   `REACTIVE_WRITE_IN_OWNED_SCOPE`. The fix (`6c24309`) yields before
   `readDrawn` reads. It belongs to the HTML host, not the app.
9. **The real-server test counts router runs by span.** A `Tracer` in the
   server's runtime records span names; the router opens `Branch.create`
   for each route it matches, so a hit that never reached the router opens
   none. The server runs on port 0, and the test asserts it did not take
   3102 or 3187.
10. **The failing build is proven as a process too.** `tests/build-with-draft.ts`
    runs the app's `command` over the tree plus `DraftRoute`; the test reads
    its exit code, its output, and the untouched output directory.

## Open

- **A prerendered form shares one command id among its readers (B1).**
  A built page is one render served to every reader, so every reader
  without a script posts the same `$command` and the same `id`, and the
  host keeps one heart for all of them. With a script, hydration adopts the
  rendered id for the first send, so each reader's first heart collides
  the same way. The island test shows the mechanism: a second post of the
  one file adds nothing. Counsel round 1 read the three tickets this way:
  #19 assigns an id to a rendered form; #32's resolution requires
  hydration to adopt it; #67's implemented rule (`optimistic.md`) treats
  that adopted id as supplied. None gives separate readers of one static
  file separate commands. Per-reader identity is an owner decision under
  #67, and this build does not make it. It keeps two rows Open in
  `acceptance.md`: the two-reader row under Blog, and the #23 rebuild row,
  whose "identical apart from `builtAt`" holds for a page with no form but
  not for a post, which differs in its minted `$command` and `id`
  (`build.test.ts`, "a rebuild over an unchanged store is the same tree but
  for builtAt and each form's minted identity", asserts exactly that
  difference).
- **Nested product.** Proven in the package only (see above).
- **`aria-current` on the chrome link.** A post page marks the index link
  `aria-current="true"`, the index page `"page"`. That is the router's
  `currentAt` rule, reported under Notes; the Blog does not change it.
