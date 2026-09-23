---
"effect-frame": minor
---

A route actor is seeded into the document. A route that declares `Route.actor` holds its reference's committed snapshot while it draws, and the document carries it beside the drawing: `SSR` and `AwaitAll` in a `frame-actor-seed` script, `Streamed` as `ActorSeed` records in the first chunk. The client's route opens its reference from it while the page hydrates and reads no snapshot; seeds are dropped at `Resumed.hydrated`. `Streaming.StreamRecord` now includes `ActorSeed`, and `Streaming.actorSeeds`, `Streaming.actorSeedId` and `Streaming.ActorSeedJson` are new. `Route.actor(contract, key, { behavior })` gives the route's reference a behavior, so a view sends through it with prediction.
