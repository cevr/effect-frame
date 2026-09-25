---
"effect-frame": minor
---

A `Route.actor` binding has the query binding's shape: `props.data.x` is `Route.FollowedActor<C>`, `{ ref, state }`. `ref` is the `Source<RemoteActorRef<C>>` the binding used to be, and `state` follows the reference the route holds now, across key moves. Sends still name the reference: `props.data.x.get` becomes `props.data.x.ref.get`, and `Source.switchMap(props.data.x, (r) => r.state)` becomes `props.data.x.state`.
