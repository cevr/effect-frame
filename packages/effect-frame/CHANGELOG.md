# effect-frame

## 0.2.0

### Minor Changes

- `Cell.make(initial)` is the local value a view keeps: `{ state, get, set, update }`, a `Behavior.value` actor underneath, and a write after its scope closed is a no-op. `Source.all({ a, b })` and `Source.all([a, b])` build one source from several with `zip`'s re-read rule, and `Source.on(source, f)` follows a source on a fiber in the current scope. The combinators are also exported flat (`all`, `on`, `select`, `zip`).

- Contracts and hosts say less. `query()` defaults `version` to 1, `depends` to none and `policy` to `"public"`, and every host resolves `"public"` without a `QueryPolicies` layer (a table entry of that name still replaces it). `ActorHost.layer` no longer requires `store`: omitted, each actor gets an in-memory mailbox, which is what a query-only host or a test wants.

- `View.list({ each, keyBy, setup })` is a keyed list whose rows run a setup Effect in a scope of their own: a row may make cells, follow queries and add finalizers, and the scope closes when the row leaves. A setup that completes at once builds before the mount returns; one that suspends lands in its place when it completes, and the mount closing interrupts it. `list` is an Effect, not a JSX element, because it captures the context it is yielded in and the enclosing view's `R` names what the rows need. `<For>` is unchanged and is the plain case of the same node.

- `Show` narrows. `when` takes any source with an `is` test (a type predicate narrows), the children may be a function of a source of the tested value that exists only while the branch is shown, and `fallback` draws otherwise. `Query` is the one control for a query's three states: `loading`, `failed(error)` and `ready(value, stale)`, each a source, with no placeholder value to name. `Await` is `Query` as a view and drops `before`. `QueryState` gains `isLoading`, `isReady`, `isFailed` and `match` (also under the `QueryState` name in both entries), and `QueryFailure` is a Schema with an `isQueryFailure` guard, so an `Errored` fallback narrows its `unknown` in one call.

### Patch Changes

- Document that `View.Context` is in scope for every setup, a child's included, so capabilities never travel through props, and that an event handler's write lands after the host callback returns.

- Give `ready`, `readyWithStale`, `orErrored`, `fakeQuery` and `Router.mount` explicit signatures. tsgo emitted their `Effect.fn` generics as unbound type parameters with `unknown` error and requirement types, which made every consumer of the published declarations infer `unknown` and fail to type check.

## 0.1.0

### Minor Changes

- First published release: actors, queries, views and the router, as proven by the egw-search port.
