# Architecture pass 1: docs and the agent entry

Scope: `README.md`, `CONTEXT.md`, `docs/**`, the package and app READMEs, `.changeset/`, and the JSDoc on public exports reachable from `packages/effect-frame/package.json` `exports`. Branch `hydrate-order` (HEAD `bacd899`). Read-only. The only files written are in the scratchpad: this report and `p1d-*` probe outputs (README block extraction under `p1d-readme/`).

## What a cold agent reads first, and what it gets

The repo has no `AGENTS.md` or `CLAUDE.md`. The only agent-facing file is `.claude/skills/architecture-loop/`. So the agent reads `README.md`, then `CONTEXT.md`.

- **README top, lines 1-33:** "in design and implementation" (L3). A closed map is "the source of truth" (L5). A requirements list is "not implemented features" (L16). "does not yet contain a framework runtime" (L20). "No … npm publication is configured" (L33). The agent learns nothing true until L35.
- **README order:** sections are in ticket order: boundary, inspection, optimistic, routing, forms, streaming, driven, authorization. It is not a learning path. The README never shows how to define and host an actor (`implement`, `implementTransparent`, `implementQuery`, `spawn`: 0 hits each), and it never shows the view basics. These names have 0 hits in README.md: `Show`, `View.list`, `ready(`, `orErrored`, `Errored`, `select`, `View.event`, `Route.PropsOf`, `Route.actor`, `HttpTransport`. The receipt is the grep table in this session: `grep -cF "<name>" README.md`.
- **Wrong names:** the README teaches names the apps don't use. It teaches `mount` + `Dom.hydrate` + `Streaming.resume` by hand (README:495-503). It never names the router's `hydrate` (router/index.ts:201), which does exactly that sequence.
- **Missing publish surface:** `packages/effect-frame` has no README, so the npm package page and `node_modules/effect-frame/` carry no docs for a consumer agent.

---

## Q1. Stale claims (path:line → current truth, receipt)

