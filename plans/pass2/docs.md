# Pass 2: agent-DX trial and docs sweep

Area: the docs an app author reads (`packages/effect-frame/README.md`,
`CONTEXT.md`, `AGENTS.md`, `docs/toolchain.md`, `.claude/skills/`), tested
by a fresh agent building one small app. Baseline `d272bd7` (0.27.0).

## Part A: the trial

Scratch workspace:
`/tmp/claude-1000/-home-exedev-Developer-personal/cacfac5c-ac95-4967-a839-81db3553734d/scratchpad/pass2-trial/`
(outside the repo). `node_modules/effect-frame` links to
`packages/effect-frame`, and `effect` and `@types/bun` link to the worktree's
copies. `tsconfig.json` extends the worktree root, which sets
`customConditions: ["source"]` and `jsxImportSource: "effect-frame/view"`,
so imports resolve to `src/` through the package's `source` export
condition. The typecheck command is the worktree `tsc`
(`node_modules/.bin/tsc -p tsconfig.json`), with the Effect language
service loaded.

The app is three files:

- `src/contract.ts` defines the `TodoList` contract (`Add`, `Toggle`), a
  `Behavior.reducer`, and the query `todoCount` (`depends: [TodoList]`).
- `src/todos.server.ts` has `implementTransparent`, and `implementQuery`
  that reads the actor through `Actor.remote`. It also defines the policy
  table and `ActorHost.layer`.
- `src/routes.tsx` defines the segment `/todos`, whose search is
  `filter: all|open|done` with `Route.withDefault("all")` and whose data is
  `Route.actor` plus `Route.query`. It also has `TodosView`, which holds:
  - a local draft `Actor.local(Behavior.value(""))`
  - `onInput`, and a `View.submit` add
  - filter buttons that call `replaceSearch`
  - a `View.list` with a per-row toggle button
  - a `<Show fallback>` for the empty state
  - `todoCount` behind `View.loading`/`View.ready`

It is served with `Route.client`.

### First attempt: errors, and the docs that led there

The first attempt used only the README and CONTEXT.md. It produced 12 tsc
diagnostics from 2 root causes. The draft is kept as
`attempt1-routes.tsx.txt` in the scratch directory.

| # | Error | What I wrote | Why |
| - | ----- | ------------ | --- |
| E1 | `TS2554 Expected 3 arguments, but got 2` at `Source.zip`, followed by 9 errors it caused (`unknown` items, `anyUnknownInErrorContext`, `Source<unknown>` not assignable to `Source<readonly unknown[]>`, `strictBooleanExpressions` on `any`) | `Source.select(Source.zip(a, b), ([x, y]) => …)` | `CONTEXT.md:55` lists `Source.zip` but gives no signature, and the README never uses it. The name comes from Effect, where `Effect.zip` and `Stream.zipLatest` give a tuple. The real signature is `zip(left, right, combine)` (`src/actor/source.ts:126`). |
| E2 | `TS2353 'filter' does not exist in type 'SearchUpdater<…>'` | `props.replaceSearch({ filter: next })` | `README.md:653-656` puts ``a view's `pushSearch` and `replaceSearch`, and a `UrlState`'s `push` and `replace`, which take a value or an updater`` in one sentence. The two do not take the same thing: `pushSearch` and `replaceSearch` take an updater only (`src/router/codec.ts:496-498`). |

Two things compiled with no error and would not have without a guess:

- **Local state.** The README never shows a view's own state. I found
  `Actor.local` only in the `_Code_` line of `CONTEXT.md:22`, and I found
  `Value.Set` from `CHANGELOG.md:26`. An agent limited to the README has
  nothing to go on.
- **A query that reads an actor.** The README's only query returns a
  constant (`README.md:122-124`). I guessed `Actor.remote(TodoList, key, { resume: Option.none() })`
  inside `run`. `apps/notes/src/queries.server.ts:13-16` confirms the
  pattern, calling the two-argument form and adding `Effect.scoped`. That
  `Effect.scoped` is redundant: the host already scopes each run
  (`src/actor/query-host.ts:74,326`). A reader cannot tell either fact from
  the README.

### Fixes after reading the JSDoc and `apps/notes`

- `Source.zip(a, b, combine)`.
- `replaceSearch((search) => ({ ...search, filter }))`.
- `Generated.send(list, { _tag: "Add", text })` in place of
  `crypto.randomUUID()`. I found it in `apps/notes/src/commands.ts`; the
  README shows it only in the plain-forms section, `README.md:900-902`.
- `<Show when fallback>` in place of two `Show`s. `fallback` is in
  `ShowProps` (`src/view/control.ts:94`), but the README table
  (`README.md:509`) lists only `<Show when>`.

