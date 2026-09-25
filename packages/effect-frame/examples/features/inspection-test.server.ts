import { ActorHost } from "effect-frame/actor";
import { QueryCache } from "effect-frame/actor/client";
import * as Frame from "effect-frame/frame";
import { Layer } from "effect";
import { CounterLive, CounterNamesLive, policies } from "../counter/counter.server.js";

// #region test-layer
// A test composes the same way, with the host in the same runtime in place
// of the HTTP transport.
export const testLayer = Layer.merge(
  QueryCache.layer,
  ActorHost.layer({
    implementations: [CounterLive],
    queries: [CounterNamesLive],
    store: ActorHost.memoryStore,
  }),
).pipe(Layer.provide(policies), Layer.provideMerge(Frame.layer({ name: "counter-test" })));
// #endregion test-layer
