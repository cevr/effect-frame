# Architecture pass 2: view, hosts, the `.tsx` authoring surface

Tree: `~/Developer/personal/.worktrees/effect-frame-arch-pass2` (HEAD `d272bd7`, effect-frame 0.27.0). I edited no repo file.

- Consumer receipt: bible-tools `apps/egw-search/src/app.tsx` at `4008b04a`.
- Probes are in `scratchpad/pass2-view/`, under `/tmp/claude-1000/-home-exedev-Developer-personal/cacfac5c-ac95-4967-a839-81db3553734d/`. The repo's `tsc` (7.0.2 with the Effect language service) checked each `.tsx` probe. `hop.tsx` and `isfn.ts` ran with Bun 1.4.2 (`bun --conditions=source`) and started no server.
- Counts are `p/a/t` (packages/apps/tooling). The helper `scratchpad/cnt.sh` runs `rg -c` over the three trees, excluding `dist` and `node_modules`.

## Summary

| ID | Candidate | North star | Public API | Risk | Verdict |
| --- | --- | --- | --- | --- | --- |
| W1 | `View.event` and `View.submit` also take an Effect | expressive | yes, additive | low | propose |
| W2 | `Bound` keeps its projection, so a row's projected binding paints in the same flush as its list | declarative | yes, type shape only | low-med | propose (defect receipt) |
| W3 | One subscription per Source within a mount | declarative vs effect-native | no | med | owner question |
| W4 | `View.show` and `View.match`: a conditional whose branch runs a setup (P6) | declarative, explicit | yes, additive | low | propose |
| W5 | `View.make(name, view)`: one form, a span, no `lazyEffect` conflict | explicit vs expressive | yes | med (breadth) | owner question |
| W6 | A Portal on a host that cannot draw it fails silently | explicit | yes | med | owner question (shape) |
| W7 | Flaky `streaming.test.tsx`: the test orders patches by wall-clock sleeps | explicit | no | low | propose (test only) |

No candidate changes a wire or stored format.

---

## Q1 / F1: the most concise explicit form of a live prop and a handler

### What the code does today

- `View.bind(source, project?)` is a plain function (`packages/effect-frame/src/view/view.ts:96-105`). With a projection, it stores `Source.select(source, f)` (`view.ts:104`).
- `View.event(handler)` and `View.submit(handler)` take a `Handler = (event: HostEvent) => Effect<unknown>` (`view.ts:88`, `:120`, `:132`).
- A raw `Source` or a raw function in a slot is refused with a named error (`intrinsics.ts` `SourceNeedsBind`, `HandlerNeedsEvent`).

Caller counts:

| Pattern | p/a/t |
| --- | --- |
| `View.bind(` | 275/47/2 |
| `View.event(` | 52/12/6 |
| `View.event(() =>` (a handler that ignores its event) | 38/8/6 |
| `View.event((x) =>` (a handler that reads its event) | 3/4/0 |
| EGW `app.tsx` | 11 `View.event`, 10 of them `() =>`; 25 `View.bind` |

About 90% of handlers ignore the event. Each one wraps an Effect that already exists in a thunk: `() => addPane`, `() => props.onPick`, `() => results.refresh`.

### Options weighed

| Option | Verdict | Receipt |
| --- | --- | --- |
| **`View.event(effect)`: an Effect is also accepted as the handler (W1)** | **adopt** | Probe `f1.tsx`. An Effect is a description, so running it once per event is exactly what the thunk did. The `Prepared` marker and its kind stay at the call site. |
| An Effect straight in the prop: `onClick={addPane}` | reject (explicit) | It hides the handler kind. `Prepared<"event">` versus `Prepared<"submit">` is how a form's `onSubmit` refuses a native post (README "JSX"). Probe `f1.tsx:33` keeps it refused. |
| Method style: `source.pipe(View.bind(f))` | reject (expressive, explicit) | `Source` has no `pipe` (`actor/source.ts:14-17`). A data-last dual in a JSX prop position lost inference in pass 1 (V5, `plans/pass1/view.md` "V5"). The result is also longer than `View.bind(source, f)`. |
| `Source` makes its own `Bound`: `count.bind(String)` | reject (one concept, two owners) | `actor/client` would own a view marker. `Source` is a structural interface that callers write as literals (`tests/view/streaming-fixture.tsx` `Moving`: `{ get, changes }`), so every literal would need the method. |
| Drop `Source.select` inside props where `View.bind` projects | style only | `View.bind(Source.select(x, f))` appears 9/0/0 times, all in tests (for example `tests/view/dom.test.tsx:146,160`). After W2 the two-argument form is also the faster one, so write it that way. EGW's `Reference({ refcode: Source.select(...) })` passes a Source to a sub-view's props, not to a bind, so it stays. |

