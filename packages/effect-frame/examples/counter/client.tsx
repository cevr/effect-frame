// #region client
import { HttpTransport, QueryCache } from "effect-frame/actor/client";
import {
  Location,
  NavigationBehavior,
  browserNavigation,
  followLinks,
  hydrate,
} from "effect-frame/router";
import { Dom } from "effect-frame/view";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { rootId } from "./document.js";
import { NotFound, routes } from "./routes.js";

// The browser entry: it imports `effect-frame/actor/client`, never
// `effect-frame/actor`, and reaches no `.server.ts` file.
const start = Effect.gen(function* () {
  const root = yield* Dom.root(rootId);
  // `hydrate` reads what the server's document carries, mounts the routes
  // over its nodes, and follows the URL from then on.
  const { router } = yield* hydrate({
    routes,
    notFound: NotFound,
    root,
    landing: NavigationBehavior.Restore,
    traversalReadLimit: "3 seconds",
  });
  yield* followLinks(document, router);
  return yield* Effect.never;
});

const transport = HttpTransport.layer({
  baseUrl: `${location.origin}/actors`,
  reconnect: HttpTransport.defaultReconnect,
}).pipe(Layer.provide(FetchHttpClient.layer));

// The client's services: the transport, the query cache, and the URL.
const services = Layer.mergeAll(
  transport,
  QueryCache.layer,
  Layer.effect(Location, browserNavigation),
);

// The entry point: the one place the client's services are provided.
// @effect-diagnostics-next-line strictEffectProvide:off
Effect.runFork(Effect.scoped(Effect.provide(start, services)));
// #endregion client