| # | Claim | Truth | Receipt |
|---|---|---|---|
| S1 | README.md:3 "in design and implementation" | Published at 0.26.1, with a release workflow | `packages/effect-frame/package.json` `"version": "0.26.1"`, `"private": false`; `.github/workflows/release.yml:31` changesets/action |
| S2 | README.md:5 "first-release map (#1) is the source of truth" | #1 is closed. The active maps are #33 and #47 | `docs/wayfinder/github.md:7-10` |
| S3 | README.md:7-16 "release requirements… not implemented features" | Local and remote hosts, browser/OpenTUI JSX, SSR and hydration all ship. Alchemy does not (0 `alchemy` hits in `packages/*/package.json`) | `view/hosts/opentui.ts`, `router/document.ts`, `apps/notes/tests/modes.test.tsx` |
| S4 | README.md:20 "does not yet contain a framework runtime. The actor API, renderer adapter, and recovery model remain open decisions" | The runtime exists: `view/runtime.ts:1725 mount`, `actor/host.ts`, `actor/durable.ts` | `packages/effect-frame/src` has 35k+ lines (ledger baseline) |
| S5 | README.md:22 describes `tooling/checks` as codec probes and the boundary rule | It also holds the `declarations` rule and the `consumer` project | `tooling/checks/package.json` `"declarations"`; root `package.json` gate runs `bun run declarations` |
| S6 | README.md:33 "No cloud deployment or npm publication is configured" | npm publication runs through changesets and OIDC | `.github/workflows/release.yml:31-33`, `package.json` `"release": "bun run build && changeset publish"` |
| S7 | README.md:79-81, list of public subpaths | It omits `view/driven` and `router/prerender`. It lists `view/testing`, a subpath with 0 importers (`ViewTest` is also exported from `effect-frame/view`) | `package.json` exports; `view/index.ts:56`; `grep -rhoE 'from "effect-frame/view(/testing)?"'` gives 109 plain `view` and 0 `view/testing` |
| S8 | README.md:121-123 and 198-199 list the modes as `client`, `ssr`, `streamed`, `awaitAll` | `prerender` and `driven` are also mode constructors | `router/route.ts:48-64` (`driven`, `drivenAt`, `prerender`) |
| S9 | README.md:514 "`Html.renderToString` is unchanged" | Changelog voice: "unchanged" relative to nothing | n/a |
| S10 | README.md:495-503, the hand-rolled client boot | `effect-frame/router` `hydrate({routes, notFound, root, wire?})` is "the one call" for that sequence | `router/hydrate.ts:9-48` |
| S11 | CONTEXT.md:51-57 = 179-185 (Server module, Browser entry), 175-177 = 199-201 (Shown branch) | These are word-for-word duplicates | `cat -n CONTEXT.md` |
| S12 | CONTEXT.md:132 "Every contract, query, and **protected route** names [a policy]" | No route names a policy. Routes gate through `before` | `grep -n policy packages/effect-frame/src/router/*.ts` finds comments only; `branch.ts:450 SegmentOptions` has no policy field |
| S13 | CONTEXT.md:67 "Layout: A **route** that has children" | A layout is a branch: `Route.layout(segment, children, view)` | `router/branch.ts:1163`; README.md:121 "A branch is a segment with its view" |
| S14 | CONTEXT.md:63 "Route … declares the queries and actor references" | Declarations live on a segment (`data:`). A flat route (`RouteDefinition`) has no `data` | `router/codec.ts:493-505` vs `branch.ts:450` |
| S15 | apps/notes/README.md:33 "`ListNotes`, the notes a list page resumes from" | Removed | `grep -n ListNotes apps/notes/src/queries.ts` finds nothing; `docs/design/notes-example.md:98-100` "`ListNotes` is gone" |
| S16 | packages/inspect/README.md:48 `yield * attachGateway(...)` | The formatter read `yield*` as multiplication. Copied as written, it is wrong code | the file line |
| S17 | docs/design/acceptance.md, 36 **Proven** rows cite dead paths | About 25 are pure moves: `packages/actor/tests/*` → `packages/effect-frame/tests/actor/*`, `packages/view/tests/{dom,opentui,ssr}` → `tests/view/`, `packages/router/tests/router.test.tsx` → `tests/router/`. L146 cites `tests/view/query-active.test.tsx`, but the file is in `tests/router/`. The rest are app rows marked "app row open" | scratchpad `p1d-deadpaths.txt`: 60 dead refs in acceptance.md, in rows 11-32, 54, 91, 146 |
| S18 | docs/design/sketches.md:13-23 (10 `packages/actor/src/*`, `packages/view/src/*` paths); delivery.md:27; op-wire.md:17-18; inspection-gateway.md:8 `tooling/inspection-gateway` | Those packages were merged into `packages/effect-frame` | `ls packages` shows `effect-frame host-durable-object inspect` |
| S19 | docs/design/sketches.md:20 and 368 `Route.page`; :34 `Actor.remote`; :38 `Actor.fromEntity` | These APIs never existed. The file is marked as sketches at L5, but a grep lands on it with no warning at the hit | `p1d-gone.txt` |
| S20 | `.claude/skills/architecture-loop/rejected.md:3` "ledger rows in `plans/architecture-loop-*.md`" | There is no `plans/` directory | `ls -a` at the repo root |
| S21 | router/route.ts:6-9 module doc lists the modes `client, ssr, streamed, awaitAll, prerender` | It omits `driven` and `drivenAt` | route.ts:54-55 |
| S22 | `RenderingMode = "ClientOnly" \| "SSR" \| "AwaitAll" \| "Streamed"` | `prerender` and `driven` trees have no member. CONTEXT.md:44 lists five modes | `router/rendering-mode.ts:20` |

Decision records in `docs/design/*` that name superseded APIs *as history* are not stale. Examples: streaming.md:160 `resumeFromDocument` "replaces the ticket's"; authorization.md:53 `Authorizer` "removed". They lack a banner that says "record, not reference" (see D3).

---

## Q2. Missing reference material (answers, ready to paste)