`View.bind(source, project)` already names the source and the projection with nothing extra. No shorter form keeps both explicit. It stays as it is.

### W1 design (proved in `f1.tsx`)

```ts
interface Event {
  (handler: Handler): Prepared<"event">;
  (effect: Effect.Effect<unknown>): Prepared<"event">;
}
```

Probe results:

- `event((e) => … e.value …)` still infers `e: HostEvent`.
- `event(addPane)` compiles.
- A raw Effect, a raw function, and a raw Source in a slot are each still refused (`@ts-expect-error` holds).
- `event(Effect.fail("boom"))` is refused with TS2769 plus `missingEffectError`, the same way a failing `Handler` is.
- At run time an Effect is not a function: `isfn.ts` prints `Predicate.isFunction(e) === false` for `Effect.void`, `Effect.gen`, `Effect.flatMap` and an `Effect.fn` result. So `event` normalizes with `Predicate.isFunction` and needs no ternary.

EGW before and after:

```tsx
// app.tsx:232
onClick={View.event(() => addPane)}
onClick={View.event(addPane)}

// app.tsx:389 (and :436)
onClick={View.event(() => props.onPick)}
onClick={View.event(props.onPick)}

// app.tsx:328
onSubmit={View.submit(() => Effect.flatMap(draft.get, search))}
onSubmit={View.submit(Effect.flatMap(draft.get, search))}

// unchanged: already minimal and explicit
data-count={View.bind(count, String)}
```

| Field | Value |
| --- | --- |
| Files | `view/view.ts:120-137` (`event`, `submit`), README "What a view calls", the `Prepared handler` entry in CONTEXT.md |
| Lines removed | 0 in src (about +6). At call sites, `() =>` goes from up to 38/8/6 sites plus 10 in EGW. |
| Risk | low. A thunk that read mutable JS state at click time would behave differently, but a view holds no such state (its state is actors). |
| Public API change | yes, additive; needs a changeset |
| Wire or stored format | no |

---

## Q4 (carry-over): one subscription per Source, and why `#open` painted ahead of its row

### Root cause, reproduced

`tracker.track` (`view/runtime.ts:783-825`) has two paths:

- **Fast path:** a signal-backed source (a `For` row's item, or a `Show`/`Match` branch's value, made by `signalSource` at `runtime.ts:93`) is read straight from the graph (`runtime.ts:784`).
- **Slow path:** any other source gets a forked fiber over `source.changes` (`runtime.ts:795`).

`View.bind(item, f)` stores `Source.select(item, f)` (`view.ts:104`). That object carries no `SignalBacked` symbol, so a projected binding of a row item takes the slow path through four layers: `signalSource.changes` (`Stream.callback`), then a `createRoot` + `createRenderEffect`, then a queue, then a fiber and a cell. That is one extra scheduler turn.

The scratch run `hop.tsx` (a recording host, one local actor, one keyed row, one write) gives the same result on three of three runs:

```
turn 1: sibling, projected: fulfilled     <- View.bind(rows, f), sibling of the For
turn 1: fulfilled                         <- View.bind(item)     (raw, fast path)
turn 2: row, projected: fulfilled         <- View.bind(item, f)  (projected, slow path)
```

This is exactly the CI failure that f476010 papered over:

- `#open` is `View.bind(rows, f)` (`apps/dashboard/src/overview.tsx:79`), which paints on turn N.
- The row text is `View.bind(order, (value) => …status…)` (`overview.tsx:60`), which paints on turn N+1.

The framework did not keep "its contract" by design. The projection simply threw away the fast path.

How often this happens:

- Projected binds (`View.bind(x, f)`) number 182/40/1. Unprojected binds number 81/6/0.
- Every projected bind of a row or branch value pays one fiber, one queue, and one Solid root.
- `tooling/dom-bench/src/fixtures/effect-frame.tsx:92` pays this on every one of 10k rows.

