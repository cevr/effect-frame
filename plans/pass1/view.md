# Architecture pass 1: view, hosts, JSX types

Tree: `/home/exedev/Developer/personal/effect-frame` (branch `hydrate-order`, effect-frame 0.26.1). I edited no repo file. One stray probe file was copied into `packages/effect-frame/` by mistake. I deleted it at once, before it ran.

Type probes are in `scratchpad/arch/probe-view/`. They are self-contained (their own `jsx-runtime.ts`) and were checked with the repo's `tsc` (`7.0.2+effect-tsgo.0.24.3`):

- `for.tsx` and `for2.tsx`: For inference.
- `typed/use.tsx`: typed intrinsics and branded errors.
- `typed/scope.tsx`: a missing-Loading brand.

The count helper is `scratchpad/cnt.sh`. It runs `rg -t ts` over `packages/`, `apps/`, and `tooling/`, excluding `dist` and `node_modules`. Counts are written as `p/a/t` (packages/apps/tooling).

## Summary of the view surface today

`view/index.ts` mixes three export styles:

- **Flat PascalCase JSX tags:** `For`, `Show`, `Match`, `Portal`, `Query`.
- **Flat PascalCase Effects:** `Loading`, `Errored`, `Await`, and the services `LoadingScope` and `ErroredScope`.
- **Flat lowercase Effects:** `ready`, `orErrored`, `readyWithStale`, `mount`, `render`.
- **Everything else under `View.*`.** Some of these names are also exported flat.

An agent cannot tell a name's kind from its case or from its import path. That is the root of trial frictions 1, 2 and 9.

---

## V1: One kind rule for view exports (Q1)

**Files:**
- `packages/effect-frame/src/view/index.ts:1-75`
- `view/readiness.tsx:406-473` (Loading, Errored), `:495-538` (Query, Await)
- `view/runtime.ts:1725`, `:1836`
- `view/view.ts:94-156`

**Problem:** PascalCase does not tell a tag from an Effect.

- `Loading` and `Errored` are Effects: `readiness.tsx:406` returns `Effect.Effect<Node, E, Exclude<R, LoadingScope>>`.
- `Query` is a sync tag: `readiness.tsx:495` returns `Node`.
- `Await` is an Effect that only wraps `Query` in `Effect.succeed`: `readiness.tsx:521-538`.
- `For` is a tag and `View.list` is an Effect for the same keyed list: `control.ts:19`, `:45`.

The trial hit TS2786 (`<Loading>`) and TS2488 (`yield* Show`); see `trial/mistakes.tsx.txt` M1, M5 and M9.

**Can Loading and Errored be tags? No.** A tag is synchronous. A tree carries no `R`, and "the runtime runs no Effect found in a tree" (`view.ts:147-151`). `Loading` must:

1. Run the children's setup with `LoadingScope` provided, because `ready` registers during setup (`readiness.tsx:412-415`).
2. Discharge `LoadingScope` from `R` (`Exclude<R, LoadingScope>`), so the caller's `R` stays honest.

A tag version would have to carry an un-run Effect in the tree and erase its `E` and `R`. That breaks effect-native and explicit. So the boundaries stay Effects, and the rule is decided by case.

**Rule:**

- A flat PascalCase value is a JSX tag (sync, returns `Node`) or a namespace (`View`, `Dom`, `Html`, `Remote`, `ViewTest`).
- Every Effect and every function is a lowercase member of `View`.
- Types stay flat.

A type test in `tests/view/types.test.tsx` guards the rule. It asserts that each flat PascalCase value is assignable to `(props: never) => Node` or is a namespace object. Today no check sees this rule, so it is a guard gap.