These signatures exist only in `router/branch.ts`, and partly in `docs/design/route-public.md` § "Exact public exports". A cold agent finds neither.

```ts
// router/branch.ts:233, 239: no JSDoc on either
Route.query<Q extends AnyQuery>(contract: Q, args: ArgsOf<Q>): QueryDeclaration<Q>
Route.actor<C extends AnyContract>(contract: C, key: KeyOf<C>, options?: { behavior?: Behavior<SnapshotOf<C>, MessageOf<C>, unknown, Refused> }): ActorDeclaration<C>

// branch.ts:278-289: what props.data.<name> is
Route.query(...)  → FollowedQuery<ResultOf<Q>, QueryFailure>
Route.actor(...)  → Source<RemoteActorRef<C>>   // a Source of a ref, not a ref (trial friction 4)

// branch.ts:688-717: no JSDoc on PropsOf / LayoutPropsOf
type Route.PropsOf<typeof seg>              = { params: Source<P>; search: Source<S>; href; updateSearch; replaceSearch; data: RouteData<Data> }
type Route.LayoutPropsOf<typeof seg, ChildR> = PropsOf & { outlet: Effect<Node, never, ChildR> }
```

**View export kinds.** No doc has this table. It comes from `view/index.ts`, `view/view.ts`, `view/control.ts`, `view/readiness.tsx`, and `router/link.tsx`.

| Export | Kind | Use |
|---|---|---|
| `For`, `Show`, `Match`, `Portal`, `Query` (view), `Link` (router), `Fragment` | **JSX tag**, sync `(props) => Node` | `<For …>` |
| `Loading`, `Errored`, `Await` | **Effect, PascalCase** (readiness.tsx:406, 450, 521) | `yield* Loading({ fallback, children })` |
| `View.list`, `View.form`, `View.attempt`, `ready`, `readyWithStale`, `orErrored`, `link` (router) | Effect, lowercase | `yield* View.list({...})` |
| `View.lazy` | returns a `View` (a function to Effect) | route leaf view |
| `View.bind`, `View.event`, `View.submit`, `attach` / `Dom.attach` | sync data for a prop or child position | `{View.bind(src, f)}`, `onClick={View.event(h)}` |
| `View.select` ≡ `select` (actor/client) | sync `Source` projection | Apps use `select` 14 times and `View.select` 0 times |
| `bind`, `event`, `submit`, `attach` (flat) | duplicates of `View.*` (view/index.ts:27-36) | Apps use the flat forms 0 times |
| `mount` (view, positional) vs `mount` (router, options object) | Effect, same name, two signatures | view/runtime.ts:1725 vs router/router.ts |

**Canonical entries (from the apps):**
- **Client:** `Effect.provide(start, Layer.provideMerge(queryCacheLayer, HttpTransport.layer({ baseUrl, reconnect })))`. `start` does `browserNavigation` → `hydrate(...)` provided with `Location` → `followLinks(document, router)` (apps/notes/src/client.tsx:13-45).
- **The apps don't call `hydrate`.** All three hand-roll it. `apps/{blog,dashboard}/src/app.ts` are line-for-line `router/hydrate.ts:29-47` minus `wire`. Notes hand-rolls it only to wrap `Form.provideIssues` (apps/notes/src/app.ts:24-40).
- **Server:** `renderDocument({ routes, notFound, url, document, closeWhen })` in the request Scope. Then comes the 303 or body mapping, `HttpServer.make/toWebHandler` for `/actors/*`, and `HttpServer.form` for `/actors/form` (apps/notes/src/server.ts:66-120).

**Three ways to follow a query.** A cold agent needs one:
- `useQuery` (query-client.ts:1323): 0 app uses, 149 test uses. Its JSDoc calls it "the view-facing name".
- `followQuery`: 0 app uses, 18 test uses.
- `Route.query` in `data`: 13 app uses.

---

## Q3. JSDoc that contradicts code or practice

