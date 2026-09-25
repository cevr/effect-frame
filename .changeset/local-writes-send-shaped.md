---
"effect-frame": minor
---

A local reference's `derive` and `modify` return a handle, as `send` does, and never fail. A stopped actor or a refusal is a `Rejected` state of that handle, so a view handler writes `View.event(modify(count, (n) => n + 1))` with no catch. A caller that needs the outcome reads `(yield* modify(ref, f)).settled`, which gives `Applied` or `Rejected`. `call` still fails with `ActorStopped` or the refusal: it asks for the reply, and a stopped actor has none.

This corrects the 0.27.0 note on `Cell`'s removal: a local `send` after the actor's scope closed never failed; it gave a `Rejected(ActorStopped)` handle. Only `modify` failed, and now it does not.
