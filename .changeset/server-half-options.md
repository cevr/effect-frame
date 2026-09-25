---
"effect-frame": minor
---

The server half of an actor or a query takes one shape: the contract, then an options object.

- `implementTransparent(contract, behavior)` is `implementTransparent(contract, { behavior })`.
- `implementQuery(contract, handler)` is `implementQuery(contract, { run })`.
- `Query.batched(contract, { resolve })` is `implementBatchedQuery(contract, { resolve })`. The one-member `Query` namespace is removed.
- `query.batched(name, options)` is `batchedQuery(name, options)`: a plain function, not a namespace merged onto `query`.
