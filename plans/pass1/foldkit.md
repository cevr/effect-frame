# Architecture pass 1: Foldkit prior-art survey

Foldkit at `/home/exedev/Developer/oss/foldkit` (HEAD `95fed7f`, 2026-09-23). effect-frame at `/home/exedev/Developer/personal/effect-frame`. Paths below are relative to `foldkit/packages/foldkit/src` (FK) and `effect-frame/packages/effect-frame/src` (EF), unless they start with a repo root. No file was edited.

Owner stance applied: Foldkit's single Model/update/message queue is out. A design is adopted only when it survives being moved behind an actor contract (one mailbox per actor) and keeps all five north stars.

## 1. Findings per design

### 1.1 `html`: typed elements, attributes and events

- **Foldkit.** There is no JSX. `h` is a builder: element functions typed by a closed `TagName` union (FK `html/index.ts:294`, `HtmlElements` at `:3286`, void elements separated at `:3253`) and a closed `Attribute<Message>` TaggedEnum (`:578`). Each event is its own constructor that decodes the DOM event into a typed payload: `OnInput: (value: string) => Message` (`:675`), `OnKeyDown: (key, modifiers) => Message`, `OnPointerDown` with nine typed fields. The event kind fixes the default-action policy: `OnSubmit` always calls `preventDefault` (`:1891-1896`), so a form can never post natively by mistake. Per-element narrowing exists where it matters: `TextareaAttribute` excludes `InnerHTML` (`:3260`). There are explicit escape hatches, `Attribute(key, value)` and `DataAttribute` (`:866-867`), plus `customElement(tagName: string)` (`:3220`). The builder carries its Message universe as a phantom (`MessageUniverse`, `:5506`; `HtmlBuilder`, `:5537`), and `inertHtml: HtmlBuilder<never>` makes every handler uncallable (`:5614`). A lint rule bans raw `onclick` strings (`repo packages/oxlint-plugin-foldkit/src/rules/no-raw-dom-event-attributes.ts`).
- **effect-frame.** `JSX.IntrinsicElements { readonly [tag: string]: ElementProps }` (EF `view/jsx-runtime.ts:239-241`) and `ElementProps { [name: string]: RawProp }` (`:174-176`). An error only appears when the value fails to fit `RawProp` (`:162-167`). `event` and `submit` both return the same `Prepared` (EF `view/view.ts:116-132`), so the types cannot tell `onSubmit={View.event(...)}` apart from `View.submit`. `HostEvent` is one untyped shape for every event (EF `view/host.ts:106-115`). The runtime is multi-host: DOM `div` and OpenTUI `box` (EF `view/hosts/opentui.ts`), which is why the map is `string`-keyed.
- **Verdict: adopt the idea, not the builder.** Foldkit's closed attribute set, events that carry a kind, and escape hatches all fit JSX. `h` threading and the Message universe do not: they exist to route into one `update`, so they are Elm coupling. The concrete shape is ranked adoption A2.

### 1.2 One rule for "function vs value" in view helpers

- **Foldkit.** Everything a view touches is a synchronous constructor that returns data. Elements are lowercase (`h.div`), attributes are PascalCase tagged-value constructors (`h.Class`, `h.OnClick`), and Commands and Messages are PascalCase callable Schemas (`Message.ClickedX()`). Views never run effects. The rule is written down: "capitalize architecture types … lowercase for plain functions" (repo `AGENTS.md:18`), "name functions by their precise effect" (`AGENTS.md:44`), and "barrels re-export intended names explicitly" (`AGENTS.md:134`). Lint rules enforce it (`packages/oxlint-plugin-foldkit/src/rules/command-define-pascal-const.ts`, `prefer-callable-message-constructor.ts`).
- **effect-frame.** The same case covers two kinds. Tags: `For`, `Show`, `Match`, `Portal` (EF `view/control.ts:19,93,149,174`) and `Query` (EF `view/readiness.tsx:495`). Effects: `Loading` (`:406`), `Errored` (`:450`) and `Await` (`:521`). `list`, `form`, `ready` and `orErrored` are lowercase Effects. The flat `bind`/`event`/`submit`/`attach` exports duplicate the `View.*` ones (EF `view/index.ts:27-36`). `Loading` also names a Schema (EF `view/query-state.ts:27`).
- **Verdict: adopt.** Rule: **PascalCase = a synchronous function that returns a `Node` (usable as a JSX tag). lowercase = returns an `Effect`, so you `yield*` it.** It keeps all five north stars and mostly serves "explicit". The shape is ranked adoption A1.

