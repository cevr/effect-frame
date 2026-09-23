---
"effect-frame": minor
---

Stream a server render: the shell and its fallbacks first, then each query value as it settles, in JSON records that no script runs (#22). Each server render holds its own query cache (#28).

New exports on `effect-frame/actor/client` (and `effect-frame/actor`):

- `Streaming`: the records `Placeholder`, `Patch`, `Closed`, `StreamRecord`, their JSON codecs `RecordJson` and `SeedJson`, `recordId(key)`, `containerId`, `recordClass`, `seedId`; the server half `shell(options)`, `declared`, `awaitDeclared`, `settledPatches`, `ShellRecords`, `ShellOptions` (with a required `closeWhen`); the client half `resume(records)`, `DocumentRecords`, `Resumed` (`closed`, and `hydrated`, which drops the seeds no view took).
- `StreamEnded`: a new member of `QueryFailure`. A query still open when its document ends fails with it, then reads again over `POST /query`. The wire answers it with 502.
- A value in the document never replaces a newer read the client made. Only `QueryFailed` in the document is final; any other failure reads again. `Resumed.closed` completes once every live entry shows its value or failure.

New exports on `effect-frame/view`:

- `Html.renderToStream(view, props, document, options)`: a streamed document over a per-request cache. `options.closeWhen`, the time limit, is required.
- `Html.renderAwaitAll(view, props, document, options)`: one document once every declared query settled and no `Loading` boundary shows its fallback, with a seed script and no record channel. `options.closeWhen` is required: at the limit the drawing is written as it is, and the client reads what is still open.
- `Html.Document`, `Html.streamRecord(record)`.
- `Dom.readRecords`: the records present and the records still to come, or an `AwaitAll` seed.

Changes to existing types:

- `HydrationReport` has a new `resolvedAhead: number` field: boundaries the client drew with the other branch because their query settled before hydration.
- `Host` has three optional capabilities, `boundaryMarks(kind)`, `adoptBoundary(shown)` and `setupStarted()`, and the new type `BoundaryMarks`. A custom host may omit them.
- `RetainedNode` has a new required field `kind: "Loading" | "Errored"` (the new type `BoundaryKind`, exported from `effect-frame/view` and `effect-frame/view/jsx-runtime`). `Loading` and `Errored` set it; code that builds a `RetainedNode` by hand must set it too.
- The HTML host writes a comment pair around each readiness boundary: `<!--frame-boundary:fallback-->` or `<!--frame-boundary:content-->`, then `<!--/frame-boundary-->`. `Html.HtmlNode` has a new `Comment` member.
- A streamed record is followed by an empty comment, so the client reads a large record as soon as it is whole.
