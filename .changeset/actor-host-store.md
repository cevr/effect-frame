---
"effect-frame": minor
---

`ActorHost.layer` and `ActorHost.make` require `store`. Omitted, the host used to give every actor a fresh in-memory store, so a production host that forgot it lost durability with no error. Pass `store: ActorHost.memoryStore` for a test, or for a host that keeps nothing across a restart. `ActorHost.layerMemory(implementations, queries)` is removed: write `ActorHost.layer({ implementations, queries, store: ActorHost.memoryStore })`.
