---
"effect-frame": minor
---

`Route.drivenView` returns a `Route.DrivenView`: a view tagged
`"DrivenView"` that carries its drive and view. `Route.driven` reads the
drive off the value a leaf was given instead of looking the function up in
a hidden module-level WeakMap. A view wrapped around a `DrivenView` is a
plain view, and `Route.driven` refuses its leaf with `BranchRejected`, as
before.
