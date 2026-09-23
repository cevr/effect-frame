import { Streaming } from "effect-frame/actor/client";
import { mount } from "effect-frame/router";
import type { AnyRoute } from "effect-frame/router";
import { Dom, render } from "effect-frame/view";
import { Effect } from "effect";
import { routes } from "./routes.js";
import { NotFound } from "./views.js";

/**
 * The client half of a page load. It reads the records the streamed
 * document carries, puts them in the query cache, and mounts the route
 * tree over the server's nodes.
 */

/** Hydrate `tree` over `root`. The app hydrates its own tree; a test may hand it another. */
export const hydrateRoutes = <R>(tree: ReadonlyArray<AnyRoute<R>>) =>
  Effect.fn("Dashboard.hydrate")(function* (root: HTMLElement) {
    const records = yield* Dom.readRecords;
    const resumed = yield* Streaming.resume(records);
    const hydration = Dom.hydrate(root);
    const router = yield* mount({ routes: tree, notFound: NotFound, host: hydration.host, root });
    yield* render;
    const report = yield* hydration.finish;
    // Seeds that no view took are dropped now; a later declaration reads fresh.
    yield* resumed.hydrated;
    return { router, report, resumed };
  });

export const hydrateApp = hydrateRoutes(routes);
