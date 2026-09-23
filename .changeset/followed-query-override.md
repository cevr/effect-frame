---
"effect-frame": minor
---

`FollowedQuery` has `override`, as `QueryEntry` does, and so does every `Route.query` binding. It acts on the entry the arguments name at the call, and derives its value from that entry's own Ready value (see the function form in `override-derives-from-own-entry`). The value shows at once, marked stale, and any authoritative value replaces it; a command's rejection does not take it back. After a transition moves the binding, an override acts on the new entry, never the one that exited. With no arguments, nothing is written.
