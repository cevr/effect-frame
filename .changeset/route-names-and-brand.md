---
"effect-frame": minor
---

A route is a branded value only the mode constructors make, and it carries its own rendering mode; a hand-written `AnyRoute` no longer type-checks. `mount` and the server document die with `Route.RouteNameRejected` when two routes share a name or one is named `"not-found"`, the router's own route (a user route named `"not-found"` used to be served). `isActive` is deleted: `link(to, params, search).active` says whether the document is on a destination.