| Export today | Kind today | Proposed | Kind | Callers (p/a/t) |
| --- | --- | --- | --- | --- |
| `For` | tag | `For` | tag | `<For` 12/9/0 |
| `Show` | tag | `Show` | tag | `<Show` 14/0/0 |
| `Match` | tag | `Match` | tag | `<Match` 13/0/0 |
| `Portal` | tag | `Portal` | tag | `<Portal` 5/0/0 |
| `Query` | tag | `Await`, props `{ query, loading, failed, ready }` | tag | `<Query` 12/0/0 |
| `Await` | Effect (PascalCase) | deleted, merged into the `Await` tag | none | `Await` 8/0/0, all in `readiness.test.tsx` |
| `Loading` | Effect (PascalCase) | `View.loading({ fallback, content })` | Effect | `Loading({` 72/5/0 |
| `Errored` | Effect (PascalCase) | `View.errored({ fallback, content })` | Effect | `Errored({` 10/4/0 |
| `LoadingScope`, `ErroredScope` | service classes, flat | `View.LoadingScope`, `View.ErroredScope` (a namespace member, not a tag) | service | 2 flat imports |
| `ready` | Effect, flat | `View.ready` | Effect | `ready(` 84/12/0 |
| `orErrored` | Effect, flat | `View.orErrored` | Effect | 29/16/0 |
| `readyWithStale` | Effect, flat | `View.readyWithStale` | Effect | 16/4/0 |
| `View.list` | Effect | `View.list` (unchanged) | Effect | 31/6/1 |
| `View.form`, `View.attempt` | Effect | unchanged | Effect | 9/2/0, 25/0/0 |
| `View.lazy` | function returning a View | unchanged (see V10) | function | 11/0/0 |
| `mount` | Effect, flat | `View.mount` | Effect | 27 imports |
| `render` | Effect, flat (it only flushes; `runtime.ts:1831-1836`) | `View.flush` | Effect | 26 imports |
| `bind`, `event`, `submit`, `attach` | flat and `View.*` | `View.*` only (V2) | function | see V2 |
| `View.select` | function | deleted (V2) | none | 0/0/1 |

- `children` becomes `content` on the two boundaries, because a prop named `children` on a call invites the tag form. Keeping `children` is fine if the owner prefers it.
- `Query` becomes `Await` for two reasons: it frees `Query` for the actor namespace (V7), and React Router's `<Await>` is prior art for a tag with this job.

| Field | Value |
| --- | --- |
| North star | explicit, expressive |
| Change | Renames and re-homes as in the table. Delete `Await` (`readiness.tsx:510-538`, about 29 lines) and its re-exports. |
| Lines removed | about 45 net. Call-site churn is mechanical: about 260 call sites, mostly tests. |
| Risk | med (breadth only) |
| Public API change | yes, needs a changeset (major for the view entry) |
| Wire or stored format | no |

Acceptance row `docs/design/acceptance.md:382` ("Loading, stale Ready, Failed, nested scopes, Query, and Await remain covered through the view facade") must move with `tests/view/readiness.test.tsx:598` ("Await matches the union…"). The test is retargeted to the `<Await>` tag.

---

## V2: One path per export (Q2)

**Files:** `view/index.ts`, `view/view.ts:94-136`, `view/query-state.ts:4-13`, `package.json` exports.

Every duplicate path:

| Name | Paths | Callers per path | Keep |
| --- | --- | --- | --- |
| `bind` | `index.ts:29` flat; `View.bind` (`view.ts:94`) | flat 0 (import tally over p/a/t), `View.bind` 240/47/2 | `View.bind` |
| `event` | `index.ts:30`; `View.event` (`view.ts:116`) | flat 0, `View.event` 34/12/6 | `View.event` |
| `submit` | `index.ts:31`; `View.submit` (`view.ts:127`) | flat 0, `View.submit` 2/1/2 | `View.submit` |
| `attach` | `index.ts:28`; `View.attach` (`view.ts:72`); `Dom.attach` (`hosts/dom.ts:85`); OpenTUI `attach` (`hosts/opentui.ts:21`) | flat 1 (`src/router/leaf-root.ts:2`), `View.attach` 0, `Dom.attach` 17/0/0 | `View.attach` for host-generic use (leaf-root) and the host-typed `Dom.attach` |
| `select` | `View.select` (`view.ts:101`, an alias); `select` and `Source.select` in `actor/client` | `View.select` 0/0/1 (`tooling/checks/consumer/declarations.ts:65`) | `select` from `effect-frame/actor/client` |
| `ListOptions` (type) | `index.ts:8`; `View.ListOptions` (`view.ts:136`) | 4/0/0 in total | `View.ListOptions` |
| `Bound`, `Prepared`, `Attached`, `Handler` (types) | flat (`index.ts:32-35`) and `View.*` (declared in `view.ts`) | Bound 22, Prepared 47, Attached 33, Handler 8 (p only) | flat types only (types stay flat under V1) |
| `QueryState.isFailed/isLoading/isReady/match` and the `Query*State` types | view `QueryState` namespace re-export (`query-state.ts:4-13`); `actor/client` | view path 0 (the 19 hits are actor imports: `tests/actor/source.test.ts:4`, and others) | `actor/client` (V8) |
| `ViewTest` | `effect-frame/view` → `ViewTest` (`index.ts:56`); subpath `effect-frame/view/testing` (`package.json` `./view/testing`) | subpath importers 0/0/0; `ViewTest.` 85/0/0 | subpath `effect-frame/view/testing`, the same as `effect-frame/actor/testing`, so a test harness is not in the browser entry `tooling/checks/src/browser-entries.ts:19` |

