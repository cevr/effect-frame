---
"effect-frame": patch
---

A server drawing shows every value its seed carries (#22). An `AwaitAll` document, a streamed shell, and an `SSR` document could draw a value older than the seed, for example "searching…" from a `followQuery` view with no `Loading` boundary while the seed carried the results. The client then drew the results, and hydration did not agree.

- A source's `get` is its value now. `followQuery`, a route's query binding, `ready`, `readyWithStale`, `orErrored` and a readiness scope read their upstream in `get` and do not return a copy that a fiber moves.
- The HTML host reads its records, brings every binding to its source's current value, and reads the records again until the two reads agree. A new optional `Host` capability, `sourceBound`, tells a host of each source the runtime binds.
