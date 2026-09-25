---
"effect-frame": major
---

Delete `QueryTest`, `QueryCache.layerTest` and `ActorTransport.layerLocal`. A test writes the production wiring: `Layer.merge(QueryCache.layer, ActorHost.layer({ implementations, queries, store: ActorHost.memoryStore }))`, or `Layer.effect(ActorTransport, host)` for a hand-built transport.