### W2: `Bound` keeps its projection

**Change:**
- `Bound<A>` becomes `{ _tag: "Bound"; source: Source<unknown>; project: (value: unknown) => A }`, and `bind` without a projection stores the identity.
- The runtime tracks `bound.source` and projects inside the graph: `() => bound.project(accessor())`. This applies at the two readers of `Bound.source`, `runtime.ts:943` and `runtime.ts:1430`. No other reader exists: `rg '\.source\b' packages/effect-frame/src` finds only those two and `view.ts`.
- The seed catch-up (`sourceBound`, `runtime.ts:803-822`) compares the root value, which is still correct.

| Field | Value |
| --- | --- |
| North star | declarative. A binding the author wrote paints with the value it projects. No hidden per-binding fiber decides the order. |
| Files | `view/view.ts:13-16,96-105`; `view/runtime.ts:943,1430` |
| Lines removed | about 2 (+6) |
| Risk | low-med. The projection now runs in a Solid computation rather than in a fiber: it is pure either way. |
| Public API change | yes, but only the type shape of `Bound` (no caller builds one; `_tag: "Bound"` is written only at `view.ts:103-104`). Needs a changeset. |
| Wire or stored format | no |
| Test | A red test in `tests/view/` built on `hop.tsx`: a row's projected bind and its list's sibling repaint in one flush. The dashboard settle at `apps/dashboard/tests/single-flight.test.tsx:78-85` stays valid, because Revenue and Orders are two queries. |

W2 fixes only `View.bind`. A `Show` or `For` over a *derived* source inside a row still takes the slow path, for example EGW `HitRow`'s `Source.zip(props.row, …)` (`app.tsx:836`). Resolving `Source.select` or `Source.zip` chains to their root would need `actor/source.ts` to carry a derivation description. That belongs to the actor sweep and is noted, not proposed.

### W3: one subscription per Source within a mount (owner question)

**Design:**
- The tracker holds a map keyed by Source identity (by reference, not by `Equal`, since v4 compares plain objects structurally).
- Each entry holds `{ accessor, refs, fiber }`. The first `track` forks the subscription into the **mount** scope. Each consumer's scope adds a finalizer that decrements `refs`, and the last one interrupts the fiber.
- Effect's `RcMap` is the effect-native tool, if keyed by reference.
- Cost: about +35 lines in `makeTracker` (`runtime.ts:769-907`), and fewer fibers.

**The trade:** today a branch's subscription lives in the branch's scope (`Tracker.owned`, `runtime.ts:218-221`). W3 moves its lifetime to a refcount. That trades scope-structured lifetime (effect-native) for a flush promise (declarative). Per the north-star rule, the owner decides.

**Is the promise worth making?**
- After W2, the only known receipt (f476010) is explained by the row hop, not by sibling subscriptions.
- W3 would promise only "bindings of one Source *value* paint in one flush". Two `Source.select` calls on the same source are two values, so the promise is narrow.
- Recommend: apply W2, and hold W3 until a receipt that W2 does not explain.

---

## Q2 / F3: flattening `Show`/`For` nesting

**Receipts:**
- EGW `Reference` (`app.tsx:807-827`) is a `Show` inside a `Show`, three levels of render functions.
- `HitRow` (`app.tsx:831-892`) is not deep. Its friction is five `Show when={state} is={…}` over one zipped source, plus the `keyBy={(p: Paragraph) => …}` annotations. `f1.tsx` shows those annotations are no longer needed now that `select` has one signature (pass 1 V5). The same annotations appear 12/4/0 times.

**Options:**

| Form | Verdict |
| --- | --- |
| **`<Match>` over a tagged projection (exists today)** | **Adopt as guidance: no framework change.** One source, one exhaustive case table, one level (probe `f3.tsx`). |
| `Show` with an `else` slot | Already exists as `fallback` (`control.ts:94`). It does not remove the nesting, which comes from narrowing two sources. |
| `View.keyed` | For remount on a new identity, not for branching. |
| Solid `Switch`/`Match` (`solidjs/solid` `packages/solid/src/render/flow.ts:167`) | Reject (explicit). The first true `when` wins, so the priority is the order of the children and the table is not exhaustive. effect-frame's `Match` is exhaustive over `_tag` (`control.ts:160-162`), which is the explicit version of the same idea. |
| Foldkit `html` | Not applicable. Foldkit re-runs the view per model, so a branch is a plain `Option.match` (`foldkit examples/weather/src/main.ts:156`). effect-frame's setup runs once, so a branch needs a tag that owns a scope. |

