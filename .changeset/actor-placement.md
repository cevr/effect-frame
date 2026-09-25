---
"effect-frame": minor
---

Placement is named at the call, after the `kind` the reference carries: `Actor.local`, `Actor.remote`, `Actor.remoteCommands`, and, on the server entry, `Actor.durable`.

- `spawn(behavior)` is `Actor.local(behavior)`. A view's own state is `Actor.local(Behavior.value(initial))`.
- `ref(contract, key, options)` is `Actor.remote(contract, key, options)`.
- `commandRef(contract, key)` is `Actor.remoteCommands(contract, key)`.
- `durable(options)` is `Actor.durable(options)`, from `effect-frame/actor` only: the browser entry's `Actor` has no `durable`, because a browser bundle never carries a store.

The span names follow: `Actor.local`, `Actor.remote`, `Actor.remoteCommands`, `Actor.durable`.
