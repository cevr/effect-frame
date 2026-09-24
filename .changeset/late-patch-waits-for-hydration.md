---
"effect-frame": patch
---

A streamed patch that the server wrote after its shell, and that the client read before hydration, now waits for hydration where the client claims the server's nodes. A view with no boundary hydrated with a mismatch, and a `Query` kept the loading branch's attributes (`aria-busy`, a skeleton class) since 0.20.1. The server marks such a patch `late: true`. The client holds it until `Resumed.hydrated`, and a readiness boundary (`ready`, `readyWithStale`, `orErrored`) may still draw it ahead through its marks, so `resolvedAhead` counts it as before.