### Final state

**The app typechecks: `tsc` exits 0.**

`oxlint` with the repository config reports 2 `effect(noTernary)` errors,
which do not bear on the docs. The finished view has 4 `View.bind`, 3
`View.event`, 1 `View.submit`, 3 `Source.select` and 1 `Source.zip` in 60
lines.

### Seed probes (F1–F5)

| Seed | Reproduced? | Evidence |
| ---- | ----------- | -------- |
| F1 | **Yes** | 12 wrappers in a 60-line view. Every live prop, text and handler is wrapped, and the empty check is a `Source.select` of a `Source.zip` of a `Source.select`. |
| F2 | **Partly** | `send` on a local ref is `Effect<CommandHandle, never>`, so `View.event(() => draft.send(Value.Set(x)))` compiles. `modify(ref, f)` is `Effect<Applied, ActorStopped>`, and in `View.event` it gives `TS2322 'ActorStopped' is not assignable to type 'never'` together with `missingEffectError`. The 0.27.0 changelog (`CHANGELOG.md:26`) says of both `send` and `modify` that "a write after the actor's scope closed fails with `ActorStopped`". That is false for `send`, which reports a `Rejected` handle (`src/actor/actor.ts:34`, `apps/notes/src/commands.ts:24-31`). |
| F3 | **No** | This app nests nothing. `Show` with `fallback` kept the empty state flat. |
| F4 | **Yes** | `export const AboutView = () => Effect.gen(…)` as a leaf view gives `TS377091 … returns a lazy Effect … effect(lazyEffect)`. The notes app works around it with `_props: Route.PropsOf<typeof scratch>` (`apps/notes/src/views.tsx` `ScratchView`). No doc says to do that. |
| F5 | **No** | The scratch `tsconfig` names `jsxImportSource`. F5 only bites a `.tsx` file that is compiled outside that `tsconfig`. `README.md:519-520` documents the per-file pragma for OpenTUI only. |

## Part B: findings, ranked by agent-minutes lost

The fix kind is either **doc** (a change to the docs) or **API** (a change
to the code). "North star" names the principle each fix serves.

### 1. The README never shows a view's own state (~15 min)

- **Where:** `README.md:490-513` ("What a view calls") and the whole first
  app. `CONTEXT.md:22` names `Actor.local` only inside a `_Code_` list.
  Neither doc shows `Value.Set` or `modify`.
- **What went wrong:** "a text input with local state" is the most common
  thing a view needs, and the app reference is silent on it. An agent
  searches for `View.state`, `Cell` (removed in 0.27.0) or a `useState`
  analogue. It finds the answer only in the CHANGELOG or by grepping
  `src/`.
- **Fix (doc):** add a table row, `Actor.local(Behavior.value(initial))` →
  yielded Effect → "a view's own state; read `ref.state`, write
  `ref.send(Value.Set(x))`". Add an example region, a draft input like
  notes' `ScratchView`. Add a glossary line: "A view's own state is a local
  actor".
- **North star:** actor-model, explicit.

### 2. `Source.zip` has an Effect name but not Effect's shape (~10 min, 10 cascading errors)

- **Where:** `CONTEXT.md:55` (`Source.zip, Source.switchMap, ...`), with
  no README use and no combinator table.
- **What went wrong:** `Source.zip(a, b)` looks like `Effect.zip`, which
  returns a tuple. The real signature takes a required `combine`. The
  first error, "Expected 3 arguments", is followed by a cascade of
  `unknown` errors that hides the cause.
- **Fix (API):** give `Source.zip(a, b)` the tuple result, and name the
  combining form `Source.zipWith(a, b, f)`, as Effect and Stream do.
  **Fix (doc):** add a `Source` table to the README: `select`, `zip`,
  `all`, `switchMap`, `debounce`, with their signatures.
- **North star:** effect-native.

### 3. `pushSearch`/`replaceSearch` and `UrlState` are described together; `UrlState` is never shown (~8 min)

- **Where:** `README.md:653-656`, and the first mention of `UrlState` at
  `README.md:655`.
- **What went wrong:** the sentence says these moves take "a value or an
  updater", and the search moves take an updater only. `UrlState` is
  exported (`src/router/index.ts:2`) but appears in no example and no
  glossary entry. A reader cannot tell whether a filter kept in the URL
  belongs in the segment's `search` or in a `UrlState`.
- **Fix (doc):** split the sentence. Add a "state in the URL" example: a
  search codec with `withDefault`, plus `replaceSearch((s) => ({ ...s, filter }))`.
  Say when to reach for `UrlState` instead, or remove `UrlState` from the
  README.
