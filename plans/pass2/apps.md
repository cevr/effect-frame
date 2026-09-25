# Architecture pass 2: apps, examples and EGW Search

Scope: effect-frame `apps/{blog,dashboard,notes}/src` and `packages/effect-frame/examples`, worktree `arch-pass2`, HEAD `d272bd7`. Also bible-tools `apps/egw-search/{src,server,test/browser}` at HEAD `4008b04a` (effect-frame 0.27.0). Read only: no server was started and no repo file was edited. Two probes ran in the scratchpad: a Bun 1.4.2 JSX-resolution probe and a `tsc` probe against the worktree's `packages/effect-frame`.

Short paths: `blog/`, `dash/` and `notes/` mean `apps/<app>/src/`. `ex/` means `packages/effect-frame/examples/`. `fw/` means `packages/effect-frame/src/`. `egw/` means `bible-tools/apps/egw-search/`. Counts leave out `*.test.*` unless they say otherwise.

## 0. Pass 1 app candidates: where they stand

| Pass 1 | Ledger | State at `d272bd7` / `4008b04a` |
|---|---|---|
| P1 hydrate | done 0b64f8d | All 4 apps call `hydrate`. Closed. |
| P2 root id | done 0277d0c (Browser.layer rejected) | The root id has one owner in all 4 apps (`document.ts`). The actor prefix still has 2–5 owners per app: see AP2. |
| P3 page answer | partial 30a2261 | `respondDocument` is shared. The apps are still `Bun.serve` + `async` + `ManagedRuntime`, and `Bun.build` is copied 3×. New receipts in AP5. |
| P4 principal | done | Explicit everywhere. Closed. |
| P5 remount | done (View.keyed, Source.switchMap) | Blog and notes still pair the params with the ref by hand. The README teaches `ref.key`: see AP2. |
| P6 view-hosting conditional | not in ledger | Still open (dashboard `overview.tsx:166-175`, EGW `app.tsx:309-356`). This is view area; not repeated here. |
| P7 `keyBy` annotations | framework fixed | Now dead in the apps. Probe: `View.list` and `<For>` infer `Item` with no annotation (scratch `tsc` exit 0). 8 sites are left: see AP2. |
| P8 positional keys | not in ledger | Still open: blog `page.tsx:24-30`, EGW `app.tsx:162-165,217-219,701-703,745-746,781-787`. See AP9. |
| P9 readiness/errors | partial (`Await` renamed) | `describe` is still copied 3×, and the `Errored` fallback is still `Source<Option<unknown>>` (`fw/view/readiness.tsx:488`). See AP8. |
| P10 Source combinators | done A1 | EGW's hand-built `{get, changes}` is gone (`Source.dedupe`, bible-tools `2179ef74`). notes `follow` (`page.tsx:57-60`) still captures a scope by hand. |
| P11 send-only actor | done R3 | `Route.commandRef` is used. Sending through it takes two hops: see AP4. |
| P12 View.form endpoint/returnTo | not in ledger | Still open (blog `page.tsx:57-64`, notes `page.tsx:62-73`). See AP2 and AP6. |
| P13, P14 | done | Closed. EGW still uses `UrlState` with an empty route search (`egw/src/segments.ts:13-16`); that is by decision. |
| P15 debounce stale | not in ledger | Still open (EGW `app.tsx:293-305,683-691`). It is in 1 app, so it is below the 2-app bar; it stays a carry-over. |
| P16 naming, P17 local state | A14, D4 | `Cell` is gone, and all 4 apps use `Actor.local(Behavior.value)`. The naming rule now contradicts itself: see AP10. |

## 1. What each app writes by hand that the framework could own

