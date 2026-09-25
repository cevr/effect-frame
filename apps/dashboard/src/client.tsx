import { HttpTransport, QueryCache } from "effect-frame/actor/client";
import {
  Location,
  browserNavigation,
  followLinks,
  hydrate,
  NavigationBehavior,
} from "effect-frame/router";
import { Effect, Layer, Option } from "effect";
import { routes } from "./routes.js";
import { NotFound } from "./views.js";

/**
 * The browser entry. It hydrates the route tree over the server's document,
 * follows links and history, and then follows the actors over the HTTP
 * transport. This file is the browser boundary: `document` and `location`
 * live here only.
 */

const start = Effect.gen(function* () {
  const found = yield* Effect.sync(() => Option.fromNullishOr(document.getElementById("app")));
  if (Option.isNone(found)) {
    return yield* Effect.die("dashboard: no #app element to hydrate");
  }
  const navigation = yield* browserNavigation;
  const { router, report } = yield* Effect.provideService(
    hydrate({
      landing: NavigationBehavior.Restore,
      traversalReadLimit: "3 seconds",
      routes,
      notFound: NotFound,
      root: found.value,
    }),
    Location,
    navigation,
  );
  yield* followLinks(document, router);
  if (report.mismatches.length > 0) {
    yield* Effect.logWarning("dashboard: hydration mismatches", report);
  }
  // The page says it is live, so a reader (or a test) knows links are followed.
  yield* Effect.sync(() => {
    document.documentElement.dataset["hydrated"] = "true";
  });
  // The page lives as long as the tab does.
  return yield* Effect.never;
});

const services = Layer.provideMerge(
  QueryCache.layer,
  HttpTransport.layer({
    baseUrl: `${location.origin}/actors`,
    reconnect: HttpTransport.defaultReconnect,
  }),
);

// The browser entry point: the one place the client services are provided.
// @effect-diagnostics-next-line strictEffectProvide:off
Effect.runFork(Effect.scoped(Effect.provide(start, services)));
