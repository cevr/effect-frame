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

Pass 2 candidates already known: A12, P5/P6 (a conditional that hosts a view, remount on key), P15 (debounced input marks results stale), Foldkit `Stale` on failed refresh, per-field form issues.

| ID  | Candidate | North star | Files | Lines removed | Risk | Status (`done <hash>` / `rejected: <receipt>`) |
| --- | --------- | ---------- | ----- | ------------- | ---- | ---------------------------------------------- |

Counsel defects:

| ID  | Defect | Red test | Status |
| --- | ------ | -------- | ------ |

Live check: `<pending>`

## Close

- Unswept directories: `<pending>`
- Largest sweep finding: `<pending>`
- Structural change named by the loop reader: `<pending>`
