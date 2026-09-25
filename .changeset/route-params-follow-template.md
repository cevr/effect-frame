---
"effect-frame": minor
---

A segment's params follow its template. The `params` codec must encode exactly the names the segment's own template declares (`Route.ParamNames<Path>`); a misnamed, missing, or extra param does not compile. A child declares only its own params and inherits its ancestors': `Route.child(tenant, "post", { path: "posts/:postId", params: Schema.Struct({ postId: Schema.String }) })` sees `{ tenant, postId }`. `params` is optional when the template declares none. Migrate by dropping every ancestor param a child restates, and `params: Schema.Struct({})` where the template has no param.
