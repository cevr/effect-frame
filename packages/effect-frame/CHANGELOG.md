# effect-frame

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