| ID | Location | Says | Truth / receipt |
|---|---|---|---|
| J1 | view/view.ts:151-152 (`View.View`) | "A named view is `Effect.fn("Name")(function* (props) {...})`" | No app view does this. `Effect.fn(` appears in apps only on server, boot, and command helpers (`grep -rn 'Effect.fn(' apps/*/src`: server.ts, app.ts, commands.ts). Every view is `(props) => Effect.gen(...)`. The trial wrote the doc's form and a reviewer flagged it |
| J2 | view/control.ts:6-10 | "Control flow in JSX. **Both** take an explicit source" | The module has `For`, `Show`, `Match`, `Portal`, and `list`. `Portal` takes no source (control.ts:162-178) |
| J3 | view/readiness.tsx:23-24, 171-172 | "A `ready` call with no `Loading` above it … is a compile error" / "does not compile" | The view and `Route.leaf` accept it. `LoadingScope` surfaces only in `mount`'s `R` or at `runFork` (trial friction 6, `trial/probe-scope.tsx.txt`). It is a compile error, but far from the cause |
| J4 | actor/query-client.ts:1317-1321 (`useQuery`) | "The view-facing name; it is `useQuery` in a React-shaped runtime" | Views get queries from `Route.query` data (13 app uses) and never from `useQuery` (0). It is also a React name in an Effect API |
| J5 | view/form.ts:30-33 (`CommandForm.message`) | "one `TaggedStruct` **of the contract's union**" | The type is `M extends Member<C>` = `Schema.Top & { Type: MessageOf<C> }` (form.ts:69). It checks type assignability, not membership or plain-post decodability. A `Finite` field compiles and fails at runtime (trial friction 7, `probe-form.ts.txt`) |
| J6 | router/route.ts:6-9 | Lists the modes without `driven` | See S21 |
| J7 | actor/behavior.ts:103-107 | The "Simple state…" doc sits on `ValueOptions`, not on `value`/`Value` | `Behavior.value` (L113) has no doc. `Value` and `value` differ only by case (`actor/client.ts:58` exports `Value` flat and `Behavior.value` in the namespace) |
| J8 | view/readiness.tsx:517-520 (`Await`) | "`Query` as a view" | Its prop is `query`, where `Query`'s prop is `state` (readiness.tsx:479 vs 510). The same concept has two prop names |

Hot-path exports with **no JSDoc**, counted by a script that checks the line before each `export`:
- `contract`, `resumeCodec` (contract.ts)
- `implement`, `ImplementOptions` (implement.ts)
- `query` and 17 more in query.ts
- `Route.query`, `Route.actor`, `PropsOf`, `LayoutPropsOf`, `SegmentOptions` (branch.ts)
- `For`, all `Show` overloads, `MatchProps` (control.ts)
- `HttpServer.make`, `ServerOptions`
- `redirect`, `Continue` (check.ts)
- `Link`, `LinkProps`
- `Behavior.machine`, `Behavior.value`

No `@example` exists anywhere in `src`: `grep -rc @example` gives 0. The index files (`actor/index.ts`, `view/index.ts`, `router/index.ts`) have no module doc.

---

## Q4. Guard: keep README code blocks compiling

**Probe (done, scratchpad `p1d-readme/`):**
- I extracted the 12 `ts`/`tsx` fences of README.md into files and compiled them with the trial tsconfig (`customConditions: ["source"]`) using `tsgo`.
- Result: **106 errors**. 87 are missing names: about 60 unique free identifiers such as `App`, `Notes`, `notFound`, `host`, `root`, `TenantInfo`, and `Effect` (not imported in 13 places). The other 19 are knock-on errors from those names (TS18004 shorthand, implicit any).
- So the README is not checkable as it stands. No block type-checks without context.

**Design (one owner per fact):**
- Invert the flow. The examples live in compiled files, `docs/examples/*.tsx`, next to one `docs/examples/fixtures.ts` that holds the typed `Notes` contract, `TenantInfo` query, `App` route, `notFound`, `host`, `root`, and so on.
- Each README fence carries a marker: `<!-- example: docs/examples/routing.tsx#tenant -->`.
- A `tooling/checks` rule `docs` does two things:
  - (a) it `tsgo`-checks `docs/examples` (a tsconfig like `tooling/checks/consumer`, so it also reads the built `dist` types a consumer sees);
  - (b) it fails when a README fence's text differs from its `// #region` in the example file. `--fix` rewrites the fences.
