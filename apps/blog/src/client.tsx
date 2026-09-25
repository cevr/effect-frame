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
 * The browser entry: the one bundle every page loads, built or not
 * (#23 §5.3). It hydrates the tree over the document, follows links, and
 * then follows the island's actor over the HTTP transport. `document` and
 * `location` live here only.
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
    yield* Effect.logWarning("blog: hydration mismatches", report);
  }
  yield* Effect.sync(() => {
    document.documentElement.dataset["hydrated"] = "true";
  });
  return yield* Effect.never;
});

const services = Layer.mergeAll(
  Layer.provideMerge(
    QueryCache.layer,
    HttpTransport.layer({
      baseUrl: `${location.origin}/actors`,
      reconnect: HttpTransport.defaultReconnect,
    }).pipe(Layer.provide(FetchHttpClient.layer)),
  ),
  Layer.effect(Location, browserNavigation),
);

// The browser entry point: the one place the client services are provided.
// @effect-diagnostics-next-line strictEffectProvide:off
Effect.runFork(Effect.scoped(Effect.provide(start, services)));
