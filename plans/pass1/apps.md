# Architecture pass 1: apps and EGW Search

Scope: effect-frame `apps/{blog,dashboard,notes}/src` (branch `hydrate-order`, HEAD `bacd899`) and bible-tools `apps/egw-search/{src,server}` (HEAD `f5477d72`, effect-frame 0.26.1). Read only. Nothing was run and no file was edited.

Paths are shortened: `blog/`, `dash/` and `notes/` mean `effect-frame/apps/<app>/src/`. `egw/` means `bible-tools/apps/egw-search/`. `fw/` means `effect-frame/packages/effect-frame/src/`. Counts leave out `*.test.*` and `dist/`.

## 1. Job × app table

A cell marked **≠** differs from the other apps.

| Job | blog | dashboard | notes | EGW |
|---|---|---|---|---|
| Define a view | arrow + `Effect.gen` (4), `Effect.map` (`page.tsx:33`), `Effect.succeed` (`views.tsx:79`) | arrow + `Effect.gen` (8). Also `Effect.sync` (`overview.tsx:124`), and a view that *is* `Errored(...)` (`views.tsx:85`) or `Loading(...)` (`overview.tsx:101`) | arrow + `Effect.gen` (6), `Effect.flatMap` (`views.tsx:58,71`) | **≠** `Effect.fn('Name')` (4: `app.tsx:147,225,425,676`), plus 9 sync `(props): Node` functions |
| Name a view | unnamed | unnamed | unnamed | **≠** named with `Effect.fn`. The docs ask for this (`fw/view/view.ts:151`); no app does it |
| Use a sync component | none | none | none | **≠** called as a function 14× (`Chip({..})`, `HitRow({..})`, …) and used as a JSX tag 5× (`<FilterRow>`, `app.tsx:453-493`) |
| Bind state (local) | none | `spawn(Behavior.value)` + `send(Value.Set)` (`views.tsx:50,56`; `overview.tsx:164,193`) | `spawn(Behavior.value)` + hand-rolled `writeDraft` (`commands.ts:29-32`) | **≠** `Cell.make` 3× (`app.tsx:239,427,681`) |
| Bind state (to DOM) | `View.bind` | `View.bind` | `View.bind` | `View.bind` (the same everywhere: 44 in apps, 26 in EGW) |
| Send a message | `View.form` only | `sender(...)` → `.current` → `.send` (`commands.ts:45-115`); `alerts.get` → `.send` (`commands.ts:105`) | `dispatch` pass-through (`commands.ts:15-20`); `Generated.send` (`commands.ts:44`) | no actor. Search is `followQuery` only |
| Submit a form | `View.form` (`page.tsx:58`) | **≠** `View.submit` + `Form.last` read by hand (`views.tsx:59-67`) | `View.form` with `onSend` (`page.tsx:72`) | **≠** `View.submit(() => draft.get…)` (`app.tsx:291`) |
| Key a list | `View.list` 3×, `keyBy` annotated | `<For>` 6× + `View.list` 1×, all annotated | `<For>` 3× + `View.list` 2×, all annotated | `<For>` 3× + `View.list` 1×, all annotated. **≠** positional keys built by hand 3× |
| Read route data | `props.data.x.state` for a query; `props.data.reactions` is `Source<Ref>` | the same, plus `snapshotOf` (`commands.ts:118`) | the same | **≠** no route data. Queries come from `followQuery` inside the view (`app.tsx:263`), and search from `UrlState.make` (`app.tsx:148`) |
| Read the URL search | none | `select(props.search, …)` (`overview.tsx:160`) | `select(props.search)` + `props.replaceSearch` (`views.tsx:106-115`) | **≠** `UrlState.make(Workspace)`. The route's `search` is an empty Struct (`routes.tsx:158`) |
| Conditional render | **≠** a row key carries the tag so that an `if` over `get` is safe (`page.tsx:23-40`) | **≠** `View.list` over `[]`/`["funnel"]` (`overview.tsx:165-174`); `if` inside a `class` bind ×2 | none | `<Show>` 15× (`app.tsx`) |
| Loading/error boundary | `Errored{Loading{outlet}}` + `ready`/`orErrored` | the same + `readyWithStale` | the same | **≠** `<Query state loading failed ready>` (`app.tsx:689`). No `Loading`, `Errored` or `ready` at all |
| Error fallback | `describe` with `Predicate.hasProperty` (`views.tsx:19-32`) | the same code (`views.tsx:25-39`) | the same code (`views.tsx:23-37`) | **≠** typed `QueryFailure` with `Predicate.isTagged` (`app.tsx:633-641`) |
| Boot / hydrate | hand-rolled `hydrateRoutes` (`app.ts:17-27`) | the same copy (`app.ts:16-27`) | the same copy + `readRefusal`/`Form.provideIssues` (`app.ts:17-39`) | **≠** the framework `hydrate` (`boot.tsx:87`) |
| Browser entry | `client.tsx`: `#app`, `provideService(Location)`, `followLinks(document)`, `data-hydrated` | the same (a copy) | the same (a copy) + `terminal.tsx` uses `mount` from **view** | **≠** `#root`, `Layer.effect(Location)`, `followLinks(root)`, `Frame.layer`, no `data-hydrated`, a `beside` hook |
| Server entry | `Bun.serve` + `ManagedRuntime` + `answerPage` (`onInterrupt` close) + `Prerender.serve` | **≠** `answerWith` (`onExit` close + `catchCause` 500) + `CurrentPrincipal` | same as blog + form issues written by hand (`server.ts:71-76`) | **≠** `effect/unstable/http` `HttpRouter` + `HttpEffect.scopeTransferToStream`; a timeout sends the client-only page (`document.ts:79-104`) |
| Client bundle | `bundleClient` (`prerender.server.ts:24-43`) | `buildClient` (the same code, `server.ts:46-66`) | `buildClient` (the same code, `server.ts:29-49`) | the `bun build` script |

