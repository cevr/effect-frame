---
"effect-frame": minor
---

`View.lazy` returns a `LazyView<P, E, R>`: a View tagged `"LazyView"` that
carries its import definition. A route reads the definition off the value
it was given instead of looking the function up in a hidden module-level
WeakMap. The `LazyView` type is exported from `effect-frame/view`. Hand a
route the `LazyView` itself: a view wrapped around it is a plain View,
and imports at setup.
