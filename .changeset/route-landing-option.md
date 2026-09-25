---
"effect-frame": minor
---

The navigation option is `landing`, not `behavior`: `Route.leaf(segment, view, { landing: NavigationBehavior.Preserve })` and `mount({ ..., landing })`. `behavior` on the route surface now means only an actor's reducer (`Route.actor(contract, key, { behavior })`).