### 1.3 `command/`: Commands as values vs `CommandHandle`

- **Foldkit.** `Command.define(name, { args, messages, execute, interrupt })` (FK `command/index.ts:130-262`). A Command is a named Effect that `update` returns and the runtime runs, and its result comes back as a Message into the same `update`. Interrupt keys are addresses, not locks (`:144-160`).
- **effect-frame.** A command is a message to an actor, and there is no second mutation path (`CONTEXT.md:27-28`). `send` returns a handle with lifecycle `Sent | Admitted | Applied | Rejected | Uncertain` (EF `actor/command-handle.ts:20-25`) and carries identity, `settled` and `retry` (`:71-86`). The actor owns the work, and the handle can be dropped (`CONTEXT.md:99-101`).
- **Verdict: rejected (actor-model).** Returning effect descriptions from a pure `update` means a single reducer owns every side effect. In effect-frame, side effects belong to the actor's behavior (EF `actor/behavior.ts:40-73`) or to the view scope's handler fiber (EF `view/view.ts:103-121`). Interrupting by key does not carry over either: an admitted command applies once and cannot be withdrawn (`CONTEXT.md:103-105`). effect-frame's lifecycle already has more detail than Foldkit's result Message (`Uncertain`, retry). Nothing to take.

### 1.4 `managedResource/` vs scoped Layers

- **Foldkit.** `ManagedResource.make` watches `modelToMaybeRequirements(model)` after each update. A change from `None` to `Some` acquires, a change from `Some(a)` to `Some(b)` releases and re-acquires, and `Some` to `None` releases (FK `managedResource/managedResource.ts:206-250`). `acquire` runs in a scope that lives as long as the resource, so a `Layer.build` inside it tears down on release (`:240-249`). `tag<V>()(key).get` fails with a typed `ResourceNotAvailable`, and its identity appears in `R` (`:13-76`).
- **effect-frame.** A view's setup scope, an attached behaviour's scope (EF `view/view.ts:61-74`), and `Source.mapEffect` (EF `actor/source.ts:190-229`). `mapEffect` wraps each run in `Effect.scoped(f(value))` (`:216`), so a resource cannot outlive its computation even while its key is still current. That gap is exactly agent-trial friction #4: route data is a `Source<RemoteActorRef>`, and there is no `switchMap` or `flatten`.
- **Verdict: adopt the lifecycle, reject the model wiring.** A resource keyed on a derived value, held in its own scope until the key changes, is effect-native and actor-neutral. `modelToMaybeRequirements` reads one app Model, which is Elm coupling. The effect-frame form keys on a `Source` the view already holds. It is ranked adoption A3.

### 1.5 `asyncData/` vs `QueryState` and readiness

- **Foldkit.** Six states: `Idle | Loading | Refreshing | Failure | Stale | Success` (FK `asyncData/asyncData.ts:15-61`). `Stale` means the last refresh failed and the data is still held (`:27-29`). The app folds results by hand with `settle`, `revalidateOrLoad` and `loadIfMissing` (`:613`, `:647`, `:836`), and `zipWith`/`all` combine states over a lattice (`:665`, `:760`).
- **effect-frame.** Three states: `Loading | Ready{value, stale} | Failed` (EF `actor/query.ts:164-180`). The query cache produces them, and readiness scopes consume them (EF `view/readiness.tsx:406-470`). A failed refresh replaces `Ready` with `Failed` and drops the held value (EF `actor/query-client.ts:474-481`).
- **Verdicts.**
  - `Idle`: **rejected (explicit/declarative).** A query exists only while a scope declares it (`CONTEXT.md:91-93`), so "not requested" cannot happen.
  - Hand-folding transitions: **rejected (declarative).** The cache owns fetch order and refresh.
  - `zipWith`/`all`: **already covered** by `Source.all` (EF `actor/source.ts:76`) plus one readiness scope that waits for every registered query.
  - `Stale` (a refresh failed but the value is kept): **adopt, pending an owner decision.** Today a background refresh error blanks content and trips `Errored`. The change touches the `QueryState` Schema, which is serialized for resume (EF `view/query-state.ts:35-45`), so `rejected.md` row 1 applies. It is ranked adoption A6.

