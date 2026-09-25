---
"effect-frame": minor
---

`View.errored`'s fallback reads a typed failure, `Source<Option<QueryFailure>>`, in place of `unknown`. `View.orErrored` routes a query state whose error is a `QueryFailure`, as every route read and cache entry carries; a `Source.load` state with its own error is drawn with `<Await>` or handled with `View.attempt`. A fallback narrows on `failure._tag` with no `Predicate.hasProperty` check.