Per-app totals: `Effect.fn('` 0 in apps and 4 in EGW; `<Show` 0 and 15; `Cell.make` 0 and 3; `spawn(Behavior.value` 6 and 0; `Route.query(` 13 and 0; `followQuery(` 0 and 1; `ready(`/`readyWithStale(` 14 and 0; `<Match` 0 and 0; `Await` 0 and 0.

## 2. Candidates

### P1: the apps hand-roll `hydrate`, which the framework now owns
- **Files:** `blog/app.ts:17-27`, `dash/app.ts:16-27` and `notes/app.ts:25-39` are line-for-line the same as `fw/router/hydrate.ts:29-48` (added in `b8dbda1`, 2026-09-24). EGW already calls `hydrate` (`egw/src/boot.tsx:87`). Tests reach the copies: `blog/../tests/fixture.ts:21,355`, `notes/../tests/fixture.ts:17,120`, `notes/../tests/modes.test.tsx:11,161`.
- **Problem:** the job is written in 3 copies. The copies already lack `hydrate`'s op-wire gate (`hydrate.ts:36-46`). Notes also reads the form issues itself (`notes/app.ts:17-22,29-33`) with a script id the framework owns (`fw/actor/form.ts:517`). `Dom.readRecords` appears in 4 files: 3 apps and the framework.
- **North star:** declarative (the author sequences framework work).
- **Framework-side:** `hydrate` reads `Form.issuesScriptId` and provides the issues itself.
- **App-side:** delete the three `app.ts` files. `client.tsx` calls `hydrate({routes, notFound, root})`, and the tests import it.
- **Risk:** low. Public API change: no. The issues read is internal.

### P2: no canonical browser entry, and the mount id has two owners
- **Files:** `blog/client.tsx:13-44`, `dash/client.tsx:13-46` and `notes/client.tsx:13-46` are copies that differ only in the log label. `egw/src/boot.tsx:75-115` differs in 5 ways (see the table). The id is written as HTML text on the server (`dash/server.ts:70`, `notes/server.ts:53`, `blog/document.ts:11`, `egw/server/document.ts:49`) and read back with `getElementById` (4 places).
- **Problem:** there are two shapes, and an agent copies whichever it opened first. `Location` is provided two ways, and `followLinks` has two roots. The mount id is a string that two files must agree on.
- **North star:** explicit (one visible shape), Effect-native (`Layer.effect(Location, …)` is the layer form).
- **Framework-side:**
  - `Html.Document` gets a `rootId`, and a `Dom.root(id)` that fails with a typed error.
  - An optional named `Browser.layer({ actors: "/actors" })` = `HttpTransport` + `queryCacheLayer` + `Location`.
  - One README entry.
