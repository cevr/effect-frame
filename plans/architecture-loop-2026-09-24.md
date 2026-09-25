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

## Close

- Unswept directories: `<pending>`
- Largest sweep finding: `<pending>`
- Structural change named by the loop reader: `<pending>`
