---
"effect-frame": patch
---

A durable `call` now returns only after the actor's state shows its commit. Before, the reply could arrive while `state.get` and `state.changes` still showed the previous revision, so a read that followed the reply could miss the write.
