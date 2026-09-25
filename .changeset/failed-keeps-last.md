---
"effect-frame": minor
---

A failed refresh keeps the value it replaced. `QueryState.Failed` carries `last: Option<A>` beside `error`: `Some` of the value the entry held before the refresh failed, `None` after a first read failed or after `Unauthorized`. The state is still `Failed`, so `View.errored` still trips; `<Await failed={(error, last) => …}>` can draw `last`. `QueryState.Failed(error, last)` takes the held value, `QueryFailedState<A, E>` takes the value type, and `Source.load` shows a kept value stale while the next load runs. The wire is unchanged: a streamed failure seeds `None`.
