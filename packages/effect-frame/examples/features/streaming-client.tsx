import { Streaming } from "effect-frame/actor/client";
import { Dom, View } from "effect-frame/view";
import { Effect } from "effect";
import { NamesPage } from "./streaming.js";

// #region client
// A routed page never writes this: `hydrate` from `effect-frame/router`
// does it. A page with no router reads the records, seeds the cache, and
// hydrates itself, in this order.
export const start = Effect.gen(function* () {
  const root = yield* Dom.root("app");
  const resumed = yield* Streaming.resume(yield* Dom.readRecords);
  const hydration = Dom.hydrate(root);
  yield* View.mount(NamesPage, { title: "names" }, hydration.host, root);
  yield* View.flush;
  const report = yield* hydration.finish; // report.resolvedAhead
  // Drop the seeds no view took, and start the reads the seeds call for.
  yield* resumed.hydrated;
  return report;
});
// #endregion client
