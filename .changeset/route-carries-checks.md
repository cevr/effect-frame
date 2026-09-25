---
"effect-frame": minor
---

A route value carries its checks, and a copy of it keeps them. Before, a spread of a route whose segment had `before` (`{ ...route, enter }`) mounted without its checks: a guarded page became an unguarded one. `Route.AnyRoute` gains a symbol-keyed field for the checks, a `Route.prerender` tree carries its build plan the same way, a `Route.driven` tree its driven-leaf resolver, and a `Route.inputs` value its enumeration. None of the symbols is public, so no call site changes.
