/* oxlint-disable effect/noGlobals, effect/noNullish -- this module is the fixture's browser boundary: it reads the document and exposes what it saw on window. */
/**
 * The real-browser client of the prerender proof (#86). The build writes
 * this bundle as the site's `client.js`. It does what an application's
 * entry does on a prerendered page: read the baked snapshot, hydrate the
 * router over the page, and resume the island over HTTP. It records what it
 * saw on `window.__prerender`.
 */
import { HttpTransport, queryCacheLayer } from "effect-frame/actor/client";
import { Location, browserLocation, mount } from "effect-frame/router";
import { Dom, render } from "effect-frame/view";
import type { Dom as DomTypes } from "effect-frame/view";
import { Effect, Layer, Option, Schema } from "effect";
import { Baked, NotFound, Resume, bakedId, noteRoute } from "./prerender-page.js";

export interface PrerenderWindow {
  hydrated: boolean;
  report: DomTypes.HydrationReport;
  /** The revision the page baked. */
  revision: number;
  /** Every module script in the document when the client ran. */
  moduleTags: Array<string>;
  /** What `#count` showed before the client touched it. */
  countAtLoad: string;
}

declare global {
  interface Window {
    __prerender: PrerenderWindow;
  }
}

const start = Effect.gen(function* () {
  const root = Option.getOrThrow(Option.fromNullishOr(document.getElementById("app")));
  const moduleTags = Array.from(
    document.querySelectorAll('script[type="module"]'),
    (tag) => tag.outerHTML,
  );
  const countAtLoad = document.getElementById("count")?.textContent ?? "";
  const baked = yield* Option.match(Dom.readJsonScript(bakedId), {
    onNone: () => Effect.die("the page baked no snapshot"),
    onSome: (json) => Effect.orDie(Schema.decodeEffect(Resume)(json)),
  });
  const hydration = Dom.hydrate(root);
  yield* mount({ routes: [noteRoute], notFound: NotFound, host: hydration.host, root }).pipe(
    Effect.provideService(Location, browserLocation),
    Effect.provideService(Baked, Option.some(baked)),
  );
  yield* render;
  const report = yield* hydration.finish;
  window.__prerender = {
    hydrated: true,
    report,
    revision: baked.revision.value,
    moduleTags,
    countAtLoad,
  };
  return yield* Effect.never;
});

const layer = Layer.provideMerge(
  queryCacheLayer,
  HttpTransport.layer({
    baseUrl: `${location.origin}/actors`,
    reconnect: HttpTransport.defaultReconnect,
  }),
);

// The fixture's entry point: the one place its services are provided.
// @effect-diagnostics-next-line strictEffectProvide:off
Effect.runFork(Effect.scoped(Effect.provide(start, layer)));