| Pattern | blog | dash | notes | EGW | ex/README | Apps (≥2 → candidate) |
|---|---|---|---|---|---|---|
| A `Bun.build` of `client.tsx` at start | `prerender.server.ts:24-42` | `server.ts:46-65` | `server.ts:30-49` | `bun build` script | `main.server.ts:11-12` | 3 → AP5 |
| `Bun.serve` + `async makeServer` + `ManagedRuntime.runPromise` | `server.ts:108-168` | `server.ts:146-183` | `server.ts:144-186` | HttpRouter (`server/main.ts:373-411`) | `main.server.ts:9-26` | 3 vs 1 → AP5 |
| The actor prefix written twice (the `HttpServer.make` `prefix` and a `startsWith` or `router.add`) | `server.ts:113,139` | `server.ts:151,165` | `server.ts:150,168` | `main.ts:378,383`; `test/browser/server.ts:161,166` | `page.server.ts:75` + `main.server.ts:18` | 4 → AP5 |
| The web ↔ `HttpServerResponse` adapter around the actor handler | — | — | — | `main.ts:383-389`, `test/browser/server.ts:166-188`, `document.ts:100` | — | 1 app, 3 sites → AP5 |
| `drawAgain` + `PageRedirected` (redraw a refused plain post) | `server.ts:62-78` | — | `server.ts:100-116` | — | `page.server.ts:55-70` | 2 + README → AP6 |
| Form issues written into the document `tail` with `Form.issuesScriptId` | — | — | `server.ts:73-79` | — | `page.server.ts:28-34` | 1 + README → AP6 |
| A hand-rolled typed alias for a value-actor ref (`LocalActorRef<A, SetValue<A>>`) | — | — | `commands.ts:21` (`DraftRef`) | `app.tsx:74` (`Local<A>`) | — | 2 → AP1 |
| A wrapper around writing a value actor | — | `overview.tsx:192` (`Effect.asVoid(send(Value.Set))`) | `commands.ts:28-31` (`writeDraft`) | `app.tsx:79-83` (`whileMounted`, 5 calls) | — | 3 → AP1 |
| A region keyed by pairing `params.get` with the ref (`Opened`) | `page.tsx:77-80,86-87,94-100` | — | `page.tsx:37-40,145-155` | — | README uses `ref.key` (`ex/counter/routes.tsx:39-43`) | 2 → AP2 |
| `flatMap(binding.ref.get, r => r.send(m))` | — | `overview.tsx:65-68`, `orders-page.tsx:36-37`, `views.tsx:51-52`, `commands.ts:105-106` | (keyed region instead) | — | — | 1 app, 4 sites; 2 forms across 3 apps → AP4 |
| `describe` + `failure` for `View.errored` | `views.tsx:19-32` | `views.tsx:23-37` | `views.tsx:22-36` | typed `describeFailure` (`app.tsx:673-681`) | — | 3 → AP8 |
| A policy that JSON-decodes `subject.address.key` / `subject.key.args` by hand | — | `policies.server.ts:55-64` | `policies.server.ts:17-21` | — | — | 2 → AP7 |
| An in-memory `LocationService` (`pops: Stream.never` / queue) | `tests/fixture.ts:288` | `tests/fixture.ts:301` | `tests/fixture.ts:106` | `src/workspace-route.test.tsx:26-50` | `fw/router/document.ts:128-133` (private) + 14 framework test files | 4 → AP3 |
| A test `install` of the served body with `"app"` and the bootstrap tag hard-coded | 3 fixtures (`install`) | ✓ | ✓ (`fixture.ts:90-104`) | — | — | 3 → AP3 |
| A test transport tap (`watched`/`wiretap`) | `fixture.ts:303-341` | `fixture.ts:156-264` | `fixture.ts:218-304` | test server counters | — | 3; the bodies differ in 126 diff lines → owner question O3 |
| `data-hydrated` marker + hydration-mismatch log in the browser entry | `client.tsx:33-38` | `client.tsx:33-39` | `client.tsx:33-39` | log only (`boot.tsx:53-57`) | README drops `report` | not worth a pass (§6) |
| A positional key wrapper `{key: String(i), …}` | `page.tsx:24-30` | — | — | ×3 (above) | — | 2 → AP9 |
| `segments.ts` split out to avoid a view ↔ tree cycle | `segments.ts:7-17` | `segments.ts:6-27` | `segments.ts:7-21` | `segments.ts:1-8` | README keeps segments in `routes.tsx` (`ex/counter/routes.tsx:11-28`) | 4 → AP10 (docs) |
| `Frame.layer` provided *into* `QueryCache.layer` | — | — | — | `boot.tsx:69` | `ex/features/inspection.ts:16` | 1 app + README → AP11 |
| Dev inspection attach (`/__inspect` route + state-dir rule) | — | — | — | `index.dev.tsx:23-46`, `server/inspect.ts:33-45` | — | 1 app; the state-dir rule has two owners → §5 |
| A client-only fallback document built by hand | — | — | — | `server/document.ts:57` | — | 1 app → §5 |

## 2. F5: `@jsxImportSource effect-frame/view` per file

