import { HttpTransport, QueryCache } from "effect-frame/actor/client";
import {
  Location,
  browserNavigation,
  followLinks,
  hydrate,
  NavigationBehavior,
} from "effect-frame/router";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { Dom } from "effect-frame/view";
import { rootId } from "./document.js";
import { routes } from "./routes.js";
import { NotFound } from "./views.js";

/**
 * The browser entry. It hydrates the route tree over the server's document,
 * follows links and history, and then follows the actors over the HTTP
 * transport. This file is the browser boundary: `document` and `location`
 * live here only.
 */

const start = Effect.gen(function* () {
  const root = yield* Dom.root(rootId);
  const { router, report } = yield* hydrate({
    landing: NavigationBehavior.Restore,
    traversalReadLimit: "3 seconds",
    routes,
    notFound: NotFound,
    root,
  });
  yield* followLinks(document, router);
  if (report.mismatches.length > 0) {
    yield* Effect.logWarning("notes: hydration mismatches", report);
  }
  // The page says it is live, so a reader (or a test) knows links are followed.
  yield* Effect.sync(() => {
    document.documentElement.dataset["hydrated"] = "true";
  });
  // The page lives as long as the tab does.
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

// The browser entry point: the one place the client services are provided.
// @effect-diagnostics-next-line strictEffectProvide:off
Effect.runFork(Effect.scoped(Effect.provide(start, services)));
