---
"effect-frame": minor
---

`Cell` is removed. A view's own state is a local actor: `Actor.local(Behavior.value(initial))`. Read it with `ref.state`, write it with `ref.send(Value.Set(next))` or `modify(ref, (value) => next)`. Unlike a cell, a write after the actor's scope closed fails with `ActorStopped`; a handler that can outlive its view catches it by name.