| Field | Value |
| --- | --- |
| North star | explicit |
| Change | Delete `index.ts:27-36` flat function re-exports and `index.ts:8`, `view.ts:101`, `query-state.ts:4-13`. Point `router/leaf-root.ts:2` at `View.attach`, and `declarations.ts:65` at `select`. Drop `ViewTest` from `index.ts:56`; the 26 importing test files switch to the subpath. |
| Lines removed | about 22 |
| Risk | low |
| Public API change | yes, needs a changeset |
| Wire or stored format | no |

---

## V3: Typed intrinsic JSX, per host, with named "wrap with" errors (Q3)

**Files:**
- `view/jsx-runtime.ts:235-241` (`ElementType`, `IntrinsicElements { readonly [tag: string]: ElementProps }`), `:174-176`, `:204-206`
- `view/runtime.ts:1349-1351`, `:1395-1437`
- `view/hosts/html.ts:147-156`

**Problem:** any tag, any attribute, any event name, and any value compiles.

- `className`, `onClik`, and `<form onSubmit={View.event(...)}>` all compile silently. The last one posts natively.
- A raw `Source` child fails with "not assignable to type 'RawProp'", which does not name the fix. The same goes for a React-style arrow in `onClick`.

The runtime then silently drops anything it cannot place:

- `sortProps` ignores a `Prepared` under a non-`on*` name (`runtime.ts:1424-1431`). No branch handles `prop._tag === "Prepared" && !isEventProp`.
- An `Attached` under any name but `attach` is also ignored.
- A `Prepared` or `Attached` in a child position draws `Empty` (`jsx-runtime.ts:182-185`, `drawsNothing`).
- A string value on `onclick` becomes a static attribute (`classify`, `runtime.ts:1395-1403`).

**Design** (proved in `probe-view/typed/use.tsx`):

- `IntrinsicElements` becomes a closed map. `ElementType = keyof IntrinsicElements | ((props: never) => Node)`.
- Attribute values are `Attr<A> = A | Bound<A>`. An attribute's static type is its own (`tabindex: number`, `hidden: boolean`, `type: "button" | "submit" | "reset"`).
- Global attributes: `id`, `class`, `title`, `hidden`, `role`, `tabindex`, `lang`, `dir`, `` `aria-${string}` `` and `` `data-${string}` `` index signatures, `attach`, and `children`.
- Void elements (`input`, `img`, `br`, `meta`, and so on) declare `children?: never`.
- Handlers: `on*` props are `Prepared<"event">`. `Prepared` gains a phantom `Kind`: `View.event` gives `"event"`, while `View.submit` and `FormBinding.submit` give `"submit"`.
- `<form onSubmit>` accepts only `Prepared<"submit">`. So `onSubmit={View.event(...)}` is a compile error (probe e5) and trial friction 5 is closed. `form` also declares `method?: never; action?: never`, because the runtime writes those from the plain post (`runtime.ts:1465-1470`).
- The probe also rejected `onClick={View.submit(...)}` (e6). The real version should accept `"submit"` on `a` and `button` too, so only the form rule is strict.
- **Named errors:** each slot's union carries a member that no right value satisfies, and that member's missing key is the fix. TypeScript reports the best-overlap member. Probe output:
  - `Property '"wrap the source with View.bind(source)"' is missing in type 'Source<number>'` for `<p>{count}</p>` and `<p title={count}>`.
  - `Property '"wrap the handler with View.event(handler)"' is missing` for `onClick={() => send()}`.
  - `Property 'onClik' does not exist on type 'ButtonProps'. Did you mean 'onClick'?`
  - `Property 'className' does not exist`, and `<blink />` is refused.
