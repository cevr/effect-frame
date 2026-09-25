---
"effect-frame": minor
---

`mount` and `hydrate` require `landing` and `traversalReadLimit`. The router no longer defaults to `NavigationBehavior.Restore` and 3 seconds behind the caller's back: `mount({ routes, notFound, host, root, landing: NavigationBehavior.Restore, traversalReadLimit: "3 seconds" })`.