- **Fix (API, optional):** let `pushSearch`/`replaceSearch` take a partial
  value as well, the way `UrlState` does. Then the sentence is true and
  there is one rule.
- **North star:** expressive, explicit.

### 4. A zero-prop view trips `lazyEffect` (F4) (~6 min)

- **Where:** `README.md:14-16` ("A view is a function of its props"). No
  doc covers a page with no props.
- **What went wrong:** `() => Effect.gen(…)` is the natural way to write
  it, and it fails the Effect language service.
- **Fix (doc):** state the rule "a view with no props of its own still
  types them: `(_props: Route.PropsOf<typeof s>)`" beside the rule at
  line 14.
- **Fix (API):** `Route.leaf(segment, effect)` accepts a bare
  `Effect<Node>` for a view that reads no props.
- **North star:** declarative.

### 5. Handlers must be infallible, but `modify` fails where `send` does not (F2) (~6 min)

- **Where:** the README table (`README.md:495`, "an event handler, an
  Effect") never says that the error channel must be `never`. That is
  stated only in the JSDoc at `src/view/view.ts:84-88`.
  `CHANGELOG.md:26` says `send` fails with `ActorStopped`, and it does not.
- **What went wrong:** `View.event(() => modify(n, f))` is refused with
  "`ActorStopped` is not assignable to `never`". The equivalent
  `send(Value.Set(…))` compiles. Two writes to one actor behave in two
  ways.
- **Fix (API):** make `modify`/`derive` on a local reference report a
  stopped actor the way `send` does: a `Rejected` handle, a dead letter,
  and no typed failure. Otherwise the handler type would need an error
  channel that the runtime reports.
- **Fix (doc):** add to the table row "a handler's Effect cannot fail;
  handle failures inside it". Correct the 0.27.0 note in the next
  changeset.
- **North star:** actor-model, explicit.

### 6. A query that reads an actor has no example (~5 min)

- **Where:** `README.md:92-100` and `122-124`.
- **What went wrong:** the reader cannot tell whether `run` may open
  `Actor.remote`, needs `Effect.scoped`, or needs `resume`. The host does
  provide `ActorTransport` and a per-run `Scope` (JSDoc at
  `src/actor/query-host.ts:74`), but only the JSDoc says so. The notes app
  adds a redundant `Effect.scoped`.
- **Fix (doc):** make the counter's `CounterNames` or a todo count read
  its actor: `run: (args) => Effect.flatMap(Actor.remote(C, key), (r) => r.state.get)`.
  Add one line saying "the host gives each run a transport and a scope".
- **North star:** actor-model, explicit.

### 7. Sending through a `Route.actor` binding is two steps (F1-adjacent) (~4 min)

- **Where:** `README.md:657-660`:
  `Effect.flatMap(props.data.counter.ref.get, (ref) => ref.send(message))`.
- **What went wrong:** every row toggle and every submit repeats
  `ref.get` → `send`.
- **Fix (API):** add `FollowedActor.send(message)` and
  `FollowedCommands.send`, which send to the reference the route holds
  now, as `state` already follows it.
- **North star:** actor-model, expressive.

### 8. The README contradicts itself on which PascalCase tags exist (~3 min)

- **Where:** `README.md:17-18`: "A PascalCase JSX tag is one of `For`,
  `Show`, `Match`, `Portal` or `Await`." `README.md:274` and `608` then
  use `<Link>`. `CONTEXT.md:39` says a tag is "a synchronous function or
  an intrinsic name".
- **What went wrong:** an agent that obeys the rule avoids `<Link>`, or
  assumes its own synchronous helper cannot be a tag.
- **Fix (doc):** write the rule as "a PascalCase tag is a synchronous
  function (`For`, `Show`, `Match`, `Portal`, `Await`, the router's
  `Link`); a view is never a tag".
- **North star:** explicit.

### 9. The `<Show>` row hides `fallback` and the narrowing `is` form (~3 min)

- **Where:** `README.md:509`.
- **What went wrong:** the first draft negated a source and drew two
  `Show`s. The JSDoc at `src/view/control.ts:90-116` has `fallback` and
  `is` with render-function children.
- **Fix (doc):** change the row to `<Show when fallback?>` and
  `<Show when is>{(narrowed) => …}</Show>`.
- **North star:** declarative.

### 10. `Generated.send` appears only in the forms section (~3 min)

- **Where:** `README.md:900-902`.
- **What went wrong:** code that creates something from a handler reaches
  for `crypto.randomUUID()`, which compiles, is not idempotent on retry,
  and fails `noGlobals`.
- **Fix (doc):** under "Optimistic commands", or in a new "Sending from a
  handler" section, add: "a message with a generated id is sent with
  `Generated.send(ref, input)`".
- **North star:** explicit.

### 11. The README's links break once the package is published (~3 min for an npm consumer)

- **Where:** `README.md:8-10` (`examples/`, `../../CONTEXT.md`) and every
  `../../docs/design/*.md` link. `package.json` has `"files": ["dist"]`.
- **What went wrong:** the README ships in the npm tarball. The glossary
  and the examples it defers to do not ship, so the links are dead.
- **Fix (doc):** link to the GitHub URLs, or add `examples` and a copy of
  the glossary to `files`.
- **North star:** explicit.

### 12. "binding" has two meanings (~2 min)

- **Where:** `CONTEXT.md:105-108` defines **Binding** as what a
  declaration gives `props.data`. `CONTEXT.md:65` and `README.md:533` also
  say "a `View.form` binding's `submit`". `CONTEXT.md:61` itself warns
  against "Binding" for a bound value.
- **Fix (doc):** say "`View.form`'s result" or "the form's `submit`".
- **North star:** explicit.

### 13. `Route.commandRef` and `Actor.remoteCommands` are two names for one placement (~2 min)

- **Where:** `CONTEXT.md:102` and `README.md:661`.
- **What went wrong:** 0.27.0 renamed `commandRef` to
  `Actor.remoteCommands` (`CHANGELOG.md:14-21`), but the route declaration
  kept the old word. `Route.actor` also pairs with `Actor.remote`, not
  with `Actor.actor`.
- **Fix (API):** `Route.commands(contract, key)`, or
  `Route.remoteCommands`. Align the binding type
  `Route.FollowedCommands`, which already uses "commands".
- **North star:** explicit.

### 14. Terms used before they are defined, and small omissions (~1-2 min each)

- `README.md:1249`: "celld's `defineFrameHost`". `celld` is not defined in
  the README or CONTEXT.
- `README.md:941`: `Behavior.value` first appears in the optimistic
  section, and no section introduces it.
- `README.md:158-160`: "`data` derives each declaration from the params".
  It also receives `search`, which `apps/notes/src/segments.ts` uses; the
  sentence omits it.
- `README.md:495`: `View.event(handler)` does not say that the handler
  receives a `HostEvent` with `.value`. I guessed right, and the only
  mention is `HostEvent.form` at `README.md:927`.
- **Fix (doc):** one clause each.

### 15. `docs/toolchain.md` cites paths on another machine (~1 min)

- **Where:** `docs/toolchain.md:69-73`. They are
  `/Users/cvr/Developer/personal/dotfiles/...`, which `bun run paths`
  cannot check, and the report's date is 2026-09-18.
- **Fix (doc):** point to `~/.claude/skills/project-scaffolding/...` or
  drop them.
- **North star:** explicit.

### Checked and clean

- **Stale 0.27.0 names.** I grepped the five docs for `spawn`, `ref(`,
  `commandRef(` (flat), `Cell`, `layerMemory`, `useQuery`,
  `queryCacheLayer`, `QueryTest`, `layerTest`, `layerLocal`,
  `HttpServer.form`, `toWebHandler`, `HttpTransport.Fetch`, `isActive`,
  `navigate`, `onStatus`, `initialRetryMillis`, `Behavior.Value`, flat
  `batched`, `MissingPolicy`, and `Route.target`. None remain. The one
  0.27.0 inaccuracy is the CHANGELOG's `send` claim, covered in finding 5.
- **Consumer skills.** There are none: `.claude/skills/` holds only
  `architecture-loop`, which is internal. An agent in an app that
  depends on effect-frame has the README alone.
- **`AGENTS.md`** is about changing the repository and is accurate. Its
  lint list (`AGENTS.md:45-56`) omits `effect(noTernary)`, the one lint
  the trial hit.

## Summary for the loop reader

- The trial app typechecked after 2 root-cause errors (E1 `Source.zip`,
  E2 `replaceSearch`) and 2 silent guesses (local state, and a query
  reading an actor).
- The seeds reproduced: F1 (yes), F2 (only through `modify`/`derive`,
  not `send`), F4 (yes). F3 and F5 did not come up.
- The biggest doc gap is local state (finding 1).
- The API changes worth ledgering:
  - `Source.zip` returns a tuple, with `zipWith` for the combining form
    (finding 2)
  - `FollowedActor.send` (finding 7)
  - a stopped local actor is reported the same way by `modify` and `send`
    (finding 5)
  - `Route.leaf` accepts a bare Effect (finding 4)
  - `Route.commandRef` becomes `Route.commands` (finding 13)
