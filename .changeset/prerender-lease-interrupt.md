---
"effect-frame": patch
---

A `Prerender.load` that fails or is interrupted after it took its lease now releases the lease at once. Before, the lease stayed in the caller's scope until that scope closed, so a server that gave up on a load kept a generation from being cleaned up.
