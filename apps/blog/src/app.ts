import { Streaming } from "effect-frame/actor/client";
import { mount } from "effect-frame/router";
import type { AnyRoute } from "effect-frame/router";
import { Dom, View } from "effect-frame/view";
import { Effect } from "effect";
import { routes } from "./routes.js";
import { NotFound } from "./views.js";

/**
 * The client half of a page load. A built page and a page the server
 * rendered on request are the same document, so one call hydrates both:
 * read the seed, mount the tree over the server's nodes, and let the seed
 * go once hydration is done. A baked value then reads again (#23 §3.2).
 */

/** Hydrate `tree` over `root`. The app hydrates its own tree; a test may hand it another. */
export const hydrateRoutes = <R>(tree: ReadonlyArray<AnyRoute<R>>) =>
  Effect.fn("Blog.hydrate")(function* (root: HTMLElement) {
    const records = yield* Dom.readRecords;
    const resumed = yield* Streaming.resume(records);
    const hydration = Dom.hydrate(root);
    const router = yield* mount({ routes: tree, notFound: NotFound, host: hydration.host, root });
    yield* View.flush;
    const report = yield* hydration.finish;
    yield* resumed.hydrated;
    return { router, report, resumed };
  });

export const hydrateApp = hydrateRoutes(routes);
