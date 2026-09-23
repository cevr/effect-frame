---
"effect-frame": patch
---

A server render whose drawing and seed still disagree at the time limit no longer writes a document. Before, `AwaitAll`, the streamed shell and `SSR` wrote the last read, and a query that settled between the drawing's catch-up and that read put a newer value in the seed than in the HTML, so the page did not hydrate. Now `Html.renderAwaitAll` and `Html.renderToStream` fail with the new `Html.RecordsUnsettled`, and `renderDocument` fails with `DocumentTimedOut { phase: "agree" }` (the prerender build: `PrerenderTimedOut { phase: "agree" }`), so the caller answers another way, for example with a client-only page. A caller that matches `phase` exhaustively has a new case to handle.