- **App-side:** 4 entries collapse to the EGW shape.
- **Risk:** low. Public API change: yes, additive.

### P3: the server page answer is hand-rolled 4 times, with divergent lifetimes
- **Files:**
  - `blog/server.ts:53-80` and `notes/server.ts:86-115` close the scope only on interrupt and timeout. A defect inside `respond` leaks it.
  - `dash/server.ts:96-150` closes it on any non-success and answers 500.
  - `egw/server/document.ts:79-104` transfers the scope to the stream.
  - Actor-prefix stripping is written 4 times: `blog/server.ts:157-160`, `dash/server.ts:209-212`, `notes/server.ts:184-189`, `egw/server/main.ts:371-377`.
  - `"/actors"` has 5 owners in notes alone (`server.ts:26`, `client.tsx:39`, `page.tsx:78`, `notes.server.ts:33`, `terminal.tsx:48`).
- **Problem:** four apps map `DocumentOutcome` to a `Response`. Each gets redirect, streaming scope, timeout and defect handling slightly differently.
- **North star:** Effect-native (Scope ownership), declarative.
- **Framework-side:**
  - `Document.respond(outcome)` → `HttpServerResponse` with the scope transfer, or a route `HttpServer.documents({routes, notFound, document, closeWhen, principal, onTimeout})`.
  - `HttpServer.make({ prefix })` as an `HttpRouter` route.
- **App-side:** the three apps move from `Bun.serve` + `ManagedRuntime.runPromise` to the EGW `HttpRouter` shape. That deletes `respond`, `answerPage`/`answerWith`, prefix stripping and `buildClient` (P3b: `Bun.build` is copied 3× in the apps).
- **Risk:** medium, because it touches every app's server tests. Public API change: yes.

