---
"effect-frame": patch
---

A read that a document's seed calls for (a value the server showed stale or baked at build time, a failure that is not final, `StreamEnded`) now starts when the client runs `Resumed.hydrated`, not when the seed lands. Until then the entry shows what the server drew, so a reply that comes before the client's first drawing no longer draws a newer value against the server's markup. Run `resumed.hydrated` after `hydration.finish`, as the README shows: a client that never runs it never reads those keys again.
