---
"effect-frame": minor
---

`FollowedQuery` has `override`, as `QueryEntry` does, and so does every `Route.query` binding. It writes the entry the arguments name at the call, stamped with that moment's principal generation. The value shows at once, marked stale, and any authoritative value replaces it; a command's rejection does not take it back. After a transition moves the binding, an override writes the new entry, never the one that exited. With no arguments, nothing is written.
