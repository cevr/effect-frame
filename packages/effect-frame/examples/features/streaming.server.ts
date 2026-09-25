import { Html } from "effect-frame/view";
import { Effect, Stream } from "effect";
import { NamesPage } from "./streaming.js";

// #region server
// The shell and its fallbacks first, then one record per query as it
// settles, then `Closed`. Nothing in the document runs: each record is JSON
// the client reads into its query cache.
const page: Html.Document = {
  head: '<!doctype html><html><head><meta charset="utf-8"></head><body>',
  rootId: "app", // the renderer writes <div id="app"> around the drawing
  tail: "", // resume payloads and form issues go here
  bootstrap: '<script type="module" src="/client.js"></script>',
  end: "</body></html>",
};

export const answer = Effect.gen(function* () {
  const body = Html.renderToStream(NamesPage, { title: "names" }, page, {
    closeWhen: Effect.sleep("10 seconds"),
  });
  const context = yield* Effect.context<Stream.Services<typeof body>>();
  return new Response(Stream.toReadableStreamWith(Stream.encodeText(body), context), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
});
// #endregion server