### 1.6 `route/`: bidirectional parser and printer vs the effect-frame router

- **Foldkit.** Biparser combinators (`literal`, `int`, `slash`, `query`, `mapTo`) build a `Router` that parses and is callable to print (FK `route/parser.ts:43-73`, `:546-572`). A named brand error blocks `slash` after a terminal parser: `'Cannot use slash after a terminal parser …'?: never` (`:86-89`). `Transition` provides `entered`, `exited` and `stayed` helpers (FK `route/transition.ts:9-146`). A lint rule, `no-hardcoded-route-strings`, bans hand-written paths.
- **effect-frame.** A URLPattern template with Schema params and search, and a total `href` printer (EF `router/codec.ts:555-568`, `CONTEXT.md:63-65`). Links are typed (EF `router/link.tsx:36-40`). Transitions per segment are entering, stayed or exited (`CONTEXT.md:75-77`, EF `router/branch.ts:907`). A malformed template is a typed `TemplateRejected` (EF `router/codec.ts:35`).
- **Verdict: settled, parity.** Combinators would add no power over an explicit template. Two small pieces are worth taking:
  - The lint rule, which goes into A4.
  - The brand-error style, which goes into A2.

### 1.7 `fieldValidation/` vs `View.form` and `Form.codec`

- **Foldkit.** `Field<A> = NotValidated | Validating | Valid | Invalid` (FK `fieldValidation/fieldValidation.ts:7-24`) with predicate+message `Rule` tuples (FK `fieldValidation/rule.ts:6-136`). The file itself steers toward reusing a Schema: `fromSchema` (`rule.ts:138-148`).
- **effect-frame.** A form binds one contract message member. `Form.Covered` rejects a field that no input carries (EF `actor/form.ts:437-453`). `Form.codec` requires `Codable` (`:378-407`). Issues come only from a refused post (`:459-465`, `CONTEXT.md:151-153`). `View.form` does not apply `Codable` (EF `view/form.ts:26-37`, agent-trial friction #7).
- **Verdicts.**
  - `Rule` tuples: **rejected (effect-native).** They are a second, hand-written validator beside the contract Schema, so the client and the server could disagree about what is valid.
  - The four-state field: **adopt as a Source derived from the one Schema.** A field's pre-submit issue comes from decoding that field through the member's form codec, which is the same code the server runs. It is ranked adoption A7, and it includes applying `Codable` in `View.form`.

### 1.8 `devTools/` vs `inspection`

- **Foldkit.** A history store of Messages, Model snapshots, keyframes and diffs (FK `devTools/store.ts`, `devTools/protocol.ts:7-150`). An MCP server exposes it to agents: `foldkit_get_model`, `list_messages`, `diff_models`, `replay_to_keyframe`, `get_message_schema` and `dispatch_message` (repo `packages/devtools-mcp/src/tools.ts:332-513`). The repo tells agents to use it before adding logs (repo `AGENTS.md:223-225`).
- **effect-frame.** Protocol v1 takes a snapshot of Actor, Query, Mount, Route, UrlState and Command records (EF `inspection.ts:15-107`) through a loopback gateway and a CLI reader (`README.md:69-80`, EF `inspection/protocol.ts:18-43`). `ActorRecord` carries only `revision`, with no state (EF `inspection.ts:15-22`). `CommandRecord` deliberately carries no payload (`:88-104`).
- **Verdicts.**
  - Time travel and replay: **rejected (actor-model).** Committed revisions are the authority, and a client cannot rewind a server actor. The change stream also carries only the latest state, not a log (`CONTEXT.md:123-125`).
  - A schema index of contracts (message members and fields): **adopt.** It is read-only and needs no new wire for state.
  - Actor public snapshot plus a dev-side ring of the revisions this client observed, with diffs: **adopt, pending an owner decision.** It needs protocol v2 (`rejected.md` row 1).
  - A dev-only `send` through the gateway: **consider.** It still enters the actor mailbox, so the actor model holds. It must be a named capability under a policy, which is the "explicit" north star. Owner decision.

  This is ranked adoption A8.

### 1.9 Hydration

- **Foldkit.** Each render stamps a **build id** on the root, and `hydrate` compares it before adopting anything, so a page from deployment N is never reconciled against client N+1 (FK `buildToken.ts:1-22`). The id is passed explicitly on both sides, because a compile-time define inside the package silently disappears in a server build (`:14-19`). Runtime ids must be unique per root, and a violation is refused (FK `runtime/hydrationHandoff.ts:56-80`). Keys and view identities are stamped (FK `hydrationMarkers.ts:21-81`). A mismatching subtree is rebuilt (FK `hydrate.ts:1045-1060`).
- **effect-frame.** `Router.hydrate` reads the document records, resumes the cache and mounts over the server nodes (EF `router/hydrate.ts:29-40`). `Dom.hydrate` reports `mismatches`, `unclaimed` and `resolvedAhead` (EF `view/hosts/dom.ts:190-210`, `:298`). Nothing identifies the deployment: a search for build, deployment or skew finds nothing in `src`.
- **Verdicts.**
  - Build id: **adopt.** Skew between deployments currently shows up as mismatches or as a resume payload decoded with the wrong contract. Ranked adoption A5.
  - Compiler-stamped view identities: **rejected (explicit).** They need a bundler plugin. effect-frame views run their setup once and claim nodes in order, so they have no problem of identity across re-renders to solve.

### 1.10 Docs and agent-facing material

- **Foldkit ships:**
  - A repo `AGENTS.md`, symlinked as `CLAUDE.md` (266 lines of naming, state-modeling and view rules).
  - Three consumer skills (repo `skills/foldkit/SKILL.md`, `skills/generate-program/`, `skills/audit-program/`).
  - A single canonical `blindSpots.md` checklist, with one line of output per slug: "silence is not a pass" (repo `skills/generate-program/blindSpots.md:1-8`).
  - A `FOLDKIT.md` in the scaffolder that the framework owns and replaces whole on upgrade (repo `packages/create-foldkit-app/templates/base/FOLDKIT.md:1-3`).
  - Guidance to vendor the repo as a subtree pinned to the installed version (repo `skills/foldkit/SKILL.md:23-41`).
  - `llms.txt`, `llms-full.txt`, and a `.md` of every page (repo `packages/website/scripts/markdown.ts:357,388`).
  - 35 examples, each with an e2e spec (repo `AGENTS.md:207-221`).
  - 37 lint rules that encode the conventions (repo `packages/oxlint-plugin-foldkit/src/rules/`).
  - A devtools MCP.
- **effect-frame has:** `README.md` (stale "Current state", agent trial #10), `CONTEXT.md` (it defines Server module, Browser entry and Shown branch twice: `:51-57` vs `:179-185`, and `:175-177` vs `:199-201`), 28 design docs, 3 proving apps, and one maintainer skill (`.claude/skills/architecture-loop`). It has no `AGENTS.md`, no consumer skill, no llms.txt and no framework lint plugin. `.oxlintrc.json:9` loads only `oxlint-plugin-effect`.
- **Verdict: adopt.** The lint plugin, `AGENTS.md`, a consumer skill with a blind-spot list, and a view cheat-sheet. Ranked adoption A4.

### 1.11 Other Foldkit designs

- **Named brand errors in type positions** (FK `route/parser.ts:86-89`). effect-frame already uses this style in `Form.Covered` and `Codable` (EF `actor/form.ts:378-380`, `:450-453`), and the trial called it "the right error style". **Adopt more widely.**
  - Trial friction #6: `Route.leaf` should reject `LoadingScope` and `ErroredScope` left in `R`.
  - Trial friction #5: a raw `Source` in a prop position.
- **Explicit keys instead of inferred `keyBy`.** `h.keyed('li')(key, attrs)` takes the key as a value, and lint rules require it (repo `packages/oxlint-plugin-foldkit/src/rules/keyed-required-for-mapped-rows.ts`, `no-array-index-view-keys.ts`). effect-frame's `keyBy: (item) => string` loses inference inline (EF `view/control.ts:12-22`, trial #3). **Adopt:** `For`/`View.list` also accept `key: "id"`, a field name typed as `KeysMatching<Item, string>`, which is not context-sensitive.
- **Scene user-event DSL** (FK `test/scene.ts:1878` `click`, `:2453` `submit`, `test/query.ts` role and label queries) vs `ViewTest` conditions (EF `view/testing.ts:61-80`). **Adopt low priority:** role and label queries for `ViewTest`. Story (FK `test/story.ts`) tests a pure `update` with Commands stubbed. **Rejected (actor-model):** effect-frame already tests behaviors directly through `actor/testing` conformance.
- **Machine reachability** (`unreachableStates`, `deadTransitions`, FK `experimental/machine/machine.ts:704-712`). effect-frame delegates to `effect-machine` (EF `actor/behavior.ts:175-206`). **Out of scope here.** It is an upstream idea for effect-machine.
- **Slow-phase dev warnings** (FK `runtime/slowPhase.ts:42-60`). **Consider later.** The counterpart would be a warning when a handler fiber or a first query settle exceeds a budget. Low value until inspection v2 exists.
- **`inertHtml`, `Submodel`, `OutMessage`, `Subscription`.** **Rejected (actor-model).** They exist to route Messages between nested Models inside one update loop. The effect-frame counterpart is another actor or a view-scope `Source`.

## 2. Summary table

| # | Idea | Foldkit source | effect-frame counterpart | North star | Verdict |
|---|---|---|---|---|---|
| 1a | Closed, typed intrinsic attributes | FK `html/index.ts:578`, `:294`, `:3286` | EF `view/jsx-runtime.ts:174-176`, `:239-241` | explicit, expressive | **adopt** (A2): typed per host through `jsxImportSource` |
| 1b | Event kind fixes the default action (`OnSubmit` prevents) | FK `html/index.ts:1891-1896` | EF `view/view.ts:116-132` (same `Prepared` for both) | explicit | **adopt** (A2): `Prepared<"Submit">` on `form.onSubmit` |
| 1c | Typed event payload per event | FK `html/index.ts:675` and the `OnKey*` entries | EF `view/host.ts:106-115` | expressive | **adopt partly**: DOM typed `onKeyDown` and similar through `Dom.*` handlers. The runtime `HostEvent` stays host-neutral |
| 1d | Escape hatches `Attribute`, `DataAttribute`, `customElement` | FK `html/index.ts:866-867`, `:3220` | none | explicit | **adopt**: `data-*`/`aria-*` template keys and `${string}-${string}` custom tags |
| 1e | `h` builder threaded with a Message universe | FK `html/index.ts:5506-5545` | none | actor-model | **rejected**: routes into a single update (Elm) |
| 2 | One kind rule, one export path | repo `AGENTS.md:18,44,134`; `command-define-pascal-const` rule | EF `view/readiness.tsx:406,450,495,521`; `view/index.ts:27-36`; `view/query-state.ts:27` | explicit | **adopt** (A1) |
| 3 | Commands as values returned from update | FK `command/index.ts:130-262` | EF `actor/command-handle.ts:20-86`, `CONTEXT.md:27-28,99-105` | actor-model | **rejected**: side effects owned by one reducer; admitted commands are not interruptible |
| 4a | Resource keyed on a derived value, held while the key is current | FK `managedResource/managedResource.ts:206-250` | EF `actor/source.ts:190-229` (`Effect.scoped` at `:216`) | effect-native, actor-model | **adopt** (A3): `Source.scoped`/`Source.switchMap` |
| 4b | `modelToMaybeRequirements` over the app Model | FK `managedResource/managedResource.ts:134-153` | none | actor-model | **rejected**: Elm single-model coupling |
| 4c | Typed `.get` failure plus identity in `R` | FK `managedResource/managedResource.ts:13-76` | EF `view/readiness.tsx:123-127` (`LoadingScope` in `R`) | explicit | **already covered** |
| 5a | `Idle` state | FK `asyncData/asyncData.ts:15-16` | `CONTEXT.md:91-93` | declarative | **rejected**: a query exists only when declared |
| 5b | Hand-folded load transitions | FK `asyncData/asyncData.ts:613-660`, `:836` | EF `actor/query-client.ts` (cache owns refresh) | declarative | **rejected** |
| 5c | `Stale`: a failed refresh keeps the data | FK `asyncData/asyncData.ts:27-29` | EF `actor/query-client.ts:474-481` (drops value) | declarative, expressive | **adopt, pending an owner decision** (A6): the `QueryState` Schema is a wire format |
| 6a | Bidirectional routes | FK `route/parser.ts:43-73`, `:546-572` | EF `router/codec.ts:555-568`, `CONTEXT.md:63-65` | explicit | **settled, parity** |
| 6b | Route transition helpers | FK `route/transition.ts:9-146` | `CONTEXT.md:75-77`, EF `router/branch.ts:907` | declarative | **settled, parity** |
| 6c | Lint: no hard-coded route strings | repo `packages/oxlint-plugin-foldkit/src/rules/no-hardcoded-route-strings.ts` | none | explicit | **adopt** (A4) |
| 7a | `Rule` predicate tuples | FK `fieldValidation/rule.ts:6-136` | EF `actor/form.ts:406-407` (one Schema) | effect-native | **rejected**: a second validator beside the contract |
| 7b | Per-field validation state before submit | FK `fieldValidation/fieldValidation.ts:7-24` | EF `actor/form.ts:459-465` (post-refusal issues only) | expressive, explicit | **adopt** (A7): derived from the member's form codec |
| 8a | History, time travel, replay | FK `devTools/store.ts`, repo `packages/devtools-mcp/src/tools.ts:455-467` | `CONTEXT.md:123-125` | actor-model | **rejected** |
| 8b | Schema index, snapshots, diffs for agents | repo `packages/devtools-mcp/src/tools.ts:332-411,478` | EF `inspection.ts:15-22` (revision only) | explicit | **adopt** (A8): index now; snapshot and diff need protocol v2 and an owner decision |
| 8c | Dispatch through devtools | repo `packages/devtools-mcp/src/tools.ts:492-503` | none | actor-model (OK: still the mailbox), explicit | **consider**: named capability plus policy, owner decision |
| 9a | Build id compared before hydration | FK `buildToken.ts:1-22` | EF `router/hydrate.ts:29-40`, `router/document.ts:258` | explicit | **adopt** (A5) |
| 9b | Unique runtime id per root | FK `runtime/hydrationHandoff.ts:56-80` | EF `router/hydrate.ts` (one root) | explicit | **adopt with A5** if more than one root per page is supported |
| 9c | Compiler-stamped view identity | FK `hydrationMarkers.ts:21-81` | EF `view/hosts/dom.ts:298` (ordered claim) | explicit | **rejected**: needs a build plugin convention and solves a problem effect-frame does not have |
| 10 | AGENTS.md, skills, blind spots, llms.txt, scaffold doc | repo `AGENTS.md`, `skills/`, `packages/website/scripts/markdown.ts:357,388` | `README.md`, `CONTEXT.md` (duplicates) | explicit | **adopt** (A4) |
| 11a | Named brand errors | FK `route/parser.ts:86-89` | EF `actor/form.ts:378-380`, `:450-453` | explicit | **adopt more widely** (A2, `Route.leaf` scope check) |
| 11b | Key as a value, not an inferred callback | FK `html/index.ts:3235-3246` | EF `view/control.ts:12-22` | expressive | **adopt**: `key: "id"` field form |
| 11c | Role and label test queries | FK `test/query.ts`, `test/scene.ts:1878` | EF `view/testing.ts:61-80` | expressive | **adopt, low priority** |
| 11d | Story (pure update tests) | FK `test/story.ts` | EF `actor/testing` | actor-model | **rejected** |
| 11e | Submodel, OutMessage, Subscription, inertHtml | FK `html/submodel.ts`, `subscription/` | actors, `Source` | actor-model | **rejected** |

## 3. Top adoptions, ranked

The ranking weighs how many agent-trial mistakes each one prevents against its blast radius.

### A1. One kind rule for view exports (trial #1, #2, #9, part of #8)

- **PascalCase** means a synchronous function that returns a `Node`, so it can be a JSX tag: `For`, `Show`, `Match`, `Portal`, `Query`, `Link`.
- **lowercase** means it returns an `Effect`, so you `yield*` it: `View.loading`, `View.errored`, `View.awaiting` (the rename of `Await`), `View.list`, `View.form`, `View.ready`, `View.orErrored`.

```ts
// before
const node = yield* Loading({ fallback, children: Counter(props) });
// after: case alone tells the reader it is an Effect
const node = yield* View.loading({ fallback, children: Counter(props) });
```

- Delete the flat `bind`/`event`/`submit`/`attach` re-exports (EF `view/index.ts:27-36`). Export the readiness Effects only under `View`.
- The `Loading` collision with `QueryState.Loading` (EF `view/query-state.ts:27`) disappears once the boundary is lowercase.
- `mount` exists in both `view` and `router`: keep `Router.mount` and `View.mount` under their namespaces only.
- Fix the `View.View` doc (EF `view/view.ts:150-152`) to match the apps.
- Breaking change, renames only. Enforce it with one lint rule, which goes into A4.

### A2. Typed intrinsics per host (trial #5, four probe mistakes)

Keep one runtime `jsx`. Give each host its own `JSX` namespace, chosen explicitly with `jsxImportSource`: `effect-frame/dom` or `effect-frame/opentui`.

```ts
type Attr<A> = A | Bound<A>;
interface Prepared<K extends "Event" | "Submit" = "Event"> { readonly _tag: "Prepared"; readonly kind: K; /* … */ }
// View.event → Prepared<"Event">; View.submit and FormBinding.submit → Prepared<"Submit">

interface DomGlobal {
  id?: Attr<string>; class?: Attr<string>; hidden?: Attr<boolean>; tabindex?: Attr<number>;
  attach?: Attached<Element> | ReadonlyArray<Attached<Element>>;
  onClick?: Prepared<"Event">; onInput?: Prepared<"Event">; onKeyDown?: Prepared<"Event">; /* closed list */
  children?: Child;
  [data: `data-${string}`]: Attr<string>;
  [aria: `aria-${string}`]: Attr<string>;
}
interface FormAttrs extends DomGlobal { onSubmit?: Prepared<"Submit">; }
declare namespace JSX {
  interface IntrinsicElements { div: DomGlobal; form: FormAttrs; input: InputAttrs; /* … */
    [custom: `${string}-${string}`]: ElementProps; }   // explicit custom-element hatch
}
```

What this catches, with the Foldkit behaviour it borrows:

- `className`, `onClik` and `<form onSubmit={View.event(...)}>` stop compiling. This borrows Foldkit's closed attribute set (FK `html/index.ts:578`) and event kinds that fix the default action (FK `html/index.ts:1891`).
- A raw `Source` fails against `Attr<string>`, and the error names `Bound`. Add a brand, `{ readonly "wrap with View.bind": Source<A> }`, in the style of `Form.Covered`.
- The same brand style lets `Route.leaf` reject `LoadingScope` and `ErroredScope` left in `R` (trial #6).

### A3. `Source.scoped` and `Source.switchMap` (trial #4, removes two hand-rolled app helpers)

This follows the ManagedResource lifecycle (FK `managedResource/managedResource.ts:220-250`), keyed on a `Source` instead of a Model:

```ts
Source.switchMap: <A, B>(source: Source<A>, f: (a: A) => Source<B>) => Source<B>
Source.scoped: <A, B, E, R>(
  source: Source<A>,
  acquire: (a: A) => Effect.Effect<B, E, R | Scope.Scope>,
  options?: { readonly equivalence?: Equivalence<A> },
) => Effect.Effect<Source<QueryState<B, E>>, never, R | Scope.Scope>
// one child Scope per distinct key; closed when the key changes or the view scope closes
const counter = Source.switchMap(props.data.counter, (ref) => ref.state);
```

It differs from `mapEffect`, which closes its scope per run (EF `actor/source.ts:216`). With `Source.scoped`, a `RemoteActorRef` or socket keyed on route data lives exactly as long as its key. `View.form` should accept the `Source<Ref>` binding, so no `yield* data.x.get` snapshot can go stale.

### A4. Agent surface: lint plugin, AGENTS.md, consumer skill, cheat-sheet (trial #3, #8, #10)

- **`oxlint-plugin-effect-frame`**, modeled on repo `packages/oxlint-plugin-foldkit/src/rules/`. Rules:
  - `view-kind-case` (from A1).
  - `no-flat-view-imports`.
  - `form-submit-needs-submit-kind` (a backstop until A2 lands).
  - `for-key-required`.
  - `no-hardcoded-route-href`.
  - `no-yield-tag`: flags `yield* Show(...)`.
- **Repo `AGENTS.md`.** Naming rules (A1), which fixes CONTEXT's duplicate entries, and exemplar files (the notes app and one core module).
- **A consumer skill**, modeled on `skills/foldkit/SKILL.md`. It pins the vendored source to the installed version and points at the proving apps.
- **A single `blind-spots.md`**, where each slug gets one line of output.
- **A README table** of every view export with its kind, `Route.PropsOf`, and the binding shapes. Delete the stale "Current state" text.
- **`llms.txt`** when a docs site exists.

This needs no runtime change.

### A5. Build id on documents and hydration

Foldkit stamps and compares a build id (FK `buildToken.ts`). The effect-frame form:

```ts
renderDocument({ ..., buildId })           // stamps data-effect-frame-build on the root and in the records script
Router.hydrate({ ..., buildId })           // compares before Dom.hydrate / Streaming.resume
// mismatch → HydrationRefused (Schema.TaggedError) in E; the entry chooses reload or a Route.client render
```

- The id is passed on both sides, never read from a package-internal define. Foldkit gives the reason at `buildToken.ts:14-19`.
- This prevents the resume payload from decoding against a skewed contract.
- It adds a document attribute. Confirm with the owner whether the records script counts as the resume payload under `rejected.md` row 1.

### A6. A failed refresh keeps its value (owner decision, wire)

This borrows Foldkit's `Stale` (FK `asyncData/asyncData.ts:27-29`). A possible shape:

```ts
Ready { value, stale: boolean, refreshFailed: Option<E> }
```

The alternative is to keep the tags and have the cache write `Ready(value, stale=true)` plus a separate `Source<Option<E>>` of refresh errors. The alternative leaves the wire unchanged and is the one to try first. Either way, `Errored` fires only when there is no value.

### A7. Field issues before submit, from the one Schema (trial #7)

```ts
const amount = yield* View.field(binding, "amount"); // { issues: Source<ReadonlyArray<FormIssue>>, check: Prepared<"Event"> }
<input name="amount" onBlur={amount.check} aria-invalid={View.bind(amount.issues, (xs) => xs.length > 0)} />
```

- `View.field` decodes the one field through `Form.codec(member)`: the same codec and the same `FormIssue` shape that a refused post redraws. There is no second validator.
- Also require `M & Form.Codable<M>` and `M extends Member<C>` in `View.form` and `HttpServer.form`.

### A8. Inspection: agent-usable reads

- **Now, read-only.** `effect-frame inspect --contracts` lists each contract's message members and fields, which Foldkit calls `get_message_schema`.
- **Protocol v2, owner decision:**
  - `ActorRecord.snapshot`, encoded with `contract.snapshot`, the way `QueryRecord.value` already is.
  - A dev-side ring of the revisions this client observed, plus a `diff` reader.
- **Optional.** A `send` capability under a named policy.

## 4. Proposed settled comparisons for `prior-art.md`

- Foldkit route biparser vs URLPattern route: parity. Nothing to adopt beyond the lint rule.
- Foldkit Commands-as-values vs `CommandHandle`: rejected, actor-model.
- Foldkit time-travel devtools: rejected, actor-model. Read-only indexes are adopted instead (A8).
- Foldkit `AsyncData` `Idle` and hand folds: rejected, declarative. Only `Stale` is open (A6).
