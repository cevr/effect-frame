---
"effect-frame": minor
---

A view is a function. `View.make` is removed: a view is `(props) => Effect<Node, E, R>`, and a named view is `Effect.fn("Name")(function* (props) { ... })`. Compose a child with `yield* Child(props)`. `Loading`, `Errored`, and `Await` are now plain views: call them with their props and `yield*` the result. `View.list` names its row view `row`, not `setup`. `Route.spa` is renamed `Route.client`.
