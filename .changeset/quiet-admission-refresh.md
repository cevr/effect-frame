---
"effect-frame": patch
---

Keep dependent query entries stale after an admitted command send until a
committed receipt or an authoritative refresh arrives. Committed duplicate
sends retain their existing refresh behavior without applying the command
again.