- **Per host:** the notes app states that "Only the tags differ" between hosts (`apps/notes/src/terminal-view.tsx:10-15`). So `effect-frame/view` keeps the HTML map, which the DOM, HTML and Remote hosts share. `effect-frame/view/opentui` exports its own `jsx-runtime` with `box`, `text` and `input` (tags used: `<text` 5, `<box` 4). A TUI file opts in with `/** @jsxImportSource effect-frame/view/opentui */`. Three files in the repo draw TUI tags: `apps/notes/src/terminal-view.tsx`, `tests/view/opentui.test.tsx` and `tests/view/readiness-ownership.test.tsx`. This makes the host explicit where the file is written.
- **Deletions it enables:**
  - `html.ts:147-156` `attributeName` (`className` → `class`, `htmlFor` → `for`). `className=` has 0/0/0 callers and `class=` has 24/15/25, so the alias is a second name for one concept.
  - `jsx-runtime.ts:182-185` `drawsNothing` becomes unreachable, since `Child` no longer admits `Prepared` or `Attached`.

**Size:**
- HTML map: about 450 lines of types.
  - About 25 global attributes and about 30 events.
  - Specific attribute sets for about 15 elements: `a`, `button`, `form`, `input`, `textarea`, `select`, `option`, `label`, `img`, `meta`, `link`, `script`, `time`, `video`, `dialog`, `td` and `th`.
  - The other roughly 100 tags map to `Global`.
- OpenTUI map: about 80 lines.

**Foldkit** (`/home/exedev/Developer/oss/foldkit/packages/foldkit/src/html/index.ts`):
- A closed `TagName` union (`:294`, 213 tags).
- One global `Attribute<Message>` tagged enum of about 307 members (`:578-972`). It is not per element, apart from `TextareaAttribute` (`:3260`) excluding `InnerHTML`.
- 13 void builders that take no children (`VoidElementFunction`, `:3246`).
- Events decode their payload per event, for example `OnKeyDown: { f: (key, modifiers) => Message }` (`:635`) and `OnInput: { f: (value) => Message }` (`:675`).

**Adopt:** the closed tag set, void elements with no children, and per-element exceptions.

**Reject for now:** Foldkit's one global attribute union. JSX gives per-element props for free.

**Owner question:** per-event decoded payloads (keyboard `key` and modifiers, `files`) would replace `HostEvent.value: string` (`host.ts:276-285`). That fits expressive and effect-native, but it widens `Remote.RemoteEvent` (`hosts/remote.ts:183`), which is a wire format. It is rejected by default until the owner decides.

| Field | Value |
| --- | --- |
| North star | explicit, expressive |
| Lines removed | about 15 in runtime and hosts (about +530 lines of types) |
| Risk | med. Existing apps use 45 `onClick`, 11 `onSubmit`, 5 `onInput`, 1 `onChange` and 1 `onEnter`, all already `Prepared`. |
| Public API change | yes, needs a changeset |
| Wire or stored format | no |

---

## V4: Multi-word event props never fire in the DOM (defect, found under Q3)

**File:** `view/runtime.ts:1351`

```ts
const eventNameOf = (name: string): string => `${name.slice(2, 3).toLowerCase()}${name.slice(3)}`;
```

- `onKeyDown` listens for `"keyDown"` and `onPointerDown` for `"pointerDown"`. `hosts/dom.ts:173-181` passes the name to `node.addEventListener` unchanged, and DOM event names are all lowercase, so neither ever fires.
- No caller uses a multi-word name today: only `onClick`, `onSubmit`, `onInput`, `onChange` and `onEnter` appear (a `rg -o 'on[A-Z]\w*='` tally over `*.tsx` in p/a/t). So it is latent.
- The OpenTUI names in use are single lowercase words (`input`, `enter`), so full lowercasing is right for both hosts.
- `onDoubleClick` → `dblclick` still needs the V3 table. Name the prop `onDblClick`, or give it an explicit map entry.

