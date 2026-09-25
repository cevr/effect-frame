---
"effect-frame": minor
---

One path to read a query from each place. A view reads a query through its route (`Route.query`); other code follows one with `followQuery` or reads it once with `runQuery`.

- `useQuery` is removed. It was a pass-through to the cache's `open` under a React hook name. Code that needs the raw entry writes `QueryCache.use((cache) => cache.open(contract, args))`.
- The flat `queryCacheLayer` is `QueryCache.layer`.
