# effect-frame

## 0.6.0

### Minor Changes

- [`a29c9b9`](https://github.com/cevr/effect-frame/commit/a29c9b900e3df3ed4891da62eceb331e23f14234) Thanks [@cevr](https://github.com/cevr)! - Add a scoped view testing harness that observes production host writes, owns
  mounted work, and reports bounded timeout diagnostics.

## 0.5.0

### Minor Changes

- [`d4eed34`](https://github.com/cevr/effect-frame/commit/d4eed349bd528dc1fba51f33adc5c3dd7efb1562) Thanks [@cevr](https://github.com/cevr)! - View-owned URL state with scoped encoded-key claims, canonical URL sources, serialized set and update operations, and explicit push operations.

### Patch Changes

- [`2647ee1`](https://github.com/cevr/effect-frame/commit/2647ee1e574eeb56628717a3e2e5225d8e524b48) Thanks [@cevr](https://github.com/cevr)! - Readiness registrations now leave `Loading` and `Errored` scopes with their owner scope, so removed or disposed view branches cannot keep a boundary pending or failed.

## 0.4.0

### Minor Changes

- [`2bf0bd8`](https://github.com/cevr/effect-frame/commit/2bf0bd8ee1eae2324495558ff83c154bb6c40568) Thanks [@cevr](https://github.com/cevr)! - Add local transport and query-host helpers for testing the real query cache.

## 0.3.0

### Minor Changes

- [`47cdfb0`](https://github.com/cevr/effect-frame/commit/47cdfb06f6dbc209085a0b6cb8e46d99178b3f5d) Thanks [@cevr](https://github.com/cevr)! - Attached behaviours and `Portal`. An element takes `attach={...}`: one or more behaviours, each an Effect given the host node (`Dom.attach((element) => Effect)`, `Tui.attach`), run once the node is in the document, in the scope of the branch or row that owns the element, so a listener, an observer, or a fiber the behaviour opened ends when the element leaves. There is no node reference. The server host never runs a behaviour. `<Portal into={node}>` draws children under another host node, owned by the branch that opened it. Hosts gain one operation, `attach`.

- [`e3ddec5`](https://github.com/cevr/effect-frame/commit/e3ddec54ede6d73bb77e79f9a44ad426e87a8f72) Thanks [@cevr](https://github.com/cevr)! - Add declared batched query contracts with per-key states, HTTP batching, authorization isolation, and single-flight refresh support.

- [`841a233`](https://github.com/cevr/effect-frame/commit/841a2331f1d046c6bb1fae152c3ebd4d9da4b8e6) Thanks [@cevr](https://github.com/cevr)! - Composable DOM behaviours: `Dom.focus(options)`, `Dom.scrollIntoView(options)`, and `Dom.observeSize(onSize)` are attachments a view lists on an element, `attach={[Dom.scrollIntoView({ block: "nearest" }), Dom.focus()]}`, each run once the element is in the document and ended with it. `Dom.afterPaint` is the Effect a behaviour yields when it needs layout first.

- [`c40ed46`](https://github.com/cevr/effect-frame/commit/c40ed46709abd122d78f2da64cb3f799f258c6dc) Thanks [@cevr](https://github.com/cevr)! - `Match`: exhaustive control over a source of a tagged union. `<Match on={state} cases={{ Idle: () => ..., Running: (s) => ... }} />` takes the case table of Effect's `Match.tagsExhaustive`, draws one branch, hands each case a source of its own member, and updates a kept tag in place. `Query` is now one `Match` over `QueryState`. `QueryState.match` takes the same case shape (`Ready: (state) => ...`, not `(value, stale)`) and has a curried form, `match(cases)`, that builds its matcher once for hot paths; `tests/perf/match.bench.ts` records why.

- [`ccf6470`](https://github.com/cevr/effect-frame/commit/ccf6470b26e461df5f65e3872c0f01286955f51d) Thanks [@cevr](https://github.com/cevr)! - Add scoped `Source.debounce`, `Source.throttle`, and `Source.mapEffect` derivations.

- [`8946cbf`](https://github.com/cevr/effect-frame/commit/8946cbf73f994a980b732889af6d834e80dc0db6) Thanks [@cevr](https://github.com/cevr)! - Typed links. `link(route, params, search)` yields a `Link` in a view's setup: the live href printed through the route's own Schemas, `active` (a source, `true` while the document is on that route), and separate `go` (push) and `replace` effects. `<Link link={l} replace class>` draws it as an anchor with a real `href` and `aria-current="page"`. `router.current` is a source of the current match (route name and URL), and `isActive(router, route)` derives from it.

- [`dd95567`](https://github.com/cevr/effect-frame/commit/dd95567ad5d4d51ec6ecf49db87d3c6269a1c0fd) Thanks [@cevr](https://github.com/cevr)! - Schema-driven route search state: omitted defaults, encoded key mapping, repeated values with lossless empty-array markers, string literal and union fields, serialized functional updates, retained keys, and separate push and replace navigation.

- [`c5917f5`](https://github.com/cevr/effect-frame/commit/c5917f51c84d9f993069c6f1c465d4efbcbdb73b) Thanks [@cevr](https://github.com/cevr)! - A view is a function. `View.make` is removed: a view is `(props) => Effect<Node, E, R>`, and a named view is `Effect.fn("Name")(function* (props) { ... })`. Compose a child with `yield* Child(props)`. `Loading`, `Errored`, and `Await` are now plain views: call them with their props and `yield*` the result. `View.list` names its row view `row`, not `setup`. `Route.spa` is renamed `Route.client`.

### Patch Changes

- [`a9d6665`](https://github.com/cevr/effect-frame/commit/a9d666500e0fb39c433a771d6f5c40f7967334bd) Thanks [@cevr](https://github.com/cevr)! - A keyed list (`For`, `View.list`) now moves only the rows whose position changed. Before, every emission re-inserted every row's nodes, which moved them in the document and dropped focus, selection, and scroll inside a row that had not moved.

## 0.2.0

### Minor Changes

- [`8559a4b`](https://github.com/cevr/effect-frame/commit/8559a4b3004d363a7e47e1a6c60c1fb7850534db) Thanks [@cevr](https://github.com/cevr)! - `Cell.make(initial)` is the local value a view keeps: `{ state, get, set, update }`, a `Behavior.value` actor underneath, and a write after its scope closed is a no-op. `Source.all({ a, b })` and `Source.all([a, b])` build one source from several with `zip`'s re-read rule, and `Source.on(source, f)` follows a source on a fiber in the current scope. The combinators are also exported flat (`all`, `on`, `select`, `zip`).

- [`8559a4b`](https://github.com/cevr/effect-frame/commit/8559a4b3004d363a7e47e1a6c60c1fb7850534db) Thanks [@cevr](https://github.com/cevr)! - `View.bind`, `View.event`, `View.submit` and `View.select` are module functions, and `View.Context` and `Capabilities` are gone. `bind` was already data, and a prepared event is now data too: the runtime forks the handler into the scope of the branch or row that owns the element, when the host fires. A plain function that returns a `Node` needs nothing from the view that calls it; a setup that reads no service needs no generator. Migration: delete `const view = yield* View.Context` and replace `view.bind` with `View.bind` (and so on), and drop `View.Context` from any `R` you named.

- [`8559a4b`](https://github.com/cevr/effect-frame/commit/8559a4b3004d363a7e47e1a6c60c1fb7850534db) Thanks [@cevr](https://github.com/cevr)! - Contracts and hosts say less. `query()` defaults `version` to 1, `depends` to none and `policy` to `"public"`, and every host resolves `"public"` without a `QueryPolicies` layer (a table entry of that name still replaces it). `ActorHost.layer` no longer requires `store`: omitted, each actor gets an in-memory mailbox, which is what a query-only host or a test wants.

- [`8559a4b`](https://github.com/cevr/effect-frame/commit/8559a4b3004d363a7e47e1a6c60c1fb7850534db) Thanks [@cevr](https://github.com/cevr)! - `View.list({ each, keyBy, setup })` is a keyed list whose rows run a setup Effect in a scope of their own: a row may make cells, follow queries and add finalizers, and the scope closes when the row leaves. A setup that completes at once builds before the mount returns; one that suspends lands in its place when it completes, and the mount closing interrupts it. `list` is an Effect, not a JSX element, because it captures the context it is yielded in and the enclosing view's `R` names what the rows need. `<For>` is unchanged and is the plain case of the same node.

- [`8559a4b`](https://github.com/cevr/effect-frame/commit/8559a4b3004d363a7e47e1a6c60c1fb7850534db) Thanks [@cevr](https://github.com/cevr)! - `Show` narrows. `when` takes any source with an `is` test (a type predicate narrows), the children may be a function of a source of the tested value that exists only while the branch is shown, and `fallback` draws otherwise. `Query` is the one control for a query's three states: `loading`, `failed(error)` and `ready(value, stale)`, each a source, with no placeholder value to name. `Await` is `Query` as a view and drops `before`. `QueryState` gains `isLoading`, `isReady`, `isFailed` and `match` (also under the `QueryState` name in both entries), and `QueryFailure` is a Schema with an `isQueryFailure` guard, so an `Errored` fallback narrows its `unknown` in one call.

### Patch Changes

- [`8559a4b`](https://github.com/cevr/effect-frame/commit/8559a4b3004d363a7e47e1a6c60c1fb7850534db) Thanks [@cevr](https://github.com/cevr)! - Document that an event handler's write lands after the host callback returns: the handler runs on a fiber of its own, so a script that fires an event and reads an actor in the same tick reads the old value.

- [`8559a4b`](https://github.com/cevr/effect-frame/commit/8559a4b3004d363a7e47e1a6c60c1fb7850534db) Thanks [@cevr](https://github.com/cevr)! - Give `ready`, `readyWithStale`, `orErrored`, `fakeQuery` and `Router.mount` explicit signatures. tsgo emitted their `Effect.fn` generics as unbound type parameters with `unknown` error and requirement types, which made every consumer of the published declarations infer `unknown` and fail to type check.

- [`8559a4b`](https://github.com/cevr/effect-frame/commit/8559a4b3004d363a7e47e1a6c60c1fb7850534db) Thanks [@cevr](https://github.com/cevr)! - A `Show` branch and a `For` row are built untracked inside the effect that switches them, so their first reads no longer trigger Solid's strict-mode untracked-read warning.

## 0.1.0

### Minor Changes

- First published release: actors, queries, views and the router, as proven by the egw-search port.
