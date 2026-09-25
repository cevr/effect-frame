---
"effect-frame": minor
---

`QueryState` has one owner, `effect-frame/actor/client`, and one path: `QueryState.Loading()`, `QueryState.Ready(value, stale)`, `QueryState.Failed(error)`, `QueryState.isLoading/isReady/isFailed` and `QueryState.match`.

- The flat `Loading`, `Ready`, `Failed`, `isLoading`, `isReady`, `isFailed`, `match` and `markStale` exports of `effect-frame/actor` are removed. Write `QueryState.Ready(value, false)`.
- The `QueryState` namespace of `effect-frame/view` is removed: its schemas, `loading`/`ready`/`failed` constructors (with the hidden `stale = false`), `hasValue` and `held` had no caller. Its test fake is `ViewTest.fakeQuery(initial)`, and it takes its initial state explicitly: `ViewTest.fakeQuery(QueryState.Loading<string, never>())`.
