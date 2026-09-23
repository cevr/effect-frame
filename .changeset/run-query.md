---
"effect-frame": minor
---

`runQuery(contract, args)` reads one query once, as a value. It declares the key for the length of the read, waits for the first value or failure, and lets go; a failed read fails with its `QueryFailure`. A prerender route's `inputs` read the list its pages come from with it, and in a build that read is shared with every page that declares the same key.