- Add a second rule for dead paths: every backticked `packages/…`, `apps/…`, `tooling/…` or `docs/…` path in `*.md` and in `src` JSDoc must exist, unless the row is `Open`. The probe (`p1d-deadpaths.txt`) finds 74 today. About 40 lines of code.

**Estimate:**
- fixtures: 120-180 lines
- extractor and diff: about 80 lines, in the style of `declarations.ts`
- tsconfig: 10 lines
- first pass to make the 12 blocks real: about 0.5-1 day
- gate cost: under 2 s

**Risk:** fixtures drift into a second app. Keep them as `declare const` for anything not under test, and import real code for the contract, route, and query.

---

## Q5. Terms used two ways

| Term | Meaning A | Meaning B (receipt) |
|---|---|---|
| **behavior** | Actor behavior (CONTEXT:11, `Behavior.*`) | `NavigationBehavior` as the option key `behavior:` on `Route.leaf`, flat routes, and `mount` (README:230, 239-241). `Route.actor(…, { behavior })` (branch.ts:216-222) uses the same key with a different type. "Attached behaviour" (CONTEXT:35, British spelling) is a third meaning; its code name is `Attached`/`attach` |
| **boundary** | Server/client boundary (boundary.md, `bun run boundary`) | Readiness `Loading` boundary (README:294, 513; `Host.boundaryMarks`, README:541). "Route-boundary slice" (owned-attempt.md:3). CONTEXT:59 names this "Readiness scope" and says to avoid "Suspense boundary" |
| **scope** | Effect `Scope` | "Readiness scope" / `LoadingScope` / `ErroredScope` are services, not `Scope`s (readiness.tsx:123-127). This is overloaded in an Effect framework |
| **Query** | Glossary: a named server read (CONTEXT:23) | `Query` JSX tag (view/index.ts:66). `Query` server namespace (actor/index.ts:29). `QueryState` module (view/index.ts:59) |
| **Loading** | `QueryState.Loading` state (actor/client.ts:85) | The `Loading` boundary Effect (view/index.ts:64) |
| **Match** | `<Match>` tag (view) | `type Match` (router/index.ts:185, a URL match). `match` (query state fold, actor/client.ts:101) |
| **mount / hydrate** | view `mount(view, props, host, root)`, `Dom.hydrate(root)` | router `mount({routes,…})`, router `hydrate({routes,…})` |
| **Route** | Glossary: an address that declares data (CONTEXT:63) | Code: `Route.segment` is the address. `interface Route` (codec.ts) is a flat route. `AnyRoute`/`Tree` is a mounted mode tree. The glossary lacks **Segment, Branch, Leaf, Tree, Declaration, Binding, Source, Bound, Prepared**, which are README:121's core model |
| **Pending** | Glossary says to avoid it for command state (CONTEXT:97). "Pending log" (CONTEXT:119) | `Route.Pending` / `pending:` (route presentation, branch.ts:739). `PendingCommand` (mailbox, actor/index.ts:13) |
| **Component** | Glossary says to avoid it for a view (CONTEXT:33) | `export type Component` (view/index.ts:40, jsx-runtime.ts:18) |
| **mode names** | Constructors `client`, `ssr`, `streamed`, `awaitAll`, `prerender`, `driven` | `RenderingMode` values `"ClientOnly"`, `"SSR"`, `"AwaitAll"`, `"Streamed"` (rendering-mode.ts:20), which lack prerender and driven |
| **action** | Glossary says to avoid it for a command (CONTEXT:29) | `type Action = "read" \| "send"` (policy.ts:24) (mild) |

---

## Candidates

