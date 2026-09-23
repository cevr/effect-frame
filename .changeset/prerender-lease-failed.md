---
"effect-frame": minor
---

`Prerender.load` fails with the new `PrerenderLeaseFailed { out, generation, reason }` when it cannot take its lease under `<out>/leases/`. Before, it served the generation unheld, so the next build could remove the files the server was reading. `load`'s error type now includes `PrerenderLeaseFailed`, which is exported from `effect-frame/router/prerender`.