| Field | Value |
| --- | --- |
| North star | explicit (the prop name is the event) |
| Change | `name.slice(2).toLowerCase()`, plus a red test in `tests/view/dom.test.tsx` that fires `keydown` |
| Lines removed | 0 (one line changes) |
| Risk | low |
| Public API change | no |
| Wire or stored format | no. `AddListener.name` keeps its schema; only names that never fired change. |

---

## V5: Keyed `For` loses its item type. The cause is the dual `select` (Q4)

**Files:** `packages/effect-frame/src/actor/source.ts:24-30`; `view/control.ts:12-24`

**Receipt:** `probe-view/for.tsx` and `for2.tsx`, current `ForProps` shape:

| Case | Result |
| --- | --- |
| Inline `each={select(state, s => s.items)}` with a single-signature `select` | infers `Item`; `keyBy={(i) => i.id}` compiles (`for2.tsx:11`) |
| The same with a two-overload `dual` `select`, identical to `source.ts:24-27` | TS2322 on `each` plus TS18046 "'i' is of type 'unknown'" (`for.tsx:13`) |
| Plain call `For({ each: dual(...), keyBy: (i) => i.id, ... })`, no JSX | fails (`for2.tsx:9`) |
| Annotating the projection's parameter | still fails (`for2.tsx:13`) |
| **Proposal A:** `key="id"` as a field name | fails too; it infers `Item = { id: any }` (`for.tsx:19`) |
| **Proposal B:** `NoInfer` on `keyBy` and `children` | fails too (`for.tsx:29`) |
| No `keyBy` at all, a children lambda only | fails (`for2.tsx:17`) |

So the defect is not in `For` or in JSX. When the overloaded `dual` `select` sits in an argument position whose type is still being inferred, it resolves against `Source<readonly unknown[]>`.

The data-last overload has 0 callers: `rg '\bselect\(\s*\(?[a-zA-Z_]+\)?\s*=>'` over p/a/t returns nothing.

**Change:**
- Give `select` one signature, `(source, project)`, and delete the data-last overload and the `Function.dual`.
- Keep `For`'s API unchanged. `keyBy` stays a function, which is more expressive than a field name, and the field-name idea does not fix inference.
- Optionally drop the 17 defensive annotations (`keyBy={(x: T) => …}`, counted by `rg -c 'keyBy=\{\([a-zA-Z]+: '`), for example `apps/dashboard/src/overview.tsx:92` and `apps/dashboard/src/orders-page.tsx:44`. `tests/view/list-moves.test.tsx:37,46,60,82` already writes `keyBy` without annotations.
- Add a type test for an inline `select` inside `<For>`.

| Field | Value |
| --- | --- |
| North star | expressive |
| Lines removed | about 4 (overload), plus up to 17 annotations |
| Risk | low |
| Public API change | yes (the data-last `select` form goes). Needs a changeset. |
| Wire or stored format | no |

Other Dual-overloaded `Source` combinators in `source.ts` (`debounce`, `throttle`, `mapEffect`) carry the same risk in a JSX prop position. They are outside this pass; flag them for the actor sweep.

---

## V6: Reject an unprovided `LoadingScope` or `ErroredScope` with a named error (Q5)

**Files:**
- `router/branch.ts:2888-2897` (`ModeConstructor`)
- `view/runtime.ts:1725` (`mount`)
- tests: `tests/router/nested-transition.test.tsx:638-660`, `tests/router/route-public.test.tsx:478-490`, `tests/view/types.test.tsx:92-117`

**Problem:** a `ready` with no `Loading` above it only shows up as `LoadingScope` in `R`:

- `types.test.tsx:93-96` asserts that `mount` returns `Effect<void, never, LoadingScope | Scope>`, and it compiles.
- `nested-transition.test.tsx:651-654` asserts that a leaky tree compiles with `LoadingScope` in its services.

The error surfaces only where the app provides layers, far from the cause.

