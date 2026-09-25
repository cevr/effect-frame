import { Form, Streaming } from "effect-frame/actor/client";
import { mount } from "effect-frame/router";
import type { AnyRoute } from "effect-frame/router";
import { Dom, View } from "effect-frame/view";
import { Effect, Option } from "effect";
import { routes } from "./routes.js";
import { NotFound } from "./views.js";

/**
 * The client half of a page load, for every mode. It reads the records the
 * document carries (a seed, or a streamed channel), puts them in the query
 * cache, and mounts the route tree over the server's nodes. A `ClientOnly`
 * document has an empty mount element, so the same call draws it fresh.
 */

/** The issues of a refused post, when this page redraws one. */
const readRefusal = Effect.suspend(() =>
  Option.match(Dom.readJsonScript(Form.issuesScriptId), {
    onNone: () => Effect.succeed(Option.none<Form.FormIssues>()),
    onSome: (json) => Effect.map(Effect.orDie(Form.decodeIssues(json)), Option.some),
  }),
);

/** Hydrate `routes` over `root`. The app hydrates its own tree; a test may hand it another. */
export const hydrateRoutes = <R>(tree: ReadonlyArray<AnyRoute<R>>) =>
  Effect.fn("Notes.hydrate")(function* (root: HTMLElement) {
    const records = yield* Dom.readRecords;
    const resumed = yield* Streaming.resume(records);
    const refusal = yield* readRefusal;
    const hydration = Dom.hydrate(root);
    const router = yield* Form.provideIssues(refusal)(
      mount({ routes: tree, notFound: NotFound, host: hydration.host, root }),
    );
    yield* View.flush;
    const report = yield* hydration.finish;
    // Seeds that no view took are dropped now; a later declaration reads fresh.
    yield* resumed.hydrated;
    return { router, report, resumed };
  });

export const hydrateApp = hydrateRoutes(routes);
