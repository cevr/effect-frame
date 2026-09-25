# Architecture loop — 2026-09-24

Goal (owner, 2026-09-24): **agent DX**. How can an agent write effect-frame code
correctly the first time? How can the authoring surface be more consistent? The
owner suspects the JSX surface is inconsistent and is hampering agents.

Owner rules for this loop (2026-09-24):

- Run until a pass finds no more findings. The goal is agent DX, consistency,
  and explicitness: no magic, no inconsistencies.
- Breaking changes are allowed. The whole framework can change, as long as it
  stays effect-native, actor-model, and explicit (not implicit).
- No Elm architecture. Many of Foldkit's designs are welcome; adopt them one by
  one where they keep the north stars.
- After each round, update EGW Search (bible-tools `apps/egw-search`) wherever
  the change is relevant.

## Baseline

- HEAD: `7217b17` (Version Packages #109, effect-frame 0.26.1). Pass 1 applies on `5d25f20` (0.26.2 hydrate-order fix).
- Source lines (`packages/*/src`, `apps/*/src`): `35555`
- No `AGENTS.md` or `CLAUDE.md` in the repo; `CONTEXT.md` (201 lines) is the only agent-facing entry.

## Coverage

| Directory | Files | Mark (swept-before / unswept) | Pass |
| --------- | ----- | ----------------------------- | ---- |
| apps/blog/src | 15 | swept | 1 |
| apps/dashboard/src | 17 | swept | 1 |
| apps/notes/src | 16 | swept | 1 |
| packages/effect-frame/src | 2 | swept | 1 |
| packages/effect-frame/src/actor | 33 | swept | 1 |
| packages/effect-frame/src/actor/http | 4 | swept | 1 |
| packages/effect-frame/src/actor/testing | 2 | swept | 1 |
| packages/effect-frame/src/inspection | 3 | swept | 1 |
| packages/effect-frame/src/router | 28 | swept | 1 |
| packages/effect-frame/src/view | 15 | swept | 1 |
| packages/effect-frame/src/view/hosts | 5 | swept | 1 |
| packages/host-durable-object/src | 8 | swept | 1 |
| packages/inspect/src | 9 | swept | 1 |
| tooling/checks/src | 6 | swept | 1 |
| tooling/dom-bench/src | 7 | swept | 1 |
| tooling/dom-bench/src/fixtures | 3 | swept | 1 |

## Prior art

| Idea | Source (slug, path) | North star | Verdict (adopt / rejected: reason) |
| ---- | ------------------- | ---------- | ---------------------------------- |
| Closed tag set, void elements, typed events | foldkit `html/index.ts` | explicit, expressive | adopt as typed intrinsics per host (V3); reject one global attribute union |
| One naming rule for view helpers | foldkit `html` | explicit | adopt (V1) |
| Commands as values from `update` | foldkit `command/` | actor-model | rejected: Elm architecture, one app queue |
| ManagedResource keyed on the model | foldkit `managedResource/` | actor-model | rejected as is; adopt the lifecycle as `Source.switchMap` (A1) |
| AsyncData `Idle`, hand-written transitions | foldkit `asyncData/` | declarative | rejected |
| `Stale` keeps the value on a failed refresh | foldkit `asyncData/` | expressive | pass 2 (behaviour change, check wire) |
| Field validation `Rule` tuples | foldkit `fieldValidation/` | effect-native | rejected: a second validator beside Schema; adopt per-field issues through `Form.codec` in pass 2 |
| Devtools time travel/replay | foldkit `devTools/` | actor-model | rejected |
| Build id stamped on documents | foldkit `hydrate.ts` | explicit | owner: wire change (resume payload) |
| Bidirectional routes, transitions | foldkit `route/` | — | parity, nothing to take |
| AGENTS.md, skills, lint rules for consumers | foldkit repo | explicit | adopt (D3, G9) |

Full survey: `plans/pass1/foldkit.md`.

## Pass 1

Reports: `plans/pass1/<area>.md` (view, router, actor, edges, apps, docs, guards, foldkit) and `plans/pass1-agent-trial.md`.

Worktree: `~/Developer/personal/.worktrees/effect-frame-arch-pass1`, branch `arch-pass1-apply` (Rift cannot reflink on this filesystem).

Loop decisions on owner questions (the owner may reverse any; each names its north star):

- Router O1 flat route form: delete (explicit, one model).
- Router O2: `View.keyed(source, keyBy, row)`, a one-row keyed region (declarative; routes keep stayed views).
- Router O3 layout `<ChildR,>`: keep, document it.
- Router O4: a redirect constructor with no view (declarative).
- A7 placement names: `Actor.local`, `Actor.durable`, `Actor.remote`, `Actor.remoteCommands` (explicit; matches `ActorKind` and span names).
- A14: delete `Cell`; view state is `Actor.local(Behavior.value(x))` (actor-model).
- D6/A10: delete `useQuery`; views read `Route.query`, other code `followQuery` (explicit, one path).
- D4: a view is `(props) => Effect.gen(...)`; the JSDoc says so; EGW converts.
- View O1: a `Loading` with no registration shows its content. Receipt: M7 in `docs/design/route-checks.md:168` and the router workaround `router/branch.ts:1740-1765` (declarative).
- E3: the request body limit is an explicit option at each `HttpServer` call site (explicit).
- E12: a type-only `Frame.Snapshot` change with the same encoding is allowed.
- Deferred to the owner (wire): decoded event payloads (View O2), build id, Durable Object routing by body address (E6b).
- Kept: A16 read-ahead on a Source; A18 minted-ID provenance (actor-model correctness).
- Own pass (high risk): A12 slot state in one ref.

Apply groups (run one after the other in the worktree):

| Group | Candidates |
| ----- | ---------- |
| 1 guards | G1, G2, G3, G4, G11, G12, G13, G14, D10, D14 (doc paths), S17 |
| 2 source + view surface | A1, A2, V5, R1, P10, A3, V1, V2, V4, V7, V8, V9, J8, D9, View O1, View.keyed (Router O2) |
| 3 actor surface | A4, A5, E1, A6, A7, A8, A9, D6/A10, A13, A14, A15, A19 |
| 4 router | R2, R3/P11, R4+O1, R5, R6/P1/D8, R7, R8, R9, R10, R11, R12, R13, R14/P14, R15, O4, P13, V10 |
| 5 typed JSX | V3, V6 |
| 6 edges | E2, E3, E4, E5, E6a, E7, E8, E9, E10, E11, E12/A17, E13, E14, E15, A11, P2, P3, P4 |
| 7 docs + agent entry | D1, D2, D3, D4, D5, D7, D11, D12, D13, D15, G5, G9, G10 |
| 8 EGW | adopt every renamed/added API in `bible-tools/apps/egw-search` |

Pass 1 closed 2026-09-25. Groups 1-7 released as `effect-frame@0.27.0`
(breaking changes marked `minor`, as every 0.x release has). Group 8:
bible-tools `2179ef74` adopts 0.27.0 and `4008b04a` writes each EGW view as
`(props) => Effect.gen` (D4); its unit tests and browser suite pass. The owner
limited the loop to this one round; pass 2 starts from the candidates below.

Pass 2 candidates already known: one subscription per Source within a mount, so a list and a sibling binding of the same Source paint in one flush (today `tracker.track` runs one fiber per binding; CI caught `#open` ahead of its `For` row — f476010 made the tests settle on the whole state; owner decision, the design makes no such promise); compile or export-check JSDoc `@example` blocks and `.changeset/*.md` code (counsel C1); A12, P5/P6 (a conditional that hosts a view, remount on key), P15 (debounced input marks results stale), Foldkit `Stale` on failed refresh, per-field form issues.

More pass 2 candidates, found while applying pass 1:

- Module-level side-channel maps in `packages/effect-frame/src` (re-grepped after A11, which moved the query cache's into a Context service): `router/check.ts` `checkers`; `router/codec.ts` `searchKeyOrders`, `searchFieldDefinitions`, `searchKeyDefinitions`; `router/landing.ts` `shells`, `surfaces`; `router/leave-registry.ts` `askers`; `router/prerender.ts` `enumerations`, `plans`; `router/traversal.ts` `sources`; `router/receipt.ts` `registered`; `router/branch.ts` `segmentRuntimes`, `treesOf`, `runtimes`, `drivenTrees` (`drivenTrees.set` is still in branch.ts). `actor/command-id.ts` `minted` is A18, kept. Each is a WeakMap keyed by a value the caller holds; the explicit form carries the data on the value, as LazyView and DrivenView now do.
- `Portal.into` typed per host: `PortalProps<HostNode>` takes whatever node type the call infers; the host should fix it.
- `link` `aria-current` ignores params (defect D13-link above).
- A gate rule for inline citations: a backticked `Namespace.member` in a reference doc must resolve (runtime keys, then the declarations for type-only names). A one-off run on 2026-09-25 found none stale; `bun run docs` checks code blocks only.
- Flaky test: `packages/effect-frame/tests/view/streaming.test.tsx` "a placeholder always precedes its patch, and Closed lists every settle" failed once (5 patches seen, 4 expected).
- Flaky test: `packages/effect-frame/tests/router/prerender-build.test.tsx` "a crashed build leaves the previous tree serving, and leaves no staging behind" failed once in the gate (a staging directory left after the interrupt); six runs alone passed.


| ID  | Candidate | North star | Files | Lines removed | Risk | Status (`done <hash>` / `rejected: <receipt>`) |
| --- | --------- | ---------- | ----- | ------------- | ---- | ---------------------------------------------- |
| G1 | CI and release run the local gate | explicit | 6 | 46 | low | done c7fb6cf |
| G2 | one pinned Bun for CI and local | explicit | 3 | 2 | low | done 0cb5db3 |
| G3 | delete stale disable directives and exemptions | explicit | 49 | 90 | low | done 614c317 |
| G4 | default unicorn and oxc plugins back on | explicit | 15 | 20 | low | done dcec3cb |
| G11 | prove each published subpath against the build | explicit | 4 | 3 | low | done 3a43a9b |
| G12 | turbo typecheck inputs cover every compiled dir | explicit | 1 | 0 | low | done 05bf0f5 |
| G13 | dom-bench: client entry, dead check deleted | explicit | 6 | 27 | low | done 0e0ea15 c43f836 |
| G14 | boundary proved once; scaffold probe deleted | explicit | 13 | 119 | low | done e00c843 |
| D10/S17 | dead path citations point at moved files | explicit | 8 | 79 | none | done 0e2871c |
| D14 | refuse a doc citation of a missing path | explicit | 5 | 1 | none | done 15f36d2 |
| A1/R1/P10 | complete the Source toolkit; load replaces mapEffect | effect-native | 14 | 129 | low | done a496bf2 |
| V4 | multi-word event props fire (defect) | explicit | 3 | 1 | low | done 5bd87f9 |
| View O1 | a Loading with no registration shows its content | declarative | 12 | 129 | low | done 5b4c991 |
| V5 | one source-first signature for select/debounce/throttle | expressive | 13 | 67 | low | done 5e870eb |
| A2 | one path per Source combinator | explicit | 27 | 132 | low | done eee0604 |
| A3/V8 | one owner for QueryState; view copy deleted | explicit | 13 | 187 | low-med | done 9950cbf |
| V2/D9 | one path per view export; ViewTest on its subpath | explicit | 39 | 87 | low | done 865f393 |
| V9 | node model types stay inside the package | explicit | 4 | 20 | low | done 2a9ecbf |
| V1/J8 | one kind rule for view exports; Await tag | explicit | 79 | 711 | med | done 5fba240 |
| V7 | refuse a value name two subpaths export | explicit | 9 | 13 | low | done 90368a2 |
| Router O2 | View.keyed, a one-row keyed region | declarative | 7 | 28 | low | done 1f3eafb |
| A4 | delete dead and duplicate actor exports | explicit | 10 | 33 | low | done 5abcc5a |
| A15 | comments in the present tense | explicit | 26 | 67 | none | done 8cf00f1 |
| A13 | resolve each policy name once | explicit | 3 | 93 | low | done ecfef7f |
| A19 | ActorHost requires a store | explicit | 28 | 80 | low | done 2dc0c06 |
| A9 | query declares version and depends | explicit | 35 | 12 | low | done de8c041 |
| A8 | one shape for the server half | explicit | 68 | 609 | low | done b3fa068 |
| D6/A10 | delete useQuery; QueryCache.layer | explicit | 46 | 250 | none | done 7221d25 |
| A14 | delete Cell; view state is a local value actor | actor-model | 10 | 85 | low | done 3246027 |
| A7 | placement under an Actor namespace | explicit | 89 | 426 | low | done 85e3518 52ad990 |
| A6 | a remote reference carries its address | actor-model | 16 | 65 | low | done 0fa9509 |
| A5/E1 | one form decode; View.form proves its member can post | explicit | 5 | 30 | low | done b897620; partial: decode shared via Form.decode; a whole-contract Codable constraint rejected, it would refuse a script-only member |
| D7 | form.ts doc matches the member constraint | explicit | 5 | 30 | none | done b897620 |
| R15 | router comments in the present tense, on their declarations | explicit | 11 | 34 | none | done 9e70e9d |
| R4+O1 | delete the flat route form | explicit | 31 | 697 | low | done 4e766f9 |
| O4/R13 | Route.redirect takes its destination; Route.redirecting | declarative | 17 | 84 | low | done d4c6651 |
| R9 | the navigation option is landing | explicit | 10 | 28 | low | done 8ccecb8 |
| R6/P1/D8 | hydrate owns the page load; apps call it | declarative | 20 | 140 | low | done 0b64f8d |
| R10 | mount names landing and traversal read limit | explicit | 41 | 141 | low | done 91bd13a |
| R11 | a route is branded with its mode; names checked | explicit | 20 | 167 | med | done d46866c 8fe53eb |
| R12 | one export path for route types | explicit | 22 | 81 | low | done fb695a0 |
| R2 | actor binding is { ref, state } | declarative | 14 | 27 | med | done c3d9917 |
| R3/P11 | Route.commandRef, a send-only declaration | actor-model | 12 | 160 | med | done f4164cd |
| R5 | params follow the template; children inherit | explicit | 25 | 133 | med | done 6b32f4c |
| R14/P14 | push and replace for every move | explicit | 37 | 271 | med | done 7908e9b |
| P13 | link follows a params Source | declarative | 7 | 16 | low | done 4e5c9fb |
| R8 | Link and followLinks share one click policy | explicit | 4 | 33 | low | done 3081ad0 |
| V10 | View.lazy returns a tagged LazyView; DrivenView tagged | explicit | 10 | 44 | med | done e57471d b785156 |
| R7 | mount has two owners | explicit | - | - | low | skipped: no clash after View.mount (V1) |
| V3 | typed intrinsic JSX per host, named errors | explicit | 27 | 181 | med | done 61f807d fa52a41 |
| V6 | refuse an open readiness scope at the mode constructor | explicit | 21 | 102 | med | done 3ced983 |
| E14 | session buffer private to shareSessions | explicit | 4 | 17 | none | done 45b131b |
| E5/E15 | proof actor into its fixture; store factory deleted | explicit | 9 | 35 | low | done bfc43c9 |
| E7 | frame-host reads the wake through MailboxStore | explicit | 1 | 24 | low | done 6dbc503 |
| E6a | an object refuses a request naming another address | explicit | 3 | 1 | low | done eb22ef4 |
| E2/E3/P4 | one actor handler under a prefix; body limit, principal, page answer | explicit | 40 | 585 | med | done 30a2261 |
| P3 | one page answer (respondDocument) | declarative | 40 | 585 | med | done 30a2261; partial: respondDocument shared; apps not moved to HttpRouter/BunHttpServer; Bun.build not deduplicated |
| E9 | HTTP transport reads through HttpClient | effect-native | 25 | 192 | med-high | done b5a889a |
| E4 | delete QueryTest, layerTest, layerLocal | explicit | 44 | 314 | low | done b4bdbea |
| E8/E13 | attach status is a Stream; retry a Schedule; limits required | effect-native | 50 | 756 | low | done e7f503a 30a2261 |
| E10 | one owner for the deadline bound and loopback hosts | explicit | 10 | 101 | low | done d03dbe0 |
| E11 | one argv reader in inspect | explicit | 10 | 101 | low | done d03dbe0; partial: effect/unstable/cli adoption left as an owner check |
| E12/A17 | internal records use the snapshot schemas | explicit | 13 | 90 | low | done 7925794; partial (A17): bounded internal records kept |
| A11 | QueryCache internals are a Context service | effect-native | 10 | 138 | med | done 6f61bf2 |
| P2 | the document names its root once; Dom.root | explicit | 26 | 108 | low | done 0277d0c; Browser.layer rejected: it hides composition |
| X1 | Loading with no registration, in every comment | explicit | 6 | 21 | none | done 9899813 |
| G5 | refuse a value a reader can import by two paths | explicit | 9 | 25 | breaking | done 6beeebd |
| D4 | a view is an arrow that returns Effect.gen | explicit | 3 | 10 | none | done b7b1200 |
| D5 | JSDoc matches the code (J2, J3, J6, J7, J8) | explicit | 12 | 35 | none | done b7b1200 6beeebd |
| D2/D12/D15 | glossary: each term once, with its code | explicit | 7 | 33 | none | done 14c7108 |
| D11 | notes README queries; inspect README block compiled | explicit | 12 | 872 | none | done 898fd70 ed1e0ef |
| G9 | frame lint plugin: no-switch, disable-reason, span-name | explicit | 29 | 213 | low | done 9b6fd6d b9626a8 |
| G10 | docs cannot contradict code: glossary rule, compiled blocks | explicit | 18 | 878 | med | done 14c7108 ed1e0ef |
| D13 | compiled, tested examples; docs rule refuses drift | explicit | 40 | 854 | none | done 301d7f6 ed1e0ef |
| D1/D3 | root README landing; package README agent entry; AGENTS.md | explicit | 39 | 845 | none | done ed1e0ef ed7690c |
| X2 | fill this ledger from `git log 54e6c43..HEAD` | explicit | 1 | 0 | none | done (the commit that adds this table) |
| A12 | QueryCache slot state in one ref | effect-native | - | - | high | skipped: its own pass (subtle ordering); listed under pass 2 |
| A16 | read-ahead capability on a Source | actor-model | - | - | low | rejected: kept by loop decision (actor-model correctness) |
| A18 | minted-ID provenance through a WeakSet | actor-model | - | - | n/a | rejected: kept by loop decision (actor-model correctness); `actor/command-id.ts` `minted` |
| E6b | route the Durable Object by body address | explicit | - | - | med | skipped: deferred to the owner (wire); E6a guards it meanwhile |
| View O2 | decoded per-event payloads | explicit | - | - | med | skipped: deferred to the owner (widens `Remote.RemoteEvent`, a wire format) |

Counsel defects:

| ID  | Defect | Red test | Status |
| --- | ------ | -------- | ------ |
| V4 | `onKeyDown` listened for `keyDown` and never fired | `packages/effect-frame/tests/view/dom.test.tsx` | done 5bd87f9 |
| V3-select | a `select`'s change event carried an empty value | `packages/effect-frame/tests/view/dom.test.tsx` | done fa52a41 |
| E6a | a Durable Object served a request naming another address | `packages/host-durable-object/tests/frame-host.test.ts` | done eb22ef4 |
| C1 (counsel major) | JSDoc examples and changesets named removed APIs (`NoParams` as a value, `updateSearch`, `spawn`, `Query.batched`, `QueryTest`, `layerTest`, an incomplete `hydrate`, flat-route wording); counsel `/tmp/counsel/worktrees-effect-frame-arch-pass1-02279afb/20260925-125406-claude-to-codex-dfd7f9/codex.md`, verdict no blocker | none: docs are not compiled; the structural guard (JSDoc `@example` and changeset blocks checked against exports) is a pass 2 candidate | done (this commit) |
| D13-link | `link` computes `aria-current` per segment and ignores params: on `/counters/home`, the `/counters/work` link also carries `aria-current="page"` (`router/link.tsx` `to.currentAt(match)`; the notes lists nav too) | `packages/effect-frame/tests/router/route-public.test.tsx` "4. a link is the page only when its own params print the current path; search does not count"; `packages/effect-frame/tests/examples/counter.test.tsx` "draws a counter page on the server, with the names beside it" | done e8da6b0 |

Live check: `<pending>`

## Pass 2

Owner request (2026-09-25): one more pass. Seed it with the JSX friction found
while moving EGW Search to 0.27.0, and evaluate TSRX (https://tsrx.dev/) as a
template syntax against JSX.

- Baseline: HEAD `d272bd7` (effect-frame 0.27.0 plus the pass 1 ledger), source lines `36778`.
- Worktree: `~/Developer/personal/.worktrees/effect-frame-arch-pass2`, branch `arch-pass2`.
- Coverage: the same 16 directories as pass 1, all swept-before; none unswept.
- Reports: `plans/pass2/<area>.md`.

Seed findings (receipts: bible-tools `2179ef74`, `4008b04a`):

| ID | Friction | Receipt |
| -- | -------- | ------- |
| F1 | `View.bind(source, project)` and `View.event(() => …)` at every live prop and handler; `Source.select` inside props | `bible-tools/apps/egw-search/src/app.tsx` |
| F2 | A local actor's `send` fails with `ActorStopped`, but a `Handler` has no error channel: each write needs a catch (EGW's `whileMounted`) | `app.tsx` `whileMounted` |
| F3 | `Show`/`For` render functions nest deeply (`Reference` is `Show` in `Show`) | `app.tsx` `Reference`, `HitRow` |
| F4 | A view is `(props) => Effect.gen(function* () { … })`; a zero-argument exported view trips `lazyEffect`, so a page with no props must type props it ignores | `app.tsx` `SearchPage`, `src/segments.ts` |
| F5 | A `.tsx` file the server imports from the repo root names `@jsxImportSource effect-frame/view` itself | `app.tsx:1`, `routes.tsx:1` |
| T1 | TSRX: `@{}` components, `@if`/`@for` blocks, locals beside markup, scoped `<style>`, target plugins | `okra repo path tsrx-org/tsrx` |

Pass 1 carry-over: see "Pass 2 candidates already known" and "More pass 2 candidates" above.

Reports: `plans/pass2/{view,actor,router,apps,edges,guards,docs,tsrx}.md`. Candidate IDs are the reports' own (W*, P2-A*, router batches A–F and R-Q4, AP*, E2-*, P2-G*, docs findings 1–15).

Loop decisions on owner questions (the owner may reverse any; each names its north star):

- T1 TSRX: stay on JSX (tsrx.md option b). TS7 `tsc`, the Effect language service, oxlint and oxfmt do not see `.tsrx`; `@if` cannot bind a narrowed source. Take its ideas as API: a flat union `Match` (documented pattern, no new name), and a `For` fallback. No scoped CSS: it cannot work in the terminal host. Revisit a template language only when TSRX runs on TS7 and oxc.
- F2: premise corrected — a local `send` never fails; `derive`/`modify` do. P2-A1: they return a handle and never fail (actor-model: one send shape). Export `LocalValueRef<A>` (P2-A2).
- F4 / W5: keep D4, no `View.make` (one form). Doc: a view names the props it is given; a leaf types them `Route.PropsOf<typeof segment>` (explicit).
- F5: app config (apps.md §2). Doc sentence; EGW runs its server from the app directory (AP12).
- W3 one subscription per Source: hold. W2 explains the reproduced tick; re-open only with a receipt W2 does not explain.
- W6 Portal: a `PortalTarget` only a host makes; the HTML and Remote hosts make none, so a Portal fails loudly there (explicit). Server placement of portal children waits for a caller.
- Actor O1 (Foldkit `Stale`): (i) `Failed { error, last: Option<A> }` — a failed refresh keeps the value; one state at a time holds (expressive, declarative).
- Router O1: `push`/`replace` return the `NavigationResult`; the test-only `registered` map goes (explicit, deletion).
- Apps O1 (AP10): a JSX tag is a framework tag; a sync helper is called as a function (explicit, closed tag set).
- Apps O2 (AP11): document the one client composition; inspection registration stays optional and is named in the docs (hold the required-input change).
- Apps O3: keep one transport tap per example (explicit about what each proves).
- Apps O4 / `FollowedQuery.override`: keep, marked stale (unchanged).
- E2-1: adopt. The handlers speak `HttpServerRequest` → `HttpServerResponse`; `effect` supplies `HttpRouter` and `toWebHandler`. The package already depends on `effect/unstable/http` (`HttpTransport`). E2-6 falls away.
- E2-3: rejected (wire change).
- Docs 2: `Source.zip(a, b)` gives a tuple as Effect's `zip` does; the combining form is `Source.zipWith(a, b, f)` (consistency with Effect).
- Docs 3: `pushSearch`/`replaceSearch` take a value or an updater, as `UrlState` does (one change shape).
- AP4 / docs 7 (`FollowedActor.send`): rejected — pass 1 (c3d9917) decided a send names the reference.
- P2-A6 (A12): its own pass, after a model-based test; not in pass 2.
- P2-G9 (the wait is the expectation): hold until W2 lands; re-open if a test still settles on one binding.
- Batch E key inference (06804f1): keep the one written rule — a plain fixed-key struct codec names its own search keys (`inferredSearchKeys`, `SegmentOptions.search`). It is stated, not silent, and 30 segments pass `Schema.Struct({})`; an annotated `Route.search` never takes it (explicit: the rule is written where the option is).

Apply groups (one after the other in the worktree):

| Group | Candidates |
| ----- | ---------- |
| 1 defects | W2, W7, R-Q4 |
| 2 view | W1, W4, W6, `For` fallback, F3 union-`Match` doc, F4 doc |
| 3 actor | P2-A1, P2-A2, P2-A3, P2-A4, P2-A5, Actor O1 (i), stale JSDoc (`Actor.spawn`, `Behavior.refuse`, `Behavior.wakeAt`) |
| 4 router | batches A–F (spread-route and annotated-search defects with red tests), Router O1, acceptance row 122, P2-G5 `frame/no-module-state` |
| 5 edges | E2-1, E2-2, E2-4, E2-5, AP5, AP6 |
| 6 docs + apps | docs findings 1–15 (with Docs 2, Docs 3), AP2, AP3, AP7, AP8, AP10, AP11, F5 doc |
| 7 guards | P2-G1, P2-G2, P2-G3, P2-G4, P2-G6, P2-G7, P2-G8 |
| 8 EGW | adopt the release in bible-tools `apps/egw-search` (AP12, delete `whileMounted` and `segments.ts` if unneeded, `View.event(effect)`, union `Match`) |

Pass 2 rows:

| ID   | Candidate                                                                          | North star     | Files                                                                                                 | Lines removed | Risk    | Status        |
| ---- | ---------------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------- | ------------- | ------- | ------------- |
| W2   | `Bound` keeps its projection; a projected row bind paints in its list's flush      | declarative    | `view/view.ts`, `view/runtime.ts`, `tests/view/projected-bind.test.tsx`, README, changeset (minor)    | 9 (+25 src)   | low-med | done 0cb0e0a  |
| W7   | Streaming proofs wait on chunks, not sleeps (record order, early patch, nested, ended early) | explicit       | `tests/view/streaming.test.tsx`                                                                       | 19 (+39 test) | low     | done 1395218  |
| R-Q4 | A prerender page's writes (and the client and manifest writes) run uninterruptibly | effect-native  | `router/prerender.server.ts`, `router/prerender-output.server.ts`, `tests/router/prerender-build.test.tsx`, changeset (patch) | 9 (+16 src)   | low     | done c51f860  |
| W1   | `View.event`/`View.submit` take the Effect of a handler that reads no event; 48 `() =>` sites migrated (kept: 6 dom-bench `applyOperation` thunks that read mutable `state`, one eager `sendText` that mints a command id, the failing-handler fixture, `docs/design/`) | expressive | `view/view.ts`, `tests/view/{types,dom}.test.tsx`, apps, examples, tests, README, CONTEXT, changeset (minor) | 70 (+181) | low | done 91c83f6 |
| W4   | `View.show`, `View.match`: a branch whose setup runs only while shown, built on `View.keyed`; `match` reads each case's services (overloaded, since `R` does not infer through a mapped table); dashboard funnel uses `View.show` | declarative, explicit | `view/control.ts`, `view/namespace.ts`, `tests/view/effect-branches.test.tsx`, `apps/dashboard/src/overview.tsx`, README, CONTEXT, changeset (minor) | 16 (+343) | low | done bbb277f |
| W6   | `Portal.into` takes a host-made `PortalTarget` (`Dom.target`, OpenTUI `target`); a host resolves only its own targets through `Host.portal`; HTML and Remote refuse with `View.PortalTargetRefused` naming both hosts | explicit | `view/portal-target.ts`, `view/host.ts`, `view/runtime.ts`, `view/hosts/*`, `tests/view/portal-target.test.tsx`, README, CONTEXT, changeset (minor) | 21 (+292) | med | done dc9f354 |
| For fallback | `<For fallback>` draws while the list is empty (a `Show` over `each` beside the rows in the runtime) | declarative | `view/control.ts`, `view/jsx-runtime.ts`, `view/runtime.ts`, `tests/view/dom.test.tsx`, README, changeset (minor) | 3 (+60) | low | done 52e30dd |
| F3 doc | README "One branch per case": a flat union `<Match>` over one `Source.select`, as a compiled region with a test | expressive | `examples/features/branches.tsx`, `tests/examples/branches.test.tsx`, README | 0 (+131) | low | done 2a3d790 |
| F4 doc | README rules and CONTEXT "View": a view names the props it is given; a leaf types them `Route.PropsOf<typeof segment>`; `lazyEffect` refuses a zero-parameter exported view | explicit | README, CONTEXT | 1 (+6) | low | done 8c10868 |
| Docs 9 | README `<Show>` rows name `fallback` and the narrowing `is` form | declarative | README | 1 (+2) | low | done 6551e38 |
| P2-A1 | A local `derive` and `modify` return a handle like `send` and never fail (`send` is `derive(() => m)`); `call` keeps failing because it asks for the reply, which a stopped actor does not have. 4 `ActorStopped` catches deleted (dom ×3, listener-ownership), 2 `call`+catch pairs read `.settled` (url-state, dom-bench); the changeset corrects the 0.27.0 `send` note; README handler row | actor-model, explicit | `actor/actor.ts`, `tests/actor/local.test.ts`, `tests/view/{dom,listener-ownership,testing}.test.tsx`, `tests/router/url-state.test.tsx`, `tooling/dom-bench`, README, changeset (minor) | 58 (+78) | low | done c6d3d11 |
| P2-A2 | Export `LocalValueRef<A, Refusal>`; `modify` typed with it; notes' `DraftRef` and 7 test spellings replaced | expressive | `actor/actor.ts`, `actor/client.ts`, `apps/notes/src/commands.ts`, 5 tests, CONTEXT, changeset (minor) | 24 (+31) | none | done 7308437 |
| P2-A3 | `View.form` `issues` is a `Source` held by a local value actor; a scripted submit that does not decode shows `Form.issuesOf` of the failure, the issues a plain post shows; a decoded submit clears them; a body that cannot nest still logs (plain post answers 400). `aria-invalid` stays server-drawn | explicit, declarative | `view/form.ts`, `tests/view/plain-form.test.tsx`, `tests/plain-form-fixture.tsx`, examples, notes, README, changeset (minor) | 32 (+123) | low-med | done 258a812 |
| P2-A4 | `Form`, `Generated`, `Streaming` re-export curated modules; `Wire` and `canonicalize` leave the client entry; view, router and tests import plumbing by path. Deletion test (`rg "NS.member"` outside `src/actor`): 28 values with no user or test, 13 framework-only; `declarations` and `boundary` green | explicit | `actor/{client,form-api,generated-api,streaming-api}.ts`, `view/form.ts`, `view/hosts/{dom,html}.ts`, `router/{branch,hydrate}.ts`, 6 tests, README, changeset (minor) | 29 (+134); 41 public values | med | done 8b0c3b3 |
| P2-A5 | One form decoder: `Form.decode` on `Form.codec` | explicit | — | 0 | — | skipped: through `codec`, a body that cannot nest fails as `SchemaError(Encoding(Encoding(InvalidValue)))`, so form-post's 400-vs-issues split would need a hand-written walk of the issue tree (effect-native, explicit); `decode` and `codec` already share `tree`. Also `codec` needs `Codable<S>`, which the post route's untyped contract cannot give |
| Actor O1 | A failed refresh keeps the held value: `QueryState.Failed { error, last: Option<A> }` (none after `Unauthorized`); decoder, `Source.load`, fake query and `<Await failed>` carry it; `View.errored` still trips; the pinned query test now asserts the kept value. No wire change: `QueryState` is never encoded (the record encodes a Value/Error outcome) | expressive, declarative | `actor/{query,query-client,source,streaming}.ts`, `view/{readiness.tsx,testing.ts}`, 5 tests, CONTEXT, README, changeset (minor) | 83 (+183; 55 of each is a reindent in `query.test.ts`) | low-med | done 47dc02d |
| Stale JSDoc | `Actor.spawn` → `Actor.local`; `Behavior.refuse` / `Behavior.wakeAt` → the behavior's `refuse` / `wakeAt` field (12 sites, incl. host-durable-object) | explicit | `actor/{behavior,vocabulary,local-engine,mailbox-store,durable-engine}.ts`, `host-durable-object/src/{frame-host,storage-store}.ts`, fixture contract | 12 (+12) | none | done c4921f9 |
| Batch A | `Entered` carries `shell` and `questions`; the `shells` and `askers` maps and the router's invented shell for a route it did not build go. The bundle proof runs the bundle (`renderHtml`) instead of grepping `registerShell` | explicit | `router/{codec,landing,leave-registry,branch,router}.ts`, `tests/router/navigation-behavior.test.tsx`, `tests/router/fixtures/server-entry.tsx`, changeset (minor) | 74 (+34 src) | low | done 9ef269a |
| Batch B | A route carries its checks (`RouteChecks`), a prerender tree its plan, a driven tree its resolver, `Route.inputs` its enumeration; `mountTree` takes the checks, so `redirecting` writes once. Red first: a spread of a guarded route mounted unguarded | explicit | `router/{check,codec,branch,prerender,router}.ts`, `tests/router/route-check-edges.test.tsx`, changeset (minor) | 106 (+122 src) | low-med | done 90ec90d |
| Batch C | `LocationService` holds optional capabilities (surface, traversals) under a non-public symbol; a spread keeps them. `surfaces` and `sources` go; app Locations unchanged | explicit | `router/{landing,traversal,navigation,browser-commit,router}.ts`, 3 tests, changeset (minor) | 35 (+63 src) | med | done 95b9a45 |
| Batch D | Segment and branch brands hold their runtimes; `segmentRuntimes` and `runtimes` go with two unreachable dies. `declarations` green | explicit | `router/branch.ts`, changeset (minor) | 76 (+53 src) | med | done 4f002a6 |
| Batch E | One `SearchFields` Schema annotation replaces three maps; `.annotate()` keeps it. Red first: an annotated `Route.search` lost its keys (segment and `UrlState`). Kept, and named on `SegmentOptions.search`: a fixed-key struct codec names its keys, because 30 segments pass `Schema.Struct({})`; removing it would break them (not minor) | effect-native, explicit | `router/{codec,branch}.ts`, `tests/router/url-state.test.tsx`, changeset (patch) | 39 (+58 src) | low | done 06804f1 (struct rule kept) |
| Batch F | `RouteMatch` and the route carry `segments`; `currentAt` reads the match; `treesOf` goes. Red first: an unmounted tree with the matched tree's name made its segment current | explicit | `router/{codec,branch,router}.ts`, `tests/router/route-public.test.tsx`, changeset (minor) | 25 (+22 src) | med | done 2477fdc |
| Router O1 | `push`/`replace` (and `RouteNavigation`) answer `NavigationResult`, exported from `effect-frame/router`; `Receipts`, `Receipt.of` and `registered` go; 4 test files and 2 browser fixtures read the result; a push to a closed router is interrupted (it reaches no result) | explicit, expressive | `router/{receipt,router,codec,index}.ts`, 6 tests, README, changeset (minor) | 48 (+29 src) | low | done 5da306a |
| R-doc1 | Acceptance row 122 and its test title stop claiming a replace default | explicit | `docs/design/acceptance.md`, `tests/router/url-state.test.tsx` | 2 (+2) | none | done b6b7992 |
| P2-G5 | `frame/no-module-state`: in `packages/*/src`, no top-level `let` and no top-level `Map`/`Set`/`WeakMap`/`WeakSet` unless an array literal fills it; `command-id.ts` `minted` (A18) keeps a reasoned disable. AGENTS code rule | explicit, actor-model | `tooling/checks/src/lint-plugin.ts`, `tooling/checks/tests/lint-plugin.test.ts`, `.oxlintrc.json`, `actor/command-id.ts`, AGENTS | 0 (+128) | low | done 1319c16 |
| E2-1 | The server edge speaks `HttpServerRequest` → `HttpServerResponse`; `HttpServer.layer` mounts on an `HttpRouter`; `respondDocument` reads the request in context; `Prerender.serve` wraps an app. `WebHandler`, `Prerender.WebHandler` and `HttpTest.Handler` go (E2-6 falls away); the DO host uses `HttpEffect.toWebHandlerWith` | effect-native | `actor/http/{body,server,form-post}.ts`, `actor/testing/http.ts`, `router/{document,prerender.server}.ts`, `host-durable-object/src/frame-host.ts`, examples, 20 tests, README, changeset (minor) | 466 (+790) | med | done 7b78fe3 |
| AP5 | Notes, dashboard and blog each export one scoped `serve` over the transport in context: `HttpServer.layer`, the bundle and the page on one `HttpRouter`, stopped by the Scope. `makeServer`, `ManagedRuntime`, `stamped` over a web `Request`, and the three `.oxlintrc` app-server overrides go; env through `Config`. Kept: `Bun.serve` (`BunHttpServer`'s graceful stop hangs on open SSE) and the in-process client build (turbo's test task does not build) | effect-native | `apps/{notes,dashboard,blog}/src/server.ts`, 8 app tests, `.oxlintrc.json` | 320 (+252) | med | done 9b7cc5f |
| E2-2 + AP6 | One redraw: `renderDocument` writes the `FormContext` issues after the tail; `redrawDocument(render)` is the form route's `render` (fails `DocumentRedirected` on a redirect); `FormRoute.render` takes a URL at the posting request's origin. Three `drawAgain`/`PageRedirected` copies and their `.invalid` origins go. Red first: the redraw test and the revocation origin assertion | explicit, declarative | `router/{document,index}.ts`, `actor/http/{form-post,server}.ts`, `examples/counter/page.server.ts`, `apps/{notes,blog}/src/server.ts`, 4 tests, README, changeset (minor) | 171 (+308) | low-med | done 0a6eaae |
| E2-4 | `@effect-frame/test-browser`: `requireBrowser(engine, suites)` throws under `CI` when this platform can run the engine and lacks it, else logs one line naming the skipped suites. Every harness calls it; the notes CI copy and three Chrome lookups go. The inspection proofs now run here with Chrome | explicit | `tooling/browser/*`, `packages/inspect/tests/{harness,transport,protocol}.ts`, `packages/effect-frame/tests/{router/browser/harness,4 browser tests}`, `apps/{notes,blog}/tests`, `docs/toolchain.md` | 97 (+247) | low | done 0426e16 |
| E2-5 | `Reader.run(argv, { token: Option<string>, interrupt: Effect<InterruptSignal> })`, the fields `Cli.Io` carries, so the CLI passes `io`. `bin.ts` forks one `Effect.callback` over `process.on` at start; the token file is read with `Bun.file` at the reader boundary. `readFile`, `signalOf`, `untilInterrupted` and the Option spread go. Red first: an interrupt ends a stalled read with 143 | effect-native, explicit | `inspect/src/{bin,cli,reader,signals}.ts`, `inspect/tests/{harness,reader.test}.ts` | 64 (+91) | low | done 1af6e76 |
| E2-3 | Wire change | — | — | 0 | — | rejected |
| Docs 2 | `Source.zip(a, b)` gives the pair; the combining form is `Source.zipWith(a, b, f)`; callers moved; README "Sources" table | expressive | `actor/source.ts`, `router/link.tsx`, apps, 2 tests, README, changeset (minor) | 17 (+77) | low | done 0925399 |
| Docs 3 | `pushSearch`/`replaceSearch` take a value or an updater (`SearchChange`, `searchAfter`); `LinkSearch` and the url-state mutation machinery go | expressive | `router/{codec,route,branch,link.tsx,url-state-runtime}.ts`, `tests/router/router.test.tsx`, README, changeset (minor) | 64 (+64) | low | done 52b4f3e |
| AP3 | `memoryLocation(href)`: a `Location` in memory with `current`, `history` and `pop`; 18 router tests, view testing, fixtures and the 3 apps' fixtures use it (kept: `navigation-landing`, `route-leave`) | explicit | `router/memory-location.ts`, `router/index.ts`, 22 tests and fixtures, README, changeset (minor) | 631 (+305) | low | done b87236d |
| Docs 1, 3, 6, 10–15, F5 | README "View state" (local state, state in the URL), a query that reads an actor, links that ship, binding wording, `commandRef` named, Durable Object host, toolchain guidance names the skill, app config read through `Config` from the app directory; 4 redundant `Effect.scoped` | explicit | `examples/features/view-state.tsx`, `tests/examples/view-state.test.tsx`, `examples/actors/authorization.server.ts`, apps' `queries.server.ts`, README, CONTEXT, `docs/toolchain.md` | 41 (+372) | none | done b5c13ba |
| AP8 | `View.errored`'s fallback reads `Source<Option<QueryFailure>>`; `orErrored` bounds its error by `QueryFailure`; the apps' `describe` drop the Predicate (unrouted reads keep no `orErrored`: adding one changes behavior) | explicit | `view/readiness.tsx`, 3 tests, 3 apps' `views.tsx`, README, changeset (minor) | 73 (+85) | low | done 73daa4c |
| AP7 | `Policy.forSubjects({ contracts, queries }, check)`: one rule over typed keys, matched by name and version, decoded with the contract's `key` or the query's `args`; notes, dashboard and the authorization example use it | explicit | `actor/policy.ts`, `actor/index.ts`, `tests/actor/policy.test.ts`, apps' policies, example, README, changeset (minor) | 97 (+191) | low | done dfb8891 |
| AP10 / Docs 8 | One rule: a PascalCase tag is a framework tag (`For`, `Show`, `Match`, `Portal`, `Await`, `Link`), a sync helper is called as a function, a view body is `Effect.gen` or an arrow over one Effect; `segments.ts` holds a multi-file app's segments | explicit | README, CONTEXT, `view/view.ts` JSDoc | 8 (+16) | none | done 8fb44bf |
| AP11 | One client composition, `Layer.mergeAll(transport, QueryCache.layer, Location)`, in the README, the `QueryCache.layer` JSDoc and the 3 apps; inspection registration is optional and named: provide `Frame.layer` into the cache | explicit | `actor/query-client.ts`, `examples/counter/client.tsx`, `examples/features/inspection.ts`, 3 apps' `client.tsx`, README | 52 (+66) | none | done 9b8c4d7 |
| AP2 | Apps key a route region by `ref.key` (2 `Opened` deleted); `NotesKey.list` is `ListName`, which moves to `contract.ts`; 2 `keyBy` annotations dropped (the rest were gone); `actorPrefix` has one owner per app in `document.ts` | explicit | blog, notes, dashboard `src` and notes tests | 72 (+70) | low | done 28b6db0 |
| Docs 4, 5, 9 | — | — | — | — | — | done earlier 8c10868, c6d3d11, 6551e38 |
| Docs 7 | `FollowedActor.send` | — | — | 0 | — | rejected (AP4) |
| P2-G4 | The gate checks the Bun version first: `bun run toolchain` (`pinnedMismatch`) names both versions and the binary that ran; the toolchain test asserts the gate starts with it | explicit | `tooling/checks/src/{toolchain,toolchain-cli}.ts`, `tests/toolchain.test.ts`, `package.json`, AGENTS, `docs/toolchain.md` | 13 (+79) | none | done d5331ac |
| P2-G3 | No accidental 1.0: `bun run docs` refuses a `major` changeset on a 0.x package (at its line) and a published package at 1.0 or above, until `firstMajor` is set; names the 5 files at `d82afa8^`; 0 today | explicit | `tooling/checks/src/{changesets,docs-cli}.ts`, `tests/changesets.test.ts`, AGENTS, `docs/toolchain.md` | 14 (+231) | none | done 89f2fd0 |
| P2-G6 | App and example code holds state only in actors: `no-restricted-imports` refuses the Effect `Ref` family (flat and subpath) in `apps/*/src` and `examples`, server files included; the override repeats the server-module pattern. 0 fixes. A config test lints fixtures at their paths (JSON output: the default format differs off a TTY) | actor-model | `.oxlintrc.json`, `tests/lint-config.test.ts`, AGENTS, `docs/toolchain.md` | 1 (+200) | none | done 350ae28 |
| P2-G7 | `frame/explicit-ignore`: `Effect.ignore`/`ignoreCause`, called or bare in `pipe`, name `log`. 10 sites: 7 prerender cleanups and 2 inspect removals log `Warn` naming what was not removed; the lazy import passes `{ log: false }` (its failure reaches every waiter) | explicit, effect-native | `lint-plugin.ts`, its test, `.oxlintrc.json`, `router/prerender-output.server.ts`, `view/lazy.ts`, `inspect/src/capabilities.ts`, AGENTS, `docs/toolchain.md`, changeset (patch) | 10 (+149) | low | done a71b92e |
| P2-G8 | A commit carries its type (lefthook `commit-msg` runs `commit-message.ts`; git's merge/revert/fixup subjects pass) and a PR that changes `effect-frame` carries a changeset (CI `changeset status --since=origin/main`, full clone, Version PR exempt; `changedFilePatterns` `src/**`, `package.json`, so test-only changes need none). Proved locally in a scratch clone | explicit | `tooling/checks/src/{commit-message,commit-message-cli}.ts`, its test, `lefthook.yml`, `.github/workflows/ci.yml`, `.changeset/config.json`, AGENTS, `docs/toolchain.md` | 4 (+159) | low | done 800da11 |
| P2-G2 | An `@example` fence in JSDoc is a compiled region: ` * @example path#region`, written by `docs --fix`. 15 blocks moved to `examples/reference/`; 5 had drifted (`Actor.remote` key, `Generated.send` input, `implementTransparent` behavior, `isSignedIn` call) and the internal `Form` decode example went | explicit | `tooling/checks/src/{examples,docs-cli}.ts`, `tests/examples.test.ts`, `examples/reference/{actor.ts,host.server.ts,routes.tsx}`, 10 `src` files, AGENTS, `docs/toolchain.md`, changeset (patch) | 118 (+464) | low | done 4dce3a4 |
| P2-G1 | Every `Head.member` citation resolves (build lane): runtime members (`in`), namespace type exports, interface and service-tag fields, Effect's same-named module, subpath aliases; changesets also refuse an unknown head unless foreign or in `<!-- removed: … -->`. 3 removal notices marked. Catches `Query.batched` and `QueryCache.layerTest` at `ab6b660^`, `Actor.spawn` at `c4921f9^`. Limit: an interface field counts, so `Behavior.refuse` resolves as the `Behavior` interface's field | explicit | `tooling/checks/src/{citations,citation-facts,declarations-cli}.ts`, `tests/citations.test.ts`, `.changeset/http-server-request-response.md`, AGENTS, `docs/toolchain.md` | 2 (+728) | low-med | done b374a8e |
| B1 | A Portal a branch reveals after mount no longer throws inside Solid's flush (which halted reactivity process-wide): `resolvePortal` returns an `Option`, `planPortal` reports `PortalTargetRefused` through `tracker.refuse`; the first build fails the mount with it, a later one closes the mount scope with `Exit.die`. `src` holds no `throw` | effect-native | `packages/effect-frame/src/view/runtime.ts`, `tests/view/portal-target.test.tsx`, a changeset | 0 | medium | counsel round 1: accepted, fixed 66ca7a9 |
| M1 | `changedFilePatterns` also counts `README.md`, `tsdown.config.ts`, `tsconfig.build.json`: each changes the tarball | explicit | `.changeset/config.json`, AGENTS, `docs/toolchain.md` | 0 | low | counsel round 1: accepted, fixed c6ec16b |
| M2 | `inspect`'s signal listeners go when the first signal arrives, not only on interrupt: a scoped acquire/release replaces `Effect.callback`, whose cleanup runs only on interrupt | effect-native | `packages/inspect/src/bin.ts` | 0 | low | counsel round 1: accepted, fixed 97b4fac |
| L1 | Live check: overview → orders left `<main>` empty (also on `main` d272bd7). The orders layout enters as an outlet row; its unsettled `View.ready` holds the shell's `Loading` from inside the setup, a signal write, and `tracker.run` ran the setup's synchronous part inside the row's Solid owner, so Solid's development build (which the browser bundle loads) refused it and the row fiber died silently. `tracker.run` now forks under no owner, and the hold's place mark is made under the boundary's owner. Tests loaded Solid's production build, so every `--conditions=source` test script also passes `--conditions=development` (three #16 view tests were red on it). Framework, not app; `Route.client` has it too | explicit, effect-native | `packages/effect-frame/src/view/runtime.ts`, `tests/router/enter-layout-pending.test.tsx`, `apps/dashboard/tests/transition.test.tsx`, 6 `package.json` test scripts, `tests/README.md`, a changeset (patch) | 0 (+23 src) | low-med | live check: found, fixed 0a7b584 |
| L2 | A row's or branch's setup that died after mount vanished: `tracker.run` forked it and nothing joined it, so a `For`/`View.list`/`View.keyed`/`View.show`/`View.match` row or a route's outlet row stayed empty and the defect reached no one. `run` now hands a non-interrupt cause to `refuse`, which takes a `Cause` (the Portal refusal is `Cause.die`): the first build fails the mount, after `settle` the mount scope closes with it; `settle` also closes with a cause that arrived after `refusal()` was read. An interrupt only (the row left, the mount closed) reports nothing. The router's `pending` presenter dropped the same defect on its own fiber; it now draws a row that dies with the cause. Route pending tests 8 and 8b asserted the app carried on after a route setup defect; they now expect the mount to close with it. Owner's call if a route defect should instead stop at a router boundary. Still dropped: a handler's defect (`handle`), a source subscription's defect (`track`), a finalizer's defect on `owned.close` | explicit, effect-native | `packages/effect-frame/src/view/{runtime,control}.ts`, `src/router/branch.ts`, `tests/view/row-defect.test.tsx`, `tests/router/route-pending.test.tsx`, a changeset (patch) | 2 (+60 src) | medium | fixed fa4621d |


## Close

- Unswept directories: `<pending>`
- Largest sweep finding: `<pending>`
- Structural change named by the loop reader: `<pending>`