### P4: the render path has a hidden principal default
- **Files:** `fw/actor/principal.ts:34-37` gives `CurrentPrincipal` the default `Anonymous`. The actor path must say `principal: HttpServer.anonymous` explicitly (`blog/server.ts:130`, `notes/server.ts:163`, `egw/server/main.ts:370`; each app comments "a written line, not a default"). The page render path never says it (`blog/server.ts:43-51`, `notes/server.ts:66-84`, `egw/server/document.ts:79-86`). Only `dash/server.ts:148` provides it.
- **Problem:** the same decision is explicit on one path and implicit on the other.
- **North star:** explicit over implicit.
- **Framework-side:** `renderDocument` (and P3's handler) requires a `principal` option.
- **App-side:** three call sites add `principal: HttpServer.anonymous`.
- **Risk:** low. Public API change: yes, breaking.

### P5: following the current actor reference is written three ways
- **Files:**
  - `dash/commands.ts:117-121` `snapshotOf`, which uses `Stream.switchMap`.
  - A single-row `View.list` keyed to remount: `blog/page.tsx:79-108` and `notes/page.tsx:36-40,153-168`. Each duplicates an `Opened` interface and `Stream.mapEffect`.
  - A snapshot `yield* alerts.get` before sending (`dash/commands.ts:105`).
- **Problem:** the binding is `Source<RemoteActorRef>`, and `fw/actor/source.ts:235` has no `switchMap`/`flatten`. "Remount when X changes" has no primitive, so the apps fake it with a keyed list.
- **North star:** actor-model, Effect-native.
- **Framework-side:**
  - `Source.switchMap`.
  - `View.keyed({ on: Source<A>, key: (a) => string, view: (a: A) => Effect<Node> })`, which remounts the view when the key changes.
  - Or an actor binding that exposes `.state` directly.
- **App-side:** delete `snapshotOf` and both `Opened` copies. `ListView` and `PostView` each lose about 15 lines.
- **Risk:** low. Public API change: yes, additive.

### P6: no conditional that hosts a view
- **Files:**
  - `Show`, `Match` and `Query` take sync `Node` children (`fw/view/control.ts:63-90`, `readiness.tsx:479-485`). `For` and `View.list` are the same job split by sync vs Effect (`control.ts:12-60`).
  - Workarounds:
    - The dashboard mounts a card through `View.list` over `[]`/`["funnel"]` (`overview.tsx:165-174`).
    - EGW builds `ResultsRegion` before the `<Show>` that hides it (`app.tsx:272-277` vs `311-317`). Its `Cell` and `Source.on` stay alive while hidden, which contradicts "a hidden branch … observes no source" (`CONTEXT.md:175-177`).
    - EGW builds the `Empty(...)` fallback eagerly (`app.tsx:314,708`).
    - The blog keys a row by `${at}:${tag}` so that an `if` on a `get` snapshot is safe (`blog/page.tsx:23-40`).
- **North star:** declarative, explicit (one rule).
- **Framework-side:**
  - One rule: control flow whose branch or row runs a setup is an Effect on `View` (`View.list`, `View.show`, `View.match`, and `View.keyed` from P5). Sync tags stay for `Node` children only.
  - Alternatively, `For` becomes `View.list` with an optional setup, so only one name is left.
- **App-side:**
  - The dashboard funnel uses `View.show`.
  - EGW's `region`/`Empty` move into the branch.
  - The blog's `BlockView` uses `Match` and a natural key.
- **Risk:** medium. Public API change: yes.

### P7: `keyBy` needs a type annotation at 19 of 19 sites
- **Files:**
  - blog: `page.tsx:94,103`, `views.tsx:58`.
  - dashboard: `overview.tsx:60,92,112,130,172`, `orders-page.tsx:44,81`.
  - notes: `views.tsx:81,125`, `page.tsx:114,163`, `terminal-view.tsx:41`.
  - EGW: `app.tsx:192,716,828,838`.
  - Five of them are `View.list` object options, not JSX, so the problem is not JSX-only. EGW also annotates `row: (row: Source<PaneRow>)` (`app.tsx:193`).
- **Problem:** `keyBy` and `row`/`children` are both context-sensitive, so TypeScript defers inferring `Item` from `each`.
- **North star:** expressive.
- **Framework-side:** `key: "id"`, a field name typed `{[K in keyof Item]: Item[K] extends string ? K : never}`, or `each` as a positional first argument (`View.list(each, {key, row})`).
- **App-side:** delete 19 annotations.
- **Risk:** low. Public API change: yes.

### P8: positional keys are hand-built 4 times
- **Files:** `egw/src/app.tsx:187-189` (with `PaneRow`), `701-703` (with `Row`), `742-743` (with `Paragraph`), and `blog/page.tsx:29-30` (with `Placed`).
- **Problem:** wrapping each item in `{key: String(i), …}` exists only to feed `keyBy`.
- **North star:** expressive.
- **Framework-side:** an explicit `key: View.byIndex` (or `View.index`).
- **App-side:** delete 4 wrapper types and mappers.
- **Risk:** low. Public API change: yes, additive.

### P9: readiness has three idioms and error routing is opt-in
- **Files:**
  - `Loading` + `ready(state, placeholder)`: 14 calls in the apps. Each placeholder is never shown: the tenant placeholder twice (`dash/views.tsx:92-96`, `orders-page.tsx:94-98`), and `blog/page.tsx:21`.
  - `<Query>`: EGW only.
  - `Await` (`fw/view/readiness.tsx:521`): 0 uses. It is a pass-through over `Query`, and it is a PascalCase Effect.
  - `orErrored` is added by hand: 11 reads have it and 3 do not (`blog/views.tsx:55`, `notes/views.tsx:77,105`). What a failure does depends on whether the author remembered it.
  - The `Errored` fallback is `Source<Option<unknown>>` (`readiness.tsx:441`), yet every route and `followQuery` failure is `QueryFailure` (`fw/router/branch.ts:280`, `fw/actor/query-client.ts:1455`). So three apps carry the same untyped `describe`.
- **North star:** explicit, expressive.
- **Framework-side:**
  - One read, `View.ready(state)`, that registers with both scopes by default and has a named opt-out.
  - `Errored` is typed `QueryFailure`.
  - Delete `Await`.
  - Decide whether `Query` or `ready` is the documented default.
- **App-side:** delete 3 `describe`/`failure` copies and 11 `orErrored` wraps.
- **Risk:** medium, because it changes semantics for the 3 unwrapped reads. Public API change: yes.

### P10: `Source` combinators are missing, so apps hand-roll them
- **Files:**
  - A dedup: `egw/src/app.tsx:240-243` (`Stream.changes`, because `select` does not dedupe, `fw/actor/source.ts:24-30`).
  - A constant: `app.tsx:571` (`select(params, () => props.nonSelective)`). `constant` is private at `source.ts:32`.
  - notes `filtered` (`page.tsx:43-53`) is `Source.zip`.
  - notes `follow` (`page.tsx:64-69`) re-implements `Source.on` with a captured scope.
- **North star:** Effect-native.
- **Framework-side:** export `Source.constant`, `Source.changes` (dedupe by `Equal` or a given equivalence) and `Source.switchMap` (see P5).
- **App-side:** 4 helpers deleted.
- **Risk:** low. Public API change: yes, additive.

### P11: the dashboard needs a send-only actor, and the route cannot declare one
- **Files:** `dash/commands.ts:41-66`. `sender` keeps a mutable `Map` + `Semaphore` cache of `commandRef` per tenant. `fulfil`, `cancel` and `writeMemo` (`68-76,109-115`) are pass-throughs over it. The file comments that "the order book is not route data" (`segments.ts:45-46`).
- **North star:** actor-model, declarative.
- **Framework-side:** `Route.commands(Contract, key)`, a binding to `Source<RemoteCommandRef>`, or `Route.actor(…, { observe: false })`.
- **App-side:** delete `sender` and the 3 pass-throughs. The views call `ref.send`.
- **Risk:** low. Public API change: yes, additive.

### P12: `View.form` restates what the binding and the transport own
- **Files:** `blog/page.tsx:57-66` and `notes/page.tsx:71-84` both pass `ref`, `contract`, `key`, `endpoint: "/actors"` and `returnTo: (yield* Router).current.get…pathname`. The ref carries neither the contract nor the key (`fw/actor/vocabulary.ts:288-308`), so the view's key can disagree with the route's.
- **Problem:** `returnTo` is a snapshot taken once and drops the search string. After a filter change a script-free post returns to `/lists/x` without `?filter`.
- **North star:** explicit (one owner), actor-model.
- **Framework-side:**
  - Route actor bindings carry the contract and key, so the form is `View.form({ actor: props.data.notes, message, typed })`.
  - The endpoint comes from `ActorTransport`.
  - `returnTo` accepts an explicit `View.here` (the live URL).
- **App-side:** 2 forms shrink. `"/actors"` is gone from views.
- **Risk:** medium. Public API change: yes.

### P13: `link` params are fixed values, while search accepts an updater (suspected defect)
- **Files:** `fw/router/link.tsx:36-52` fixes `params`, but `search` may be an updater. The dashboard snapshots params for links in views that it says outlive a tenant move (`dash/commands.ts:37-38`): `views.tsx:98-100` and `overview.tsx:156-159`. The header's hrefs would keep the old tenant.
- **North star:** declarative.
- **Framework-side:** `params` also accepts `(current) => Params` or a `Source`.
- **App-side:** 5 links.
- **Risk:** needs a red test before the fix. Public API change: yes, additive.

### P14: URL search has two owners
- **Files:**
  - EGW declares an empty search (`routes.tsx:158`) and owns it in the view through `UrlState.make` (`app.tsx:148`) with a codec that round-trips through a string (`url-state.ts:318-333`).
  - notes and dashboard use the route's `search` + `replaceSearch`.
- **Problem:** two models for one job. `Route.search` takes a `Struct`, so EGW's multi-pane shape cannot live on the route.
- **North star:** declarative, explicit.
- **Framework-side:** `Route.search` accepts any Schema from `Route.SearchRecord`, and route props offer `push`/`replace` updaters. Or `UrlState` is documented as the one way. The owner picks.
- **App-side:** EGW moves `Workspace` onto the route, or the notes move to `UrlState`.
- **Risk:** medium. Public API change: yes.

### P15: debounced query input is merged into `stale` by hand
- **Files:** `egw/src/app.tsx:256-268` (`Source.debounce` + `sameArgs` + a `displayState` zip). `ResultsProps.settledState` (`647-650`) exists only because of it.
- **North star:** declarative.
- **Framework-side:** `followQuery(q, args, { debounce })`, which marks Ready as stale while input is pending.
- **App-side:** about 15 lines and one prop deleted.
- **Risk:** low. Public API change: yes, additive.

### P16: the view naming rule is not followed and not enforced
- **Files:**
  - `fw/view/view.ts:151` prescribes `Effect.fn("Name")`. The apps follow it in 0 of about 22 views; EGW in 4 of 4.
  - EGW calls sync components as functions 14× and as tags 5×.
  - Name collisions show up in EGW: `Query as HostQuery` (`egw/src/search-page.test.tsx:6`), and `mount` imported from view (`notes/terminal.tsx:2`) vs from the router (`notes/app.ts:2`).
- **North star:** explicit.
- **Framework-side:** a lint rule or docs: an exported view is `Effect.fn`, and a sync `Node` function is used only as a JSX tag. Resolve the collisions (trial #9).
- **App-side:** rename about 22 views in the apps and 14 call sites in EGW.
- **Risk:** low. Public API change: no, unless the names are resolved.

### P17: local state has two primitives
- **Files:** 6 `spawn(Behavior.value)` + `Value.Set` (`dash/views.tsx:50`, `overview.tsx:164`, `notes/views.tsx:136`, `page.tsx:60,63`, `terminal-view.tsx:32`) vs `Cell.make` (EGW 3×). `notes/commands.ts:29-32` `writeDraft` re-implements `Cell.set` (`fw/actor/cell.ts:29-35`).
- **North star:** expressive.
- **Framework-side:** make `Cell` the documented view state.
- **App-side:** 6 sites. Delete `writeDraft`.
- **Risk:** low. Public API change: no.

## 3. EGW: the framework changes that simplify it most

1. **P6 + P5** (a view-hosting `View.show` and `View.keyed`). `region`/`Empty` move into their branches (`app.tsx:270-277,311-317,708`). The two `Source.on` resets (`244`, `682-685`) become keyed remounts.
2. **P15.** Debounce and stale go away (`256-268`, `647-650`).
3. **P10.** The dedup (`240-243`) and the constant lift (`571`) go away.
4. **P8 + P7.** 3 wrapper types and 4 annotations go away.
5. **P14.** `url-state.ts:307-333` and the empty route search go away.
6. **P3.** `server/document.ts:76-104` and `server/main.ts:366-379` become two framework routes.

**If the view exports were renamed or reshaped** (`Show`/`For`/`Query` → `View.*`, lowercase Effects), these EGW files change:
- `egw/src/app.tsx`: imports at lines 29-30, 15 `<Show>`, 3 `<For>`, 1 `<Query>`, 2 `View.list`, `attach=`.
- `egw/src/routes.tsx`: `View.bind`, line 142.
- `egw/src/workspace-route.test.tsx` (`View`, `Dom`, `ViewTest`).
- `egw/src/search-page.test.tsx` (`Dom`, `ViewTest`; the `HostQuery` alias resolves).
- `egw/server/document.ts`: `Html` type only.

`egw/src/boot.tsx` imports nothing from `view`.

## 4. Boot and entry: is there one shape?

No. There are two browser shapes (the 3 app copies and EGW's) and four server shapes (see the table, and P1-P4). EGW is closest to the target: framework `hydrate`, layer-provided `Location`, `HttpRouter`, and scope transfer. The canonical shape would be EGW's `boot.tsx` plus P2's typed root, and EGW's `document.ts` routed through a framework `respond` (P3) with an explicit principal (P4).

## 5. Not worth a pass (app-side, one line each)

- EGW `Empty.nonSelective` is always `false` (`app.tsx:314,710`), so the hint at `571-576` is dead.
- The dashboard's stale-class `if` binding is written twice (`views.tsx:112-117`, `overview.tsx:38-43`). A `select` helper covers it.
- The notes `dispatch` pass-through (`commands.ts:15-20`) fails the deletion test.
- `compose.issues.map` (`notes/page.tsx:109`) is a static array inside a live view. It is fine today, but it is the only non-Source list.
- EGW `src/contract.ts:203` and `app.tsx:33-40` import `../server/api.js`. The boundary check is suffix-based, and `api.ts` is schema-only, so it is safe but invisible to `bun run boundary`.
- There are no `as` casts and no `any` in any app or EGW source. The only fights with the framework are the annotations in P7.
