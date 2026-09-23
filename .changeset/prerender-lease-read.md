---
"effect-frame": patch
---

A build whose clean-up cannot read `<out>/leases/` no longer removes held generations. Before, any failure to read the directory counted as "no leases", so clean-up removed the generation a running server had loaded. Now only a missing directory means no leases; any other failure skips that build's clean-up, and the next build removes what is left.
