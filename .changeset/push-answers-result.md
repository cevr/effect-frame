---
"effect-frame": minor
---

`router.push` and `router.replace` answer a `NavigationResult` (exported from `effect-frame/router`): `Committed` with the final URL after any redirect, `Unchanged` when nothing moved (a same-URL request, a redirect back, a stale route instance, a superseded prompt), or `Stayed` when a leave check kept the page. A mounted route's own `Route.RouteNavigation` answers the same way. A request to a router that has closed is interrupted instead of succeeding with nothing: it reached no result. The test-only receipt table the router kept beside each service is gone.