| ID | Files | Problem | North star | Change | Risk |
|---|---|---|---|---|---|
| **D1** | README.md:1-33, 697-699 | S1-S6: the first screen is false | Explicit | Replace with 5 lines: what it is, the version, the pointer to AGENTS.md or the package README, and `bun run gate`. Delete "First release", "Current state" and "Planning" (the Planning pointer moves to AGENTS.md) | None |
| **D2** | CONTEXT.md | S11 duplicates, S12-S14 wrong, glossary missing the route and view core terms | Explicit | Delete L179-185 and L199-201. Fix Policy, Route and Layout. Add Segment, Branch, Leaf, Tree, Declaration, Binding, Source, Bound, Prepared. Keep CONTEXT.md glossary-only, as its sole owner | None |
| **D3** | new `AGENTS.md`; new `packages/effect-frame/README.md` (cheat-sheet); README.md | No agent entry. Facts are spread over 699 README lines and 30 design docs | Explicit, Declarative | See outline below. The package README ships to npm, so consumer agents get it too. Mark `docs/design/*` with a one-line banner: "Decision record. Reference is the package README and JSDoc" | Low. The cheat-sheet must be guarded (D13) or it drifts |
| **D4** | view/view.ts:151-152 | J1 | Explicit | Say that a view is `(props) => Effect.gen(...)`. Or, if the owner prefers spans, convert the apps. Pick one, then lint for it | None (doc) |
| **D5** | view/control.ts:6-10; readiness.tsx:23-24, 171-172; route.ts:6-9; behavior.ts:103-113; readiness.tsx:510 | J2, J3, J6, J7, J8 | Explicit | Fix the text. For J3, name *where* the error appears ("`mount`'s `R`") until the type-level refusal at the leaf lands (trial #6). Rename `Await`'s `query` prop to `state` | Low (J8 breaks an API) |
| **D6** | actor/query-client.ts:1317-1330, actor/client.ts:119-123 | J4: three ways to follow a query, and the documented one is unused | Explicit, Declarative | Pick `Route.query` as the view path. Keep `followQuery` for non-route code. Delete `useQuery`: its 149 test uses move to `followQuery` | Medium: 149 test call sites (mechanical) |
| **D7** | view/form.ts:30-35, 69 | J5: the doc promises membership that the type doesn't check | Actor-model, Expressive | Doc-only now. The type fix (`Form.Codable` plus a membership constraint) is trial top-5 #4 | Doc: none |
| **D8** | apps/{blog,dashboard,notes}/src/app.ts; router/hydrate.ts; README.md:474-545 | S10: three hand-rolled copies of `hydrate`. README teaches the manual sequence | Declarative | Add `wrap?: (mount) => mount` or a `formIssues` option to `hydrate`. Replace the three `hydrateRoutes` with `hydrate`. README shows `hydrate` as the one client boot | Low. Blog and dashboard are identical to `hydrate` minus `wire` |
| **D9** | package.json exports, view/index.ts:27-36, 56; README.md:79-81 | S7: flat `bind`/`event`/`submit`/`attach` duplicate `View.*` (0 app uses). `ViewTest` is on two paths; `effect-frame/view/testing` has 0 importers | Explicit | Drop the flat re-exports and the `./view/testing` subpath (or drop `ViewTest` from `view`). Regenerate the subpath list | Breaking (allowed); small |
| **D10** | docs/design/acceptance.md (about 25 rows), sketches.md:13-23, delivery.md:27, op-wire.md:17-18, inspection-gateway.md:8 | S17, S18: proof rows cite files that don't exist | Explicit | Path-only rewrite. This does not change any claim (rejected.md's "row change" rule is about claims, not paths). Fix L146 → `tests/router/` | None |
| **D11** | apps/notes/README.md:33; packages/inspect/README.md:48; rejected.md:3 | S15, S16, S20 | Explicit | Fix the text. For S16, add an `oxfmt` ignore or use a `ts` block written inside a `function*` | None |
| **D12** | CONTEXT.md + code names (Q5 table) | One word, two meanings: behavior, boundary, scope, Query, Loading, Match, mount | Explicit | Doc now: the glossary names each code symbol per term. Code (owner decides, and it overlaps the trial top-5 #1): rename `NavigationBehavior`'s option key to `navigation:`, give `Loading`/`Errored`/`Await` lowercase Effect names, and rename `type Match` in router to `RouteMatch` | Code renames are breaking |
| **D13** | tooling/checks (new `docs` rule), docs/examples/* | Q4: README blocks don't compile (106 errors) and can't be checked | Explicit | The region-synced compiled examples described above | Medium effort (about 1 day). Low runtime risk |
| **D14** | tooling/checks (new `paths` rule) | 74 dead path references in md and JSDoc | Explicit | Backticked repo paths must exist unless the row says `Open` | Low. About 40 lines |
| **D15** | `RenderingMode` (rendering-mode.ts:20), CONTEXT.md:43-45 | S22: the mode type lacks prerender and driven, and the glossary doesn't use the code names | Explicit | Add the members, or state in the glossary that prerender and driven are serve strategies over SSR. Name the constructors in the glossary | Check that the inspection wire carries `RenderingMode` (rejected: wire format) before adding members |

### D3: the minimal agent entry (outline, one owner per fact)

**`AGENTS.md`** (about 80 lines; owns *how to work here*)
1. Read order: this file, then `packages/effect-frame/README.md` (API), then `CONTEXT.md` (words), then `apps/notes` (canonical example). `docs/design/*` holds decision records: read one only when a ticket names it.
2. Gate: `bun run gate`. Tests use `--conditions=source`. Bun only.
3. Lint bans an agent will hit: `noTernary`, no `async` or `new Promise` in `src`, `Match.tagsExhaustive` rather than `switch`, `Option.fromNullishOr` rather than `??` (`.oxlintrc.json`, rejected.md:10).
4. File rule: `*.server.ts`. A browser entry imports `actor/client`, never `actor` (moved from README:35-37).
5. Changesets: every `packages/effect-frame` change needs one (`.changeset/config.json`).
6. Where facts live, as a table: glossary → CONTEXT; signatures → JSDoc and the package README; claims → acceptance.md; history → docs/design; the map → docs/wayfinder/github.md (moved from README:697-699).

**`packages/effect-frame/README.md` cheat-sheet** (owns *how to write an app*; every block region-synced by D13)
1. Subpaths: one table of entry → browser/server → what it holds (replaces README:79-81 and the export bullet lists at README:445-448, 536-540, 598-600, 664-670; the index files own the full lists).
2. Actor: `contract` → `Behavior.value`/`reducer`/`machine` → `implement`/`implementTransparent` → `ActorHost.layer` + `Policies`.
3. Query: `query` → `implementQuery`. On the view side, use `Route.query` only.
4. Route: `segment`/`child` → `leaf`/`layout` → a mode constructor. The Q2 signature block, `PropsOf`/`LayoutPropsOf`, and the `Source<RemoteActorRef>` binding.
5. View: the kind table from Q2, a `For` `keyBy` annotation note (trial #3), and "handlers are `View.event`, children are `View.bind`".
6. Readiness: `Loading` + `ready`, `Errored` + `orErrored`, and where a missing `Loading` shows up.
7. Forms: `View.form` + `HttpServer.form`, and the `FiniteFromString` rule.
8. Boot: client `hydrate` (D8) and server `renderDocument` + `HttpServer.make`, as one end-to-end pair.
9. Testing: `ViewTest.make`, `QueryTest.layer`.

**The root README.md** keeps only the feature narratives (optimistic, streaming, driven, prerender, authorization semantics), with every export list removed and each section linking to its design record. That cuts about 699 lines to about 350 or fewer.

---

## Not worth a pass

- README hard-wraps some sections at 72 columns and leaves others unwrapped.
- Ticket numbers in index comments (`// (#16)`, `(#17)`) are noise but harmless.
- `docs/toolchain.md:66-70` has absolute macOS `/Users/cvr/...` paths in a dated report.
- "behaviour" vs "behavior" spelling, if D12 renames the concept anyway.
- `docs/research/*` has stale package names but is labelled as research.