`Reference` before and after (both compile in `f3.tsx`):

```tsx
// before: app.tsx:807-827
<Show when={props.refcode} is={isPresent}>
  {(refcode) => (
    <Show when={props.url} is={isPresent} fallback={<span class={props.class}>{View.bind(refcode)}</span>}>
      {(url) => <a class={props.class} href={View.bind(url)} …>{View.bind(refcode)}</a>}
    </Show>
  )}
</Show>

// after: one tagged projection, one exhaustive table
const cite = Source.select(state, (s) => citeOf(s.hit)); // Missing | Unlinked | Linked
<Match on={cite} cases={{
  Missing: () => <></>,
  Unlinked: (c) => <span class={props.class}>{View.bind(c, (x) => x.refcode)}</span>,
  Linked: (c) => <a class={props.class} href={View.bind(c, (x) => x.url)} …>{View.bind(c, (x) => x.refcode)}</a>,
}} />
```

It is also one subscription where the old form had two, because `Reference` took two `Source.select` props.

---

## Q5 (carry-over) P6 / W4: a conditional that hosts a view

P5 (remount on a key) is done: `View.keyed`, `control.ts:82-87`. P6 is still open.

**Receipts:**
- CONTEXT.md:237 says "A hidden branch does not exist: it holds no node and observes no source".
- EGW breaks that rule. `const region = yield* ResultsRegion(...)` (`app.tsx:309`) runs its setup, including `Actor.local` and `Source.on(results.settledState, …)` (`app.tsx:725`), before and outside the `<Show when={params} is={hasQuery}>` that hides it (`app.tsx:350-356`). It stays subscribed while the pane has no query.
- The dashboard fakes a conditional with a list over `[]` or `["funnel"]` (`apps/dashboard/src/overview.tsx:165-175`).

**Change:** two Effects on `View`, siblings of the tags, each built over `View.keyed`:

- `View.match(on, cases)`: `keyed(on, (v) => v._tag, (s) => Effect.flatMap(s.get, (v) => table[v._tag](s)))`.
- `View.show({ when, content, fallback? })`: keyed by `"shown"` or `"hidden"`.

A new tag reruns the setup. A new value under the same tag updates in place through the row source, as the `<Show>` and `<Match>` tags do. The type of `View.match` is proved in `f3.tsx`: `R` is inferred with a `never` default, and a missing case is refused.

This gives one rule: control flow whose branch runs a setup is an Effect on `View` (`list`, `keyed`, `show`, `match`), and a tag takes `Node` children only.

```tsx
// EGW Pane, after
const results = yield* View.show({
  when: Source.select(params, hasQuery),
  content: ResultsRegion({ params, results: …, search, refine }),
  fallback: Effect.succeed(Empty({ params, nonSelective: false, search, refine })),
});
```

| Field | Value |
| --- | --- |
| North star | declarative, explicit |
| Files | `view/control.ts`, `view/namespace.ts`, README table |
| Lines removed | 0 in src (about +25). Dashboard `overview.tsx:165-175` loses about 5. |
| Risk | low (both are built over `keyed`) |
| Public API change | yes, additive; needs a changeset |
| Wire or stored format | no |

---

## Q3 / F4: `lazyEffect` against a view with no props

**What the router and mount accept today:**
- `Route.leaf` takes `view: (props: SegmentProps<…>) => Effect<Node, E, R>` (`router/branch.ts:1330-1352`), so a zero-argument arrow is assignable.
- `View.mount` takes `View<Props, E, R> & ScopesClosed<R>` and requires `props` (`view/runtime.ts:1846-1851`).
- Neither accepts a bare `Effect<Node>`.

The rule text (`@effect/tsgo` README): "avoiding exported zero-argument functions … that lazily return Effect".

Probe results (the Effect language service run through `tsc`):