**Where to reject:** not at `Route.leaf`. A layout legally discharges its child's scope: "The layout's Loading consumes the child's LoadingScope" (`nested-transition.test.tsx:628`). The whole tree's `R` is final in two places: the mode constructors (`client`, `ssr`, `streamed`, `awaitAll`, `prerender`, `driven`, all `ModeConstructor`) and `View.mount`. Add the brand at both:

```ts
type OpenBoundary<R> =
  [Extract<R, LoadingScope>] extends [never]
    ? [Extract<R, ErroredScope>] extends [never] ? unknown
      : { readonly "View.orErrored needs a View.errored above it": ErroredScope }
    : { readonly "View.ready needs a View.loading above it": LoadingScope };
// root: Branch<Seg, ViewR, DataR> & OpenBoundary<ViewR>
```

**Receipt:** `probe-view/typed/scope.tsx` gives `Property '"View.ready needs a View.loading above it"' is missing…`. Inference of `R` survives the intersection, and a well-formed tree compiles.

**Tests that flip:** the `leakyServices` assertions become `@ts-expect-error` at the constructor (`nested-transition.test.tsx:651-659`, `route-public.test.tsx:487-490`), and `types.test.tsx:93-117` asserts the brand.

The router branch at `router/branch.ts:1756` (`Effect.serviceOption(LoadingScope)`) is internal and unaffected.

| Field | Value |
| --- | --- |
| North star | explicit, expressive |
| Lines removed | about 0 (+12) |
| Risk | med (router generics) |
| Public API change | yes, compile-time only. Needs a changeset. |
| Wire or stored format | no |

---

## V7: Name collisions across subpaths (Q6)

Every name exported by more than one public subpath, from a runtime key scan of all 10 subpaths run with `bun --conditions=source`. `actor` re-exports `actor/client` on purpose, so those pairs are excluded. Type-only collisions come from grep.

| Name | Where | Receipt of pain | Proposal |
| --- | --- | --- | --- |
| `Loading` | `actor/client` (a `QueryState` constructor, `actor/query.ts:227`); view boundary (`readiness.tsx:406`); view `QueryState.Loading` schema (`query-state.ts:27`) | trial friction 9 | `View.loading` (V1); delete the view schema (V8) |
| `Ready`, `Failed`, `QueryState`, `isReady`, `isFailed`, `isLoading`, `match` | `actor/client` and view `QueryState.*` | 0 view-path callers (V2) | delete the view copies (V8) |
| `ready` | view readiness `ready` (`readiness.tsx:174`) and view `QueryState.ready` constructor (`query-state.ts:51`) | two meanings in one entry | `View.ready`; the constructor moves to `ViewTest` (V8) |
| `Query` | `actor` (server namespace) and the view tag | `tests/view/query-test-layer.test.tsx:9` imports `Query as HostQuery` | the view tag becomes `Await` (V1) |
| `mount` | `view` (`runtime.ts:1725`, positional) and `router` (`router/router.ts:266`, options object) | 11 `mount as mountRouter` aliases plus `router/router.ts:3` `mount as mountView` (`rg 'mount as '`) | `View.mount` (V1); rename the router's to `mountRouter`, which matches the existing aliases |
| `render` | view flush | `tests/router/route-actor-seed.test.tsx:20` `render as renderFrame` | `View.flush` (V1) |
| `hydrate` | `router` flat (`router/index.ts:31`) and `Dom.hydrate` | none seen | keep; one side is namespaced |
| `Match` (type) | `router/router.ts:58` `interface Match`, exported from `router/index.ts:15`; view `Match` tag | a type and a value with one name across the two entries an app imports most | rename the router type `RouteMatch` |
| `select` | `actor/client` and `View.select` | trial "reviewer" note | delete `View.select` (V2) |
| `attach` | flat, `View.attach`, `Dom.attach`, OpenTUI `attach` | 1 flat caller | V2 |
| `client` | `Remote.client`, `Route.client`; `form`: `HttpServer.form`, `View.form`; `make`, `layer`, `host`: namespaced | none | keep; namespaced |

