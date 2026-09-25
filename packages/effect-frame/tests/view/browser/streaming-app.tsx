/* oxlint-disable effect/noGlobals, effect/noNullish -- this module is the fixture's browser boundary: it reads the document, calls the page server, and exposes what it saw on window. */
/**
 * The real-browser client of the streaming proof. It does what an
 * application's entry does: read the records, seed the cache, hydrate.
 * Then it records what it saw on `window.__stream` and tells the page
 * server it has hydrated, which is the server's cue to settle a held query.
 */
import { HttpTransport, QueryCache, Streaming } from "effect-frame/actor/client";
import { Dom, View } from "effect-frame/view";
import type { QueryFailure, QueryState } from "effect-frame/actor/client";
import type { Dom as DomTypes } from "effect-frame/view";
import { Effect, Layer, Option } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { Label, Page, TallPage } from "./streaming-page.js";

export interface StreamWindow {
  hydrated: boolean;
  closed: boolean;
  /** When `#label` was first on the page, in page time. */
  labelAt: number;
  /** When the record channel ended, in page time. */
  closedAt: number;
  report: DomTypes.HydrationReport;
  /** Whether the fallback was on screen when hydration finished. */
  fallbackAtHydration: boolean;
  /** The entry's state tag, and its failure tag, when hydration finished. */
  stateAtHydration: string;
  /** Every non-JSON script in the document when the client ran. */
  executableScripts: number;
}

declare global {
  interface Window {
    __stream: StreamWindow;
  }
}

const tagOf = (state: QueryState<unknown, QueryFailure>): string => {
  if (state._tag === "Failed") {
    return `Failed:${state.error._tag}`;
  }
  return state._tag;
};

const start = Effect.gen(function* () {
  const root = Option.getOrThrow(Option.fromNullishOr(document.getElementById("app")));
  const executableScripts = document.querySelectorAll(
    'script:not([type="application/json"])',
  ).length;
  const records = yield* Dom.readRecords;
  const resumed = yield* Streaming.resume(records);
  const hydration = Dom.hydrate(root);
  // The server names the page on the root: an inline script cannot run here.
  if (document.body.dataset["page"] === "tall") {
    yield* View.mount(TallPage, { id: "a" }, hydration.host, root);
  } else {
    yield* View.mount(Page, { id: "a" }, hydration.host, root);
  }
  yield* View.flush;
  const report = yield* hydration.finish;
  yield* resumed.hydrated;
  const cache = yield* QueryCache;
  const entry = yield* cache.open(Label, { id: "a" });
  const state = yield* entry.state.get;
  window.__stream = {
    hydrated: true,
    closed: false,
    labelAt: 0,
    closedAt: 0,
    report,
    fallbackAtHydration: document.getElementById("pending") !== null,
    stateAtHydration: tagOf(state),
    executableScripts,
  };
  const noteLabel = (): void => {
    if (window.__stream.labelAt === 0 && document.getElementById("label") !== null) {
      window.__stream.labelAt = performance.now();
    }
  };
  noteLabel();
  new MutationObserver(noteLabel).observe(root, { childList: true, subtree: true });
  yield* Effect.promise(() => fetch("/hydrated", { method: "POST" }));
  yield* resumed.closed;
  window.__stream.closedAt = performance.now();
  window.__stream.closed = true;
  return yield* Effect.never;
});

const layer = Layer.provideMerge(
  QueryCache.layer,
  HttpTransport.layer({
    baseUrl: `${location.origin}/actors`,
    reconnect: HttpTransport.defaultReconnect,
  }).pipe(Layer.provide(FetchHttpClient.layer)),
);

// The fixture's entry point: the one place its services are provided.
// @effect-diagnostics-next-line strictEffectProvide:off
Effect.runFork(Effect.scoped(Effect.provide(start, layer)));
