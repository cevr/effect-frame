---
"effect-frame": minor
---

Add `Route.commandRef(contract, key)`: a send-only route declaration. The transition opens it with `Actor.remoteCommands`, moves it with the segment's params, and releases it like a `Route.actor`, but it reads no snapshot and follows no stream. The binding is `Route.FollowedCommands<C>`, `{ ref: Source<RemoteCommandRef<C>> }`: `Effect.flatMap(props.data.book.ref.get, (book) => book.send(message))`.