Guard gap: no check refuses a new flat name that collides across subpaths. Add a case to `tooling/checks` that imports every subpath and fails on a duplicate flat key outside the declared `actor` ⊇ `actor/client` superset. The scan above is that check's body.

| Field | Value |
| --- | --- |
| North star | explicit |
| Lines removed | about 0 net (renames) |
| Risk | low |
| Public API change | yes, needs a changeset |
| Wire or stored format | no |

---

## V8: The view `QueryState` namespace is mostly dead, and a test fake ships in production

**File:** `view/query-state.ts` (132 lines), exported at `view/index.ts:59`.

Callers:

- 0 callers: `hasValue` (`:63`), `held` (`:125`; the only `held(` hit, `hosts/remote.ts:806`, is a different local function), and the schemas `Loading`, `Ready`, `Failed` and `QueryState` (`:27-44`). The only `QueryState.QueryState` hit is a type use in `tests/view/types.test.tsx:24`.
- 0 callers through the view path: the re-exports at `:4-13`.
- Only tests use the lowercase constructors (`readiness.test.tsx`: 1 `ready`, 1 `failed`) and `fakeQuery` (8 in `readiness.test.tsx` plus 2 in `tests/router/browser/navigation-app.tsx`).

The doc says the schemas let "a server render serialize a pending query" (`:22-24`). Nothing does that, and `actor/query.ts:164-238` owns the real union and its constructors. So one concept has two owners, and the view copy is dead.

| Field | Value |
| --- | --- |
| North star | effect-native (one owner, the actor module), explicit |
| Change | Delete `query-state.ts` except `fakeQuery`, which moves to `ViewTest.fakeQuery` in `view/testing.ts`. The type import in `readiness.tsx:15` points at `actor/client`. |
| Lines removed | about 95 |
| Risk | low |
| Public API change | yes, needs a changeset |
| Wire or stored format | no (the schemas were never used on a wire) |

---

## V9: Runtime node-model types exported with no outside caller

**File:** `view/index.ts:37-51`

Files outside `src/view/` that name each type (`rg -l`, filtered):

- **0 files:** `ControlNode`, `PropValue`, `PortalNode`, `ForNode`, `ShowNode`, `BoundaryKind`, `ShowIfProps`, `ShowWhenProps`, `MatchCases`.
- **Only other meanings:** `Component` and `Tag`. The `Component` hits are path components (`router/path.ts`, `router/codec.ts`); the `Tag` hits are in `tests/plain-form-fixture.tsx`.
- **Used outside:** `MatchNode` (1 test, `tests/view/types.test.tsx:2`) and `ElementNode`/`ElementProps` (`router/leaf-root.ts`, an internal module).

These types expose the interpreter's tree to authors. Authors need `Node`, `Child`, and the `*Props` types of tags they wrap.

| Field | Value |
| --- | --- |
| North star | explicit (a small interface) |
| Change | Unexport them. `leaf-root.ts` imports `../view/jsx-runtime.js` directly. |
| Lines removed | about 12 |
| Risk | low |
| Public API change | yes, needs a changeset |
| Wire or stored format | no |

---

## V10: `View.lazy` is found through a hidden global WeakMap keyed by function identity

**Files:** `view/lazy.ts:74`, `:151-157`; `router/branch.ts:62`, `:1037`, `:1153`

**Problem:** `lazy` registers the returned function in a module-level `WeakMap` (`definitions.set(view, …)`). The router then asks `lazyDefinitionOf(view)` to decide whether to start the import beside data acquisition.

A lazy view wrapped once, for example `(p) => LazyPost(p)` or `attempt`-style composition, silently loses the parallel import. It still works, but it imports only at setup. No type or check shows this.

**Change:** `lazy` returns a tagged `LazyView<P, E, R>` (callable and carrying `definition`), and `Route.leaf`/`layout` accept `View | LazyView` explicitly. The WeakMap goes, and `definitionOf` becomes a field read.

Also, `lazy.ts:126` uses `Effect.runFork` on a detached import with a module-level `let state`. That is documented and deliberate (`:23-25`), so there is no change there.

| Field | Value |
| --- | --- |
| North star | explicit over implicit |
| Lines removed | about 10 |
| Risk | med |
| Public API change | yes, needs a changeset |
| Wire or stored format | no |