| Form | lazyEffect | Probe |
| --- | --- | --- |
| `export const P = () => Effect.gen(...)` | flagged | first probe run (not kept; see `f4.tsx` for the accepted forms) |
| `export function P() { return Effect.gen(...) }` or `() => Effect.succeed(...)` | flagged | same |
| `export const P = (_props: Route.PropsOf<typeof seg>) => …` (EGW today) | ok | `f4.tsx` 1 |
| `export const P: View.View<Props, never, never> = () => …` | ok, but `E` and `R` must be written by hand | first probe run |
| `View.make("P", () => Effect.gen(...))` | ok; `Route.leaf` accepts it | `f4.tsx` 2 |
| `View.make("Pane", (props: {…}) => …)` | ok; props inferred, a wrong prop is refused | `f4.tsx` 3 |

Views that type props they ignore: `_props:` 49/4/0, `NoProps` 34/0/0.

**Options:**

1. **`View.make(name, view)`** returns `(props) => Effect.withSpan(view(props), "View.<name>")`.
   - It is the only option that keeps one form, gives a span, and ends the conflict.
   - It reverses D4 (ledger "D4: a view is `(props) => Effect.gen`"), and every view gains a wrapper.
   - Explicit (a named span; the inspection tree has no per-view name today) against expressive (a wrapper per view). **Owner question.**
2. **Doc only.** "A view names the props it is given; a leaf's are `Route.PropsOf<typeof segment>`." This is what EGW does, and it is honest, because the router always passes props. It gives no spans. This is the recommendation if the owner declines option 1.
3. **Accept `Effect<Node>` as a leaf view.** Rejected (explicit): it creates two shapes for one concept and a branch on the shape in `Route.leaf`, `View.mount`, and `View.lazy`.
4. **Recommend `Effect.fn`.** Rejected: D4 moved away from it (pass 1 trial friction 8), and `frame/span-name` wants `Area.operation`.

---

## Q5 (carry-over) W6: `Portal.into` typed per host

**Receipts:**
- `PortalProps<HostNode>.into` takes whatever the call infers (`control.ts:189-205`). `PortalNode.into: unknown` (`jsx-runtime.ts:94`). The runtime casts it (`runtime.ts:1544`, `as HostNode`).
- Callers are tests only (`tests/view/dom.test.tsx:249`, `tests/view/listener-ownership.test.tsx:180`); 0 app callers.

**A guard gap the typing hides:**
- On the HTML host, `insert` returns silently when the parent is not an HTML node (`hosts/html.ts:303`). A Portal in a server-rendered view draws nothing and says nothing.
- On the Remote host, `insert` records `parent: parent.id` (`hosts/remote.ts:467-474`), which is `undefined` for a DOM element.

**Typing per host is not possible as the tree stands.** The tree is host-erased on purpose: `Attached<unknown>` is a method so that a tree can hold one (`view.ts:140-145`).

