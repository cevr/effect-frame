import { HttpTransport, QueryCache } from "effect-frame/actor/client";
import { Location, browserNavigation, followLinks } from "effect-frame/router";
import { Effect, Layer, Option } from "effect";
import { hydrateApp } from "./app.js";

/**
 * The browser entry: the one bundle every page loads, built or not
 * (#23 §5.3). It hydrates the tree over the document, follows links, and
 * then follows the island's actor over the HTTP transport. `document` and
 * `location` live here only.
 */

const start = Effect.gen(function* () {
  const found = yield* Effect.sync(() => Option.fromNullishOr(document.getElementById("app")));
  if (Option.isNone(found)) {
    return yield* Effect.die("blog: no #app element to hydrate");
  }
  const navigation = yield* browserNavigation;
  const { router, report } = yield* Effect.provideService(
    hydrateApp(found.value),
    Location,
    navigation,
  );
  yield* followLinks(document, router);
  if (report.mismatches.length > 0) {
    yield* Effect.logWarning("blog: hydration mismatches", report);
  }
  yield* Effect.sync(() => {
    document.documentElement.dataset["hydrated"] = "true";
  });
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
