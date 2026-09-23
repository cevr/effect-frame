---
"effect-frame": patch
---

Review round 1 of the seed fix (#22):

- `followQuery`, a route's query binding, `ready` and `readyWithStale` keep their state in one place and move it by one step over the upstream now. A read never runs ahead of `changes`, a late delivery never undoes a newer value, the value shown last stays stale while the next key loads, and an equal value is not emitted twice.
- A patch and a seed carry `stale: true` when the server showed the value stale, and the client seeds it stale, so a view that draws the flag hydrates with no mismatch.
- A server render that brings its drawing to the seed stops at the document's limit, in `AwaitAll`, the streamed shell and `SSR`.
