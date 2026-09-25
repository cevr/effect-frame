import { ActorHost } from "effect-frame/actor";
import type { AnyQueryImplementation } from "effect-frame/actor";
import type { ActorTransport } from "effect-frame/actor/client";
import { Layer } from "effect";
import { AlertsLive, MemoLive } from "./alerts.server.js";
import { OrdersLive } from "./orders.server.js";
import { policies } from "./policies.server.js";
import { queries } from "./queries.server.js";

/**
 * The host: three actors and six queries over in-memory mailboxes, under
 * one policy table. A server module.
 */

/** The actors this host runs. */
export const actors = [OrdersLive, AlertsLive, MemoLive];

/**
 * A host over `served`. The app serves every handler; a test passes the
 * same handlers wrapped, to count, hold, or fail one read.
 */
export const hostWith = (
  served: ReadonlyArray<AnyQueryImplementation<never>>,
): Layer.Layer<ActorTransport> =>
  ActorHost.layer({ implementations: actors, queries: served, store: ActorHost.memoryStore }).pipe(
    Layer.provide(policies),
    // Every name the contracts and the queries declare is in the table; a miss is a bug here.
    Layer.orDie,
  );

/** The actors and queries run in this process. */
export const inProcess: Layer.Layer<ActorTransport> = hostWith(queries);
