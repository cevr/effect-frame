import { ActorHost, implementTransparent } from "effect-frame/actor";
import type { ActorTransport } from "effect-frame/actor/client";
import { HttpTransport } from "effect-frame/actor/client";
import { Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { notesBehavior } from "./behavior.js";
import { Notes } from "./contract.js";
import { policies } from "./policies.server.js";
import { ListCountsLive, ListIndexLive } from "./queries.server.js";

/**
 * The server half of the notes contract: the actor, its queries, and
 * the host they run in. The behavior itself is browser safe
 * (`behavior.ts`), because the page predicts with it.
 */

export const NotesLive = implementTransparent(Notes, { behavior: notesBehavior });

/** The actors and queries run in this process, over in-memory mailboxes. */
export const inProcess: Layer.Layer<ActorTransport> = ActorHost.layer({
  implementations: [NotesLive],
  queries: [ListIndexLive, ListCountsLive],
  store: ActorHost.memoryStore,
}).pipe(
  Layer.provide(policies),
  // Every name the contract and the queries declare is in the table; a miss is a bug here.
  Layer.orDie,
);

/**
 * The actors run somewhere else, for example a celld node. This process
 * only proxies. `server.ts` picks between the two at the boundary.
 */
export const upstream = (baseUrl: string): Layer.Layer<ActorTransport> =>
  HttpTransport.layer({
    baseUrl: `${baseUrl}/actors`,
    reconnect: HttpTransport.defaultReconnect,
  }).pipe(Layer.provide(FetchHttpClient.layer));