---

## Owner questions (a candidate that trades north stars, or reopens a closed design)

- **O1: A `Loading` with no registration stays pending forever.** See `readiness.tsx:318-330`: `all.length === 0 || …`. `View.loading({ fallback, content: Effect.succeed(<p/>) })` never shows its content. The router works around this with an optional service lookup (`router/branch.ts:1740-1765`, `settleLoading` via `Effect.serviceOption(LoadingScope)`). The rule is recorded as accepted (`tests/router/nested-transition.test.tsx:979`) and caused defect M7 in `docs/design/route-checks.md:168`. Changing it is declarative against the setup-once readiness rule, so the owner decides. `rejected.md` bars reopening a closed design without a new receipt; this entry offers the workaround and M7 as that receipt.
- **O2: Decoded per-event payloads (V3).** This would widen `Remote.RemoteEvent`, which is a wire format and is rejected by default.

## Not worth a pass (under about 5 lines of style each)

- `view/jsx-runtime.ts:97-102`: two stacked JSDoc blocks. The first ("A readiness boundary keeps…") is orphaned above `BoundaryKind`.
- `view/runtime.ts:1366-1373`: the same; the `classify` doc sits above `isMarker`'s doc.
- `view/readiness.tsx:192-193`: a comment that tells history ("The alternative … made every `Loading` leak `ErroredScope`… which the compiler caught").
- `view/query-state.ts:74`: "A fake query, enough to drive the prototype" tells history (gone with V8).
- `view/view.ts:151`: `View` doc says "A named view is `Effect.fn("Name")(…)`", but every app view is an arrow returning `Effect.gen` (trial friction 8). Pick one and fix the doc.
- `view/hosts/dom.ts:52-59`: `valueOf` reads only `input` and `textarea`, so `<select onChange>` gets `""`. There are 0 `<select` callers; fold it into V3's typed events.
- `view/control.ts:162-166`: `PortalProps<HostNode>.into` is unconstrained, and `PortalNode.into: unknown` (`jsx-runtime.ts:93`). V3's per-host runtime can type it.

## Ledger rows

| ID | Candidate | North star | Files | Lines removed | Risk | Status |
| --- | --- | --- | --- | --- | --- | --- |
| V1 | One kind rule: PascalCase = tag or namespace; Effects as lowercase `View.*`; `Query` becomes the `Await` tag, the `Await` Effect is deleted, `render` becomes `View.flush` | explicit, expressive | view/index.ts, readiness.tsx, runtime.ts, view.ts, plus call sites | ~45 net | med | proposed |
| V2 | One path per export (flat bind/event/submit/attach, View.select, ListOptions, QueryState re-exports, ViewTest) | explicit | view/index.ts, view.ts, query-state.ts, package.json | ~22 | low | proposed |
| V3 | Typed intrinsics per host, named "wrap with" errors, `Prepared<Kind>` form rule | explicit, expressive | jsx-runtime.ts, runtime.ts, hosts/html.ts, new intrinsics and opentui runtime | ~15 (+530 types) | med | proposed |
| V4 | `onKeyDown` listens to "keyDown" and never fires | explicit | runtime.ts:1351 | 0 | low | proposed (defect) |
| V5 | Dual `select` breaks `For` inference; single signature | expressive | actor/source.ts:24-30 | ~4 (+17 annotations) | low | proposed |
| V6 | Named brand for an unprovided Loading/Errored scope at mode constructors and mount | explicit | router/branch.ts:2888, view/runtime.ts:1725 | 0 | med | proposed |
| V7 | Cross-subpath name collisions and a check that refuses new ones | explicit | view, router, tooling/checks | 0 | low | proposed |
| V8 | Delete the dead view `QueryState` namespace; `fakeQuery` becomes `ViewTest.fakeQuery` | effect-native, explicit | view/query-state.ts | ~95 | low | proposed |
| V9 | Unexport runtime node-model types | explicit | view/index.ts | ~12 | low | proposed |
| V10 | `View.lazy` as a tagged value, not a WeakMap side channel | explicit | view/lazy.ts, router/branch.ts | ~10 | med | proposed |
