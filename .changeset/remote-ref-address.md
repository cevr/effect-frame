---
"effect-frame": minor
---

A remote reference carries its address. `RemoteActorRef` and `RemoteCommandRef` have `contract` and `key`, the ones they were opened for.

- `View.form` takes `ref` and no `contract` or `key`: the plain post's `$contract`, `$version` and `$key` come from the reference, so the post and the scripted send can never name two actors. A command-only reference (`Actor.remoteCommands`) is enough.
- `Generated.send(ref, contract, input)` is `Generated.send(ref, input)`.