**Proposed:** `into` takes a `PortalTarget` that only a host module constructs (`Dom.target(element)`, and the OpenTUI entry's `target(renderable)`). The runtime refuses, with a defect naming the host, a target the host did not make. The HTML and Remote hosts make none, so a Portal fails loudly there.

**Owner question:** should a server render instead draw portal children in place, or at the end of the body? That decides the shape. Risk med. Public API change yes. Wire no. The design came from `docs/design/dx-review-2.md:110-117` (B6), so the tag stays.

---

## Q5 (carry-over) W7: the flaky streaming test, root cause by reading

The test is `packages/effect-frame/tests/view/streaming.test.tsx:173` ("a placeholder always precedes its patch, and Closed lists every settle"). The failure was "5 … 4". That reads as the assertion at `:197`:

```ts
expect(positionOf(html, "Patch", idOf("c"))).toBeLessThan(positionOf(html, "Patch", idOf("b")))
```

The record indices are placeholders a, b, c at 0-2, `Patch a` at 3, and the next two at 4 and 5. So `Patch c` landed at 5 and `Patch b` at 4.

**Cause:**
- The test assumes the shell is read within 20 ms (`:181-184`: sleep 20 ms, release c, sleep 20 ms, release b).
- `Streaming.shell` reads each entry once the drawing agrees with its records (`hosts/html.ts:247-255`, `readDrawn`). Every entry that settled by then goes into `settled` in **declaration order** (`actor/streaming.ts:235-238`), not settle order. Only entries still open are patched later, in settle order (`streaming.ts:251-256`).
- When the shell takes more than 40 ms on a loaded CI runner (the prior test in the file runs `Bun.build`), both b and c settle before the read. The first chunk then writes `Patch b` before `Patch c`.

The framework keeps its written contract: `ShellRecords.settled` promises no order (`streaming.ts:208`). The test depends on wall-clock time.

**Fix (test only):** drive the stream by observed conditions instead of sleeps:
1. Pull the first chunk, the one that holds `bootstrap`, from a forked consumer (as the first test in the file does with a reader).
2. Release c, and pull until `Patch c` appears.
3. Release b, and collect the rest.

| Field | Value |
| --- | --- |
| North star | explicit (the test waits on what it asserts) |
| Files | `tests/view/streaming.test.tsx:173-213` |
| Lines removed | about 4 sleeps (+10) |
| Risk | low |
| Public API change | no |
| Wire or stored format | no |

The same 20 ms pattern at `:271`, `:432` and `:471` should be checked in the same commit.

---

## Q6: other things in scope

- **F2 (cross-reference, not a view candidate).** `Handler` has no error channel by design (`view.ts:84-88`). Widening it to admit `ActorStopped` would hide a failure (explicit), so that is rejected. The catch sites (`catchTag("ActorStopped")` 3/0/2, EGW `whileMounted` at `app.tsx:79`) belong to the actor sweep: a local actor lives in the view's scope, and its handler fibers are interrupted when that scope closes (`runtime.ts:1490`, `tracker.handle`).
- **F5 and T1** are not in this report's scope.
- **No findings, receipts checked:**
  - Module-level mutable state in `src/view`: the only `let` at module level is `lazy.ts` `state`, which is documented and kept (pass 1 V10).
  - Promise: `lazy.ts:105` `() => Promise<Module>` is the dynamic `import()` edge.
  - Per-mode or per-host branch in a view: none in EGW, `apps/notes/src`, or `apps/dashboard/src`.

## Not worth a pass (style, under about 5 lines each)

- `view/jsx-runtime.ts:98-103`: an orphaned JSDoc above `BoundaryKind` that still names the removed `Loading`/`Errored` Effects (now `View.loading`/`View.errored`).
- `view/runtime.ts:1366-1373`: the `classify` doc stacked above `isMarker`'s.
- `View.bind(Source.select(x, f))` (9/0/0, tests only) → `View.bind(x, f)`. After W2 it is also the fast path in `Show`/`Match` branches (`tests/view/dom.test.tsx:146,160`).
- EGW `keyBy={(row: Row) => …}` annotations (`app.tsx:222,760,870,880`; 12/4/0 across the repo): no longer needed, per `f1.tsx` `Rows`. App-side only.
- `PreparedKind`, `PlainPost`, `EventHandler`, `HtmlElements` have no user outside `src/view` (only `CHANGELOG.md` names them). Keep them: each is part of a public interface's signature (`Prepared`, `Host`, `JSX`).

## Ledger rows

| ID | Candidate | North star | Files | Lines removed | Risk | Status |
| --- | --- | --- | --- | --- | --- | --- |
| W1 | `View.event`/`View.submit` take an Effect (F1) | expressive | view.ts, README, CONTEXT | 0 (+6); `() =>` at ≤38/8/6 sites | low | proposed |
| W2 | `Bound` keeps its projection; projected row binds take the signal path | declarative | view.ts, runtime.ts | ~2 (+6) | low-med | proposed (defect: `hop.tsx`) |
| W3 | One subscription per Source within a mount | declarative vs effect-native | runtime.ts | 0 (+35) | med | owner question |
| W4 | `View.show`, `View.match` (P6) | declarative, explicit | control.ts, namespace.ts | 0 (+25) | low | proposed |
| W5 | `View.make(name, view)` (F4) | explicit vs expressive | view.ts, every view | - | med | owner question |
| W6 | Portal target made by the host; refuse on HTML/Remote | explicit | control.ts, runtime.ts, hosts | ~2 | med | owner question |
| W7 | Streaming record-order test waits on chunks, not sleeps | explicit | tests/view/streaming.test.tsx | ~4 | low | proposed |
