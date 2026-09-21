---
"effect-frame": minor
---

`Match`: exhaustive control over a source of a tagged union. `<Match on={state} cases={{ Idle: () => ..., Running: (s) => ... }} />` takes the case table of Effect's `Match.tagsExhaustive`, draws one branch, hands each case a source of its own member, and updates a kept tag in place. `Query` is now one `Match` over `QueryState`. `QueryState.match` takes the same case shape (`Ready: (state) => ...`, not `(value, stale)`) and has a curried form, `match(cases)`, that builds its matcher once for hot paths; `tests/perf/match.bench.ts` records why.