**Receipts.**
- effect-frame apps: 0 files carry `@jsxImportSource effect-frame/view` (`grep -rn "@jsxImportSource" apps packages tooling` → 7 hits, none of them this runtime in `apps/`). The only app pragma is `notes/terminal-view.tsx:1` (`effect-frame/view/opentui`). That one is required: it is a second runtime inside a tsconfig that names `effect-frame/view` (`apps/notes/tsconfig.json:4-5`), as `README.md:517-521` says.
- EGW: 2 files, `egw/src/app.tsx:1-3` and `egw/src/routes.tsx:1-3`. Each carries a comment: "the server … runs from the repository root, where Bun reads no app tsconfig". bible-tools `fd8f3aaa` added them. The tsconfig already names the runtime (`egw/tsconfig.json:4-5`).
- The two processes that import them start outside the app directory. `egw/alchemy.run.ts:63` runs `cd out && bun apps/egw-search/server/main.ts`. `egw/test/browser/playwright.config.ts:20` runs `bun server.ts`, whose cwd is `test/browser`.

**Probe** (Bun 1.4.2, scratchpad, `app/tsconfig.json` naming a fake runtime):

| Run | Result |
|---|---|
| `cd app && bun src/x.tsx` | fake runtime |
| `bun app/src/x.tsx` from the parent | `Cannot find module 'react/jsx-dev-runtime'` |
| `cd app/src && bun x.tsx` (no tsconfig in the cwd; the app's is one level up) | same error: **no walk-up** |
| `bun test app/src` from the parent | same error |
| `app/bunfig.toml` with `jsxImportSource`, run from the parent | same error |
| a root `bunfig.toml` with `jsxImportSource` | fake runtime |
| `bun --cwd app src/x.tsx` | fake runtime |
| `bun build app/src/x.tsx` from the parent | fake runtime (the bundler resolves per file) |
| `--preload` plugin that prepends the pragma | fake runtime |

**Conclusion.** The Bun *runtime* (`bun run`, `bun test`) takes JSX settings only from the tsconfig or bunfig in the working directory. The bundler resolves them per file. The pragma is therefore app config, not a framework defect.
- A root `bunfig.toml` is not an option in bible-tools, because other apps there use Solid (`bible-tools/apps/web/tsconfig.json:4-5`, `jsxImportSource: "@solidjs/web"`).
- A framework-shipped Bun plugin is possible, but it rewrites source by file pattern. That is a convention the build cannot check, which breaks **explicit over implicit**.

Candidate **AP12** in §4 covers the fix.

## 3. The same thing written two ways

| Job | Forms seen | Receipts |
|---|---|---|
| View body | `Effect.gen` in most views. 9 are not: `Effect.map` (blog `page.tsx:33-34`); `Effect.succeed` (every `NotFound`: blog `views.tsx:79`, dash `views.tsx:129`, notes `views.tsx:145`, ex `counter/routes.tsx:144`); `View.errored(...)` as the body (dash `views.tsx:84-85`); `View.loading(...)` (dash `overview.tsx:102-103`); `Effect.sync` with nothing to suspend (dash `overview.tsx:123-124`); `Effect.flatMap` (notes `views.tsx:57-58,70-71`). README says `Effect.gen` only (`README.md:14-16`); the JSDoc allows "an arrow over one Effect" (`fw/view/view.ts:153-154`). | AP10 |
| Sync component | Called as a function in EGW (`Chip(…)`, `SignedChip(…)`, `Status(…)`, `Empty(…)`, `HitRow(…)`, `Reference(…)`, `Context(…)`, `Skeleton()`, 14 calls) and used as a tag (`<FilterRow>` ×5, `app.tsx:493-541`). README: "A PascalCase JSX tag is one of For, Show, Match, Portal or Await" (`README.md:17-18`). CONTEXT: "a JSX tag is a synchronous function or an intrinsic name" (`CONTEXT.md:39`). | AP10 |
| Non-view helper that yields | `Effect.fn("Area.op")` (blog 1, dash 3, notes 4) vs an arrow over `Effect.gen` (blog `server.ts:67-78`, `posts.server.ts:96-114`; notes `server.ts:104-116`; dash `views.tsx:49-57`). | §6 |
| Write a value actor | `Effect.asVoid(ref.send(Value.Set(x)))` (dash, notes); `whileMounted(ref.send(…))` (EGW ×3); `whileMounted(modify(…))` (EGW ×2); `saved.send(Value.Set(…))` inside a gen (dash `views.tsx:55`). | AP1 |
| Send to a route actor | keyed region + a plain ref (blog, notes, README) vs `flatMap(ref.get, send)` (dash ×4). | AP4 |
| Key a route actor's region | `ref.key.name` (README) vs `Source.mapEffect(ref, opened)` + `Opened` (blog, notes). | AP2 |
| `keyBy` | Annotated `(one: Placed)` (4 `View.list` in apps; EGW `(row: PaneRow)`, `(row: Row)`, `(paragraph: Paragraph)` ×2) vs unannotated (dash `<For>` ×5, notes `<For>` ×3, README `keyBy: (name) => name`). | AP2 |
| Readiness | `View.ready` + `View.orErrored` (apps; `orErrored` missing on blog `views.tsx:55` and notes `views.tsx:76,104`) vs `<Await>` (EGW). A Ready check by `_tag` in dash `orders-page.tsx:18-23` vs `QueryState.match` in EGW `app.tsx:570`. | AP8 |
| `followLinks` root | `document` (3 apps, README `README.md:437`) vs the mount root (EGW `boot.tsx:58`). | §6 |
| Client layer | `Layer.provideMerge(QueryCache.layer, transport)` (3 apps, README `:442`, ex `counter/client.tsx:33-42`); `QueryCache.layer.pipe(Layer.provideMerge(transport))` (JSDoc `fw/actor/query-client.ts:1370-1376`); `Layer.mergeAll(transport, QueryCache.layer.pipe(Layer.provideMerge(Frame.layer(…))))` (EGW, README `:1275`). `QueryCache.layer` is `Layer<QueryCache>` with no requirement (`query-client.ts:1382`). | AP11 |
| Server edge | `Bun.serve` + Promise (3 apps, README) vs `HttpRouter` + `BunHttpServer` (EGW). | AP5 |
| `returnTo` | `counter.href(…)` (README `:215`) vs a snapshot of `(yield* Router).current` pathname (blog `page.tsx:57,63`, notes `page.tsx:62,71`). | AP6 |
| Test harness | blog: `install` + `hydrateAt`. dash: `install` + `mountApp`. notes: both. EGW: `ViewTest` + a hand-built Location + `mount`. Each app has its own `locationAt`, `textOf`, `keyText`, and `dom-setup.ts`; the 3 `dom-setup.ts` files differ only in the URL (`diff`: 1 line). | AP3 |

## 4. Candidates

### AP1 — one error rule for a message to a stopped local actor (F2, corrected)
- **Files:** `fw/actor/vocabulary.ts:282-303`, `fw/actor/actor.ts:34-39,100-109,160-176`, `fw/view/view.ts:88`; EGW `app.tsx:73-83,277,341,476,726,730`; notes `commands.ts:21-31`.
- **Problem:** F2 misstates the fault.
  - `send` **never fails**: "every refusal is a state of that handle", and a stopped actor returns a `Rejected(ActorStopped)` handle (`actor.ts:34-39`).
  - `modify` and `derive` fail with `ActorStopped` (`actor.ts:108,165`). `Handler` is `Effect<unknown>` (`view.ts:88`).
  - Probe: `View.event(() => open.send(Value.Set(true)))` compiles. `View.event(() => modify(open, (x) => !x))` fails with TS2322 "`ActorStopped` is not assignable to `never`".
  - So 3 of EGW's 5 `whileMounted` calls wrap a `send` and catch nothing. Only the 2 `modify` calls need it.
  - One reference has two error models, and an agent cannot tell from the call which one it holds.
  - Two apps also alias the value-ref type (`DraftRef`, `Local<A>`).
- **North star:** explicit over implicit (one rule for a stopped actor), actor-model.
- **Change:**
  - `modify` returns a handle like `send`: a stopped actor gives a `Rejected(ActorStopped)` handle.
  - Export `Actor.ValueRef<A>` = `LocalActorRef<A, SetValue<A>>`.
  - EGW deletes `whileMounted` and `Local`. Notes deletes `writeDraft` and `DraftRef`.
- **Lines removed:** about 20 in the apps (EGW 11, notes 8).
- **Risk:** low. **Public API change:** yes. `modify`'s return type changes; needs a changeset. **Wire/stored format change:** no.

### AP2 — the apps catch up to what the README teaches
- **Files:**
  - `ref.key`: blog `page.tsx:42-45,77-80,86-87,94-100`; notes `page.tsx:30-40,143-155`; notes `contract.ts:17` (`list: Schema.String`, where the view wants `ListName`).
  - `keyBy`: blog `page.tsx:90`, `views.tsx:58`; dash `overview.tsx:173`; notes `views.tsx:80`; EGW `app.tsx:222-223,760,870,880`.
  - Actor prefix owners: blog `server.ts:28`, `client.tsx:46`, `page.tsx:62`; dash `server.ts:29`, `client.tsx:48`; notes `server.ts:27`, `client.tsx:48`, `page.tsx:67`, `notes.server.ts:36`, `terminal.tsx:54`. EGW has one owner (`egw/src/contract.ts:50`).
- **Problem:**
  - The README keys a route actor's region by the ref's own address: `View.keyed(props.data.counter.ref, (ref) => ref.key.name, …)` (`ex/counter/routes.tsx:39-43`). A6 made `key` part of the ref (`fw/actor/ref.ts:40-43`).
  - Blog and notes still read `props.params.get` beside the ref and build an `Opened` pair. Notes has a comment arguing the pair cannot tear (`page.tsx:143-144`); with `ref.key` that argument is not needed.
  - `keyBy` annotations are no longer needed (probe in §0). An agent copying an app learns that they are.
  - The actor prefix `"/actors"` has 2–5 owners per app. `rootId` already has one (`document.ts`).
- **North star:** explicit over implicit (one owner per fact), actor-model (the address is on the reference).
- **Change:**
  - `View.keyed(ref, (r) => r.key.slug | r.key.list, …)`, and delete `Opened` ×2.
  - Brand notes `NotesKey.list` as `ListName`. That is type-only, and the key's encoding is the same string.
  - Drop the 8 annotations.
  - Export `actorPrefix` from each app's `document.ts`.
- **Lines removed:** about 30.
- **Risk:** low. **Public API change:** no. **Wire/stored format change:** no. The brand does not change the encoded key.

### AP3 — a memory Location, and test pages that read the app's root id
- **Files:** `fw/router/document.ts:128-133` (private `requestLocation`); `blog/../tests/fixture.ts:288`, `dash/../tests/fixture.ts:301`, `notes/../tests/fixture.ts:106`; EGW `src/workspace-route.test.tsx:16-50`; 14 framework test files (`grep -rln "pops: Stream.never" packages/effect-frame/tests`). `install` in 3 fixtures (`notes/../tests/fixture.ts:90-104`) hard-codes `getElementById("app")` and the bootstrap tag.
- **Problem:**
  - `LocationService` has one public adapter (`browserNavigation`), and 4 apps plus the framework's own tests write a second one by hand. EGW's version also records a history and offers `pop`.
  - The tests restate the root id that P2 gave one owner.
- **North star:** effect-native (a `Layer`/`Effect` adapter, not a literal record ×18), explicit.
- **Change:**
  - `Location.memory(href)` in the router: it returns `{ location, current, history, pop }`.
  - The fixtures import `rootId`.
- **Lines removed:** about 50 in the apps, and more in `packages/effect-frame/tests`.
- **Risk:** low. **Public API change:** yes, additive. **Wire/stored format change:** no.

### AP4 — sending through a route binding
- **Files:** dash `overview.tsx:64-69`, `orders-page.tsx:35-37`, `views.tsx:46-52`, `commands.ts:105-106`; `fw/router` `FollowedActor`/`FollowedCommands` (`{ ref }` is a `Source`).
- **Problem:** "Send a message to the actor the route holds" is written two ways:
  - `Effect.flatMap(binding.ref.get, (r) => r.send(m))`, nested three deep inside a row handler (dash ×4).
  - A keyed region to obtain a plain ref (blog, notes, README).
  - The dashboard also keeps a local `send` helper (`orders-page.tsx:36-37`) that fails the deletion test in any one file but recurs in each.
- **North star:** actor-model, expressive.
- **Change:** each actor binding gets `send(message)`, documented as "sends to the reference the route holds at the moment of the send". It reads the same `ref.get` it replaces, so no ordering changes.
- **Lines removed:** about 12.
- **Risk:** low. **Public API change:** yes, additive. **Wire/stored format change:** no.

### AP5 — the server edge: one Effect-native shape (P3 remainder, new receipts)
- **Files:**
  - blog `server.ts:28,103-184`, `prerender.server.ts:24-42`; dash `server.ts:29,46-65,133-194`; notes `server.ts:27,30-49,140-205`.
  - `.oxlintrc.json:285-296`: file-wide `noAsyncFunction`/`noGlobals` off for the 3 `server.ts`, with no reason. AGENTS.md asks for a line disable with ` -- reason`.
  - `ex/counter/main.server.ts:1-27`; EGW `server/main.ts:373-411`, `server/document.ts:83-130`, `test/browser/server.ts:158-192`.
- **Problem:**
  - Three apps and the README answer requests from a Promise edge: `async makeServer`, 4–5 `await runtime.runPromise` each, `stop: () => Promise`.
  - Each writes the actor prefix twice (the handler's `prefix` and its own `startsWith`) and builds `client.tsx` in-process. The same apps also build it with their `build` script (dash `package.json` `build`).
  - EGW is on `HttpRouter`, but must adapt `HttpServer.make`'s web handler (`toWeb`/`fromWeb`) and `respondDocument`'s web `Response` by hand, twice in one app.
  - The framework offers the actor route and the page answer only as web-handler functions. So every app writes the routing that the `prefix` option already names.
- **North star:** effect-native (Scope/Layer lifetimes, no Promise edge), explicit (the prefix said once).
- **Change:**
  - `HttpServer.layer({ prefix, principal, maxBodyBytes, form })`: an `HttpRouter` layer that adds `* ${prefix}/*`.
  - `respondDocument` gains an `HttpServerResponse` form, or a `Document.route({ … })` layer.
  - The apps move to `BunHttpServer` + `HttpRouter` + `HttpStaticServer` over `dist/`. That deletes 3 `buildClient` copies, 3 `makeServer`s and the 2 `.oxlintrc` overrides.
  - The README's `main.server.ts` follows.
- **Lines removed:** about 200 in the apps and about 25 in EGW.
- **Risk:** medium: each app's serve tests start and stop through `makeServer`. **Public API change:** yes, additive. **Wire/stored format change:** no.

### AP6 — a refused plain post draws again without app plumbing
- **Files:**
  - `drawAgain` + `PageRedirected`: blog `server.ts:62-78`, notes `server.ts:99-116`, `ex/counter/page.server.ts:55-70`.
  - Issues in the tail: notes `server.ts:73-79`, `ex/counter/page.server.ts:28-34`.
  - `returnTo` snapshot: blog `page.tsx:57,63`; notes `page.tsx:62,71`.
- **Problem:**
  - Each app turns a `DocumentOutcome` back into a string for `form.render`, invents the same `PageRedirected` error, and writes `Html.jsonScript(Form.issuesScriptId, …)`, a framework-owned id that `hydrate` reads.
  - The blog skips the issues, so the same job is written two ways.
  - `returnTo` is a one-time snapshot of the path and drops the search. P12 is still open.
- **North star:** declarative, explicit (one owner for `issuesScriptId`).
- **Change:**
  - `renderDocument` writes the `FormContext` issues itself.
  - `HttpServer` `form.render` takes the page renderer, `(url, principal) => DocumentOutcome`, and owns collecting the body and mapping a redirect.
  - `View.form` `returnTo: View.here`, the live URL.
- **Lines removed:** about 45.
- **Risk:** low. **Public API change:** yes (the `form.render` signature). **Wire/stored format change:** no. The issues script keeps its id and encoding.

### AP7 — a policy reads a typed key
- **Files:** dash `policies.server.ts:55-64`; notes `policies.server.ts:17-21`.
- **Problem:** Both apps must know that `subject.address.key` and `subject.key.args` are JSON strings. Each decodes them with `Schema.fromJsonString(…)` and swallows a failed decode as `None`. That is wire knowledge in app code, and an agent writing a new policy has no type to follow.
- **North star:** explicit, effect-native (Schema at the boundary, once).
- **Change:** `Policy.forContract(Contract, (principal, key: KeyOf<C>) => …)` and `Policy.forQuery(Query, (principal, args) => …)`, decoded by the framework. The subject's encoding does not change.
- **Lines removed:** about 15.
- **Risk:** low. **Public API change:** yes, additive. **Wire/stored format change:** no.

### AP8 — a typed `Errored` fallback (P9, new count)
- **Files:** blog `views.tsx:19-32`, dash `views.tsx:22-37`, notes `views.tsx:21-36`; `fw/view/readiness.tsx:482-488`. `orErrored` is missing on blog `views.tsx:55` and notes `views.tsx:76,104`.
- **Problem:**
  - Three identical untyped `describe` functions (`Predicate.hasProperty(error, "_tag")`), while EGW narrows a typed `QueryFailure` (`app.tsx:673-681`).
  - Whether a failure reaches the fallback depends on remembering `orErrored`.
- **North star:** explicit, expressive.
- **Change:**
  - `View.errored` is generic in the error its reads route. Route reads are `QueryFailure` (`fw/router/branch.ts`).
  - Or: `orErrored` accepts only `QueryState<_, QueryFailure>`, and the fallback is `Source<Option<QueryFailure>>`.
- **Lines removed:** about 40.
- **Risk:** medium: it changes behaviour for the three unwrapped reads if routing becomes the default. **Public API change:** yes. **Wire/stored format change:** no.

### AP9 — positional keys (P8, still open)
- **Files:** blog `page.tsx:23-30`; EGW `app.tsx:161-165,217-219`, `701-703,745-746`, `781-787`.
- **Problem:** Wrapper types exist only to feed `keyBy`.
- **North star:** expressive.
- **Change:** `keyBy: View.byIndex`.
- **Lines removed:** about 25.
- **Risk:** low. **Public API change:** yes, additive. **Wire/stored format change:** no.

### AP10 — one written rule for views, tags and files
- **Files:** `README.md:14-18`, `fw/view/view.ts:153-154`, `CONTEXT.md:39`; the 9 non-`gen` views and the EGW tag/call split listed in §3; 4 `segments.ts` files vs `ex/counter/routes.tsx:11-28`.
- **Problem:** Three documents give three rules.
  - README: `Effect.gen` only, and only 5 PascalCase tags.
  - JSDoc: an arrow over one Effect is fine.
  - CONTEXT: any sync function may be a tag.
  - The README's own `NotFound` uses `Effect.succeed`. EGW uses `<FilterRow>` as a tag and 8 other sync components as calls.
  - Every app splits `segments.ts` out of `routes.tsx` with the same comment ("No view lives here, so the views can name the segments…"), but the README shows the one-file form.
  - An agent following the README produces a cycle in any multi-file app.
- **North star:** explicit over implicit.
- **Change:**
  - README rules match the JSDoc.
  - The owner picks the tag rule (O1).
  - README "Files" gains a line on `segments.ts`.
  - A `frame/` lint rule for the chosen tag rule.
- **Lines removed:** 0 in code; docs only.
- **Risk:** none. **Public API change:** no. **Wire/stored format change:** no.

### AP11 — one written client composition; inspection registration made visible
- **Files:** 3 apps `client.tsx:42-51`, `README.md:442`, `fw/actor/query-client.ts:1370-1376,1382,1139`, EGW `boot.tsx:64-75`, `README.md:1272-1280`.
- **Problem:**
  - `QueryCache.layer` has no requirements, yet three written forms imply three dependency directions.
  - The cache registers with the Frame registry only if `Frame.layer` is provided *into* it (`Effect.serviceOption(Inspection.Registry)` at construction, `query-client.ts:1139`). `Layer.mergeAll(Frame.layer(…), QueryCache.layer)` compiles and records nothing.
  - P2's `Browser.layer` stays rejected (it hides composition). This candidate keeps the composition visible.
- **North star:** explicit over implicit.
- **Change:**
  - One form in the JSDoc, the README and the 3 apps: `Layer.mergeAll(transport, QueryCache.layer, Location)`.
  - Owner question O2 covers the optional registry.
- **Lines removed:** about 6.
- **Risk:** none. **Public API change:** no, unless O2. **Wire/stored format change:** no.

### AP12 — F5: EGW runs its server from the app directory; the README says why
- **Files:** `egw/src/app.tsx:1-3`, `egw/src/routes.tsx:1-3`, `egw/alchemy.run.ts:63`, `egw/test/browser/playwright.config.ts:20`, `README.md:46-48`.
- **Problem:** The pragma works around a cwd that has no app tsconfig (§2). The framework has nothing to fix.
- **North star:** explicit over implicit: the runtime is named in one place.
- **Change:**
  - EGW: `startCommand: 'cd out && bun --cwd apps/egw-search server/main.ts'`, and the Playwright `webServer` runs from the app root (`bun test/browser/server.ts`, `cwd` set to the app).
  - Delete the two pragmas and their comments.
  - README one sentence: "`bun run` and `bun test` read the tsconfig of the working directory only; run an app from its own directory (`bun --cwd <app>`)."
  - Rejected alternatives: a published Bun plugin (explicit over implicit: a source rewrite by file pattern), and a root `bunfig.toml` (bible-tools has Solid apps).
- **Lines removed:** 6.
- **Risk:** low: verify with the deploy's `turbo prune` layout. **Public API change:** no. **Wire/stored format change:** no.

## 5. Q5: state outside a message, and host or mode branches

- **No view branches on host or mode.** `grep -rnE "\b(window|document|location|globalThis|process\.env)\b"` over the view files of all 4 apps finds only prose. Host and environment reads live at entries (`client.tsx`, `boot.tsx`, `server.ts`, `terminal.tsx`, `index.dev.tsx`), and each server-side one carries a disable with a reason or sits under the `.oxlintrc` override (AP5).
- **Shared state outside a message:** one site. dash `commands.ts:43-45` writes the shared `TenantInfo` cache entry through `FollowedQuery.override` before the `Ack` is sent. That is framework API (`query-client.ts:1128`), marked stale and replaced by any authoritative value. The dashboard is its only user (`grep -rn "\.override("` → 1). Owner question O4.
- **EGW test fixture:** module-level `let` state (`test/browser/server.ts:80-83`) under a written disable. It is a test process edge. Fine.
- **EGW-only, below the 2-app bar:**
  - `server/inspect.ts:33-45` copies the gateway's state-directory rule from `packages/inspect/src/cli.ts:125-140` ("as the effect-frame CLI picks it"). One concept, two owners across repos. The inspect package could export the resolver.
  - `server/document.ts:57` rebuilds the renderer's empty document by hand for the time-out answer.

## 6. Not worth a pass

- The `data-hydrated` marker in the dashboard's `client.tsx:36-39` is set but read by no dashboard test (the readers are blog `tests/browser.test.ts:59` and notes `tests/navigation.test.ts:60`).
- `followLinks(document, …)` in 3 apps vs `followLinks(root, …)` in EGW: a one-word difference. Pick one in the README.
- The hydration-mismatch `logWarning` is written in 4 entries and dropped by the README (`ex/counter/client.tsx:22`).
- dash `orders-page.tsx:18-23` `nameOf` checks `_tag === "Ready"` where `QueryState.match` is the documented form.
- dash `AlertsCard` uses `Effect.sync` with nothing to suspend (`overview.tsx:124`).
- Non-view helpers are split between `Effect.fn` and an arrow over `Effect.gen` (§3). There is no written rule, and each site is a single line.
- The notes `dispatch` pass-through (`commands.ts:14-19`) still fails the deletion test.
- EGW `displayState` builds `{ ...current, stale: true }` rather than `QueryState.Ready(value, true)` (`app.tsx:302-305`). It goes away with P15.
- The EGW workspace `update`/`replace` bodies are identical but for the verb (`app.tsx:184-197`).
- There are 3 identical `dom-setup.ts` files (31 lines, differing by URL). Each proving example stands alone by design (`CONTEXT.md` "Proving example").

## 7. Owner questions

- **O1 (AP10).** May a sync PascalCase function be a JSX tag (CONTEXT) or not (README)? Allowing it is **expressive**, since EGW's `FilterRow` reads well. Forbidding it keeps the tag set closed, which is **explicit**.
- **O2 (AP11).** Should inspection registration be a required input (`QueryCache.layerInspected(frame)`, or `QueryCache.layer` requiring `Inspection.Registry`)? That is **explicit**, but costs every app a `Frame.layer`. Keeping it optional is less to write, but it is a hidden optional service.
- **O3 (§1).** Should a test transport tap (`ActorTransport` wrapper with recorded reads, holds and streams) live in `effect-frame/actor/testing`? It is written 3 times, and the bodies differ by 126 diff lines. A shared tap is **expressive**. Keeping one per proving example is **explicit** about what each app proves.
- **O4 (§5).** `FollowedQuery.override` writes a shared cache value outside a message. It is kept as a marked-stale guess (**expressive**). The strict **actor-model** reading moves the guess into the Alerts actor's prediction.
