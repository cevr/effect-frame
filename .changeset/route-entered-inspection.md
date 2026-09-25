---
"effect-frame": minor
---

`Route.Entered` carries `inspection`, the deepest mounted segment's decoded
params and search (`Route.EnteredValues`). The router reads it off the
mounted route instead of a module-level WeakMap, and the "inspection
unavailable" fallback is gone: every route a mode constructor makes has one.
