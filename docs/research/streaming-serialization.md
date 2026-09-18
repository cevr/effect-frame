# Streaming serialization of in-flight promises

Date: 2026-09-18.
Ticket: [Verify how streaming SSR serializes pending values in Solid 2 and React Flight](https://github.com/cevr/effect-frame/issues/12).
Method: primary source review only. Local package source, GitHub raw source, and pinned commits. No blog posts.
Status: research complete. No Effect Frame code was written or changed.

## Result

Both frameworks solve the same problem with the same three-part shape.
First, the server writes a placeholder for the unsettled promise.
The placeholder carries an identifier, not a value.
Second, the server keeps the response open.
Third, the server writes a later record that addresses the same identifier and supplies the value.
The client creates a real, pending `Promise` at placeholder time.
The client resolves that same `Promise` when the later record arrives.

The two designs differ in the transport of the later record.
React Flight writes a newline-delimited row to one byte stream. See R1–R5.
Solid 2 writes an inline `<script>` into the HTML document that calls a resolver held on a global. See A1–A5.
Solid 2 also ships an eval-free JSON codec that emits the same information as keyed records. See A6.

Both designs tolerate out-of-order arrival by the same mechanism.
A reference to an identifier creates the pending cell on demand.
The cell exists whether or not its value row has arrived. See R6 and A7.

Both designs treat "the stream ended first" as a terminal event that must be delivered.
React Flight rejects every still-pending chunk with `Error('Connection closed.')`. See R7.
React Flight has a second mode that halts pending chunks instead, so they never settle. See R7.
Solid 2 closes the serializer, which fires `onDone` without emitting the missing patch. See A8.
The client promise then stays pending forever unless the application re-asks. See A8.

Effect Frame's current wire has none of these parts.
It carries one settled snapshot string per response and one revision number. See F1–F4.
It has no placeholder, no chunk identifier, and no late-arriving patch channel. See F5.

## Source versions

| Source                     | Version and revision                                                         | Evidence                                                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `@solidjs/signals` (local) | 2.0.0-rc.8                                                                   | `/Users/cvr/Developer/personal/effect-frame/node_modules/.bun/@solidjs+signals@2.0.0-rc.8/node_modules/@solidjs/signals/package.json:3` |
| `@solidjs/web` (`next`)    | 2.0.0-rc.9; `49887e1b29fc6f04500b0dbc47c23d90b1ec5255`                       | Solid `next` head; `packages/web/package.json:4`                                                                                        |
| `seroval` (Solid's pin)    | `~1.6.7` declared; read at `main` `7a83da9b0e6a4a460ab0380a839e76d7876bbb3e` | `packages/web/package.json:318`                                                                                                         |
| React (`main`)             | `59aff3e18cb5b3a336c280bbfa57ec37999511b9`                                   | `git/refs/heads/main`                                                                                                                   |
| Next.js (`canary`)         | head at read time                                                            | `packages/next/src/server/app-render/use-flight-response.tsx`                                                                           |
| Effect Frame               | working copy at 2026-09-18                                                   | `/Users/cvr/Developer/personal/effect-frame/packages/actor/src/http/wire.ts`                                                            |

Two limits apply to these versions.
The seroval source read is `main`, whose manifest declares 1.6.1.
Solid declares `~1.6.7`, so the read source is not the exact published build. The tag list does not publish 1.6.7.
The `@solidjs/signals` package is installed locally, but `solid-js`, `@solidjs/web`, and `seroval` are not.
Those three were read from GitHub raw source at the pinned Solid `next` head.
Commands: `curl` against `raw.githubusercontent.com` and `api.github.com`; `find` and `grep` against the local store.

## Solid 2 facts

### A1 — Solid 2 still uses seroval

`@solidjs/web` at Solid `next` declares `seroval: "~1.6.7"` and `seroval-plugins: "~1.6.7"` as runtime dependencies.
Solid 2 did not replace seroval. It wrapped it.
The wrapper lives in a dedicated `serialization` subpackage.
Source: `packages/web/package.json:318`; `packages/web/serialization/src/serializer.ts`.

### A2 — The hydration global is `_$HY.r`, and the cross-reference global is `$R`

Solid pins one global for hydration output.
The constant is `const HYDRATION_GLOBAL = "_$HY.r"`.
Its comment states it has been part of the hydration wire protocol since the streaming serializer landed.
Source: `packages/web/serialization/src/serializer.ts:141`.

Seroval owns a second global for cross-reference identity.
`GLOBAL_CONTEXT_REFERENCES = '$R'`, and `getCrossReferenceHeader(id)` emits `(self.$R=self.$R||{})["<id>"]=[]`.
Solid emits that header once per render scope, ahead of any data.
Solid's wrapper is `getLocalHeaderScript(id)`, which appends `";"`.
Sources: `packages/seroval/src/core/keys.ts:6` and `:10`; `packages/web/serialization/src/serializer.ts:219`.

### A3 — A pending promise serializes as a resolver, then a later patch

Seroval's stream parser handles a `Promise` in `parsePromise`.
It mints a reference index for a resolver object.
It registers `.then` handlers.
It returns a `PromiseConstructorNode` immediately, without waiting.
Source: `packages/seroval/src/core/context/sync-parser.ts:539`.

The emitted resolver is a real deferred, created in the client realm.
`PROMISE_CONSTRUCTOR` builds `{p, s, f}`: a `Promise` plus its `resolve` and `reject`.
The function is serialized by `toString()`, so the client evaluates the same code.
Source: `packages/seroval/src/core/constructors.ts:12`.

When the server promise settles, the handler emits a second node.
`handlePromiseSuccess` emits a `PromiseSuccess` node that references `SpecialReference.PromiseSuccess` and the parsed value.
`handlePromiseFailure` emits a `PromiseFailure` node.
Sources: `packages/seroval/src/core/context/sync-parser.ts:479` and `:509`.

`PROMISE_SUCCESS(resolver, data)` calls `resolver.s(data)`, then stamps `resolver.p.s = 1` and `resolver.p.v = data`.
`PROMISE_FAILURE` calls `resolver.f(data)`, then stamps `s = 2`.
The stamp is what lets a later reader see a settled value synchronously.
Source: `packages/seroval/src/core/constructors.ts:25` and `:34`.

### A4 — Ordering rule: the initial node is always first

Seroval guarantees the placeholder precedes every patch.
During the initial parse, `onParse` pushes nodes into a buffer instead of emitting them.
`startStreamParse` parses the top value, emits it with `initial = true`, sets `state.initial = false`, and only then flushes the buffer.
A promise that settles synchronously therefore still emits its constructor node first and its success node second.
Source: `packages/seroval/src/core/context/sync-parser.ts:907`, `:972`, and `:990`.

Solid's `Serializer.write(key, value)` turns the `initial` flag into the wire distinction.
When `initial` is true, it emits `globalIdentifier["<key>"]=<data>`.
When `initial` is false, it emits the bare `data` — a call that patches the already-created resolver.
So the first script writes `_$HY.r["<id>"] = <resolver>`. Later scripts call the resolver.
Source: `packages/seroval/src/core/Serializer.ts:41` and `:54`.

### A5 — The document embeds each chunk as an inline `<script>`

Solid's streaming SSR builds the serializer with `onData: payload => sink.data(payload)`.
The document sink writes each payload into a `<script>` tag.
Solid batches tasks in a microtask so several resolutions coalesce into one `<script>`.
Sources: `packages/web/src/server.ts:2108`; `:2279`; `:2192` (the `pushTask` microtask batching comment).

Solid batches pre-shell stubs into one seroval write under the key `$B`.
A spreader task then copies each entry to its real `_$HY.r` key and deletes `$B`.
The emitted task is `(b=>{for(var k in b)_$HY.r[k]=b[k];delete _$HY.r["$B"]})(_$HY.r["$B"])`.
The stated reason is CPU: each `serializer.write` starts a full `crossSerializeStream` session, and that cost was about 30% of shell CPU on an async-heavy page.
Batching is document-mode only and is disabled when a custom serializer or sink is supplied.
Source: `packages/web/src/server.ts:1946`–`:1977`.

### A6 — Solid 2 also has an eval-free keyed JSON codec

`createJSONSerializer` emits `{ key, node, initial }` records instead of scripts.
Its documented contract matches the hydration serializer: `write(key, value)` then `flush()`.
Every write shares one `refs` map, so a value referenced from two writes dedupes and decodes to one instance.
Async values "keep emitting patch nodes after their initial keyed node".
Writes after `flush()` are dropped, mirroring the hydration serializer.
Source: `packages/web/serialization/src/serializer.ts:283` and `:300`.

The decoding peer is `createJSONDataTable`.
Its `apply(record)` puts initial nodes in the table under their key.
It routes later nodes as patches through the shared `refs`.
Source: `packages/web/serialization/src/serializer-decode.ts:395` and `:406`.

This codec is the closest existing analogue to a Schema-encoded wire.
It needs no script evaluation on the consumer, which the source calls CSP-safe.
Source: `packages/web/serialization/src/serializer.ts:224`.

### A7 — Out-of-order arrival, and the client graph resume

The client reads serialized values by hydration id.
`hydrate()` assigns `sharedConfig.load = id => globalThis._$HY.r[id]`.
Source: `packages/solid/src/client/hydration.ts` region; the assignment is at `packages/web/src/client.ts:2045`.

A hydrating computation does not run its own body while a server value is waiting.
`readSerializedOrCompute` short-circuits to the server value whenever `sharedConfig.has(o.id)` is true and hydration is not `done`.
Its comment states the reason: a streamed section can recompute between chunks, and running the client body there would commit a fresh `Promise` and orphan the server-streamed fragment.
Source: `packages/solid/src/client/hydration.ts:432`.

`readHydratedValue` unwraps the entry.
It reads the numeric stamp: `s === 1` returns `v`, and `s === 2` throws `v`.
If the value is still an unsettled thenable, it is handed to the async runtime as a thenable.
The pending read then throws `NotReadyError`, which suspends at the nearest `<Loading>` boundary.
Sources: `packages/solid/src/client/hydration.ts:394`; local `.../@solidjs/signals/dist/types/core/error.d.ts:1` (the `NotReadyError` doc comment names `<Loading>` as the canonical handler).

Out-of-order arrival is handled by construction, in two layers.
At the wire layer, seroval's cross-reference header creates the `$R` array before any data, and every later patch addresses a ref index inside it.
At the graph layer, the entry in `_$HY.r` is a real `Promise` from the moment the constructor script runs.
A component that reads it before the patch arrives gets a pending promise, not a missing key.
A component that reads it after the patch arrives gets the stamped value synchronously.
Sources: `packages/seroval/src/core/keys.ts:10`; `packages/seroval/src/core/constructors.ts:25`; `packages/solid/src/client/hydration.ts:394`.

One ordering constraint is strict and is enforced on the server, not the client.
Hydration ids must line up between server and client.
The local signals types state that a client-only effect created while hydrating would shift every later sibling's hydration id, and that this makes serialized lookups fail.
Source: `.../@solidjs/signals/dist/types/signals.d.ts:116`–`:127`.

### A8 — What happens when the stream ends before a query resolves

Three distinct end conditions exist. They behave differently.

First, a sync render refuses the case outright.
`renderToString`'s `serialize(id, p)` throws when `p` is a thenable or async iterable.
The message is `"Cannot serialize async value in renderToString (id: ...). Use renderToStream for async data."`
Source: `packages/web/src/server.ts:1639`–`:1651`.

Second, a normal streaming completion waits.
`Serializer.flush()` sets `flushed = true` but calls `onDone` only when `pending <= 0`.
Each `write` increments `pending`; each inner stream's `onDone` decrements it.
So the response stays open until every serialized promise settles.
Source: `packages/seroval/src/core/Serializer.ts:101` and `:66`.

Solid gates the flush behind an empty registry and zero holds.
`flushEnd` runs `serializeRootAssets`, then double-queues `flushStubBatch()` and `serializer.flush()`.
The comment states that post-flush writes are silently dropped, so the stub batch must land first.
Source: `packages/web/src/server.ts:2137`–`:2158`.

Third, an abandoned or closed stream settles the deferred without a value.
`Serializer.close()` runs every cleanup, then calls `onDone` regardless of `pending`.
The cleanup is `destroyStreamParse`, which fires `onDone` and sets `state.alive = false`.
After that, `handlePromiseSuccess` and `handlePromiseFailure` check `this.state.alive` and emit nothing.
The client promise therefore never receives a patch and stays pending forever.
Sources: `packages/seroval/src/core/Serializer.ts:111`; `packages/seroval/src/core/context/sync-parser.ts:998`, `:479`, and `:509`.

Solid added an explicit ledger for this hazard.
`pendingSerialized` maps each hydration id to a settle hook.
Its comment states the problem directly: seroval's `onDone` waits for every serialized async value to settle, so a fragment that reaches its terminal error state while a sibling is still pending would hold the response open forever.
`abandonSubtree(key, error)` settles every descendant fragment and every pending serialized id under that key prefix.
Hydration ids are a prefix code, so `startsWith` is exact ancestry.
Abandoned data ids resolve `undefined`, not rejected, because the client re-renders that region from the outer fragment's rejection.
Solid emits an `SSR_SUBTREE_ABANDONED` finding when the discard took work with it.
Source: `packages/web/src/server.ts:2161`–`:2170` and `:2226`–`:2270`.

A rejection reaching the client is sanitized at one funnel.
`serialize(id, p, deferStream)` calls `guardChannel(p)` before any write.
The guard replaces a raw rejection reason with `ssrSanitizeError(error, null)`.
One guard exists per channel object, so a source serialized under two ids stays one channel for seroval's cross-references.
Source: `packages/web/src/server.ts:2425`–`:2455`.

Error stacks are stripped outside development, because a serialized stack leaks server paths.
Source: `packages/web/serialization/src/serializer.ts:128`.

### A9 — Three declared SSR source policies

Solid 2 declares `ssrSource: "server" | "hybrid" | "client"`.
Source: `packages/solid/src/server/signals.ts:567`.

`"client"` never runs the compute on the server.
Source: `packages/solid/src/server/signals.ts:995` and `:1721`.

A live source under server or default mode is forced to hybrid.
The comment gives the reason: `"server"` has no meaning for a standing answer, and streaming it would hold the document open forever.
Hybrid takes the first value and closes.
Source: `packages/solid/src/server/signals.ts:1338`–`:1350`.

Serialization happens only when the context is async and a serialize hook exists.
`const serializes = !!(ctx?.async && ctx.serialize && id && !noHydrate)`.
The deferred promise is written to the serializer at slot creation, before the value exists.
Source: `packages/solid/src/server/signals.ts:1319`–`:1323`.

A synchronous value is never serialized, even under explicit `ssrSource: "server"`.
The comment says the code itself is the source.
Source: `packages/solid/src/server/signals.ts:1684`.

The client re-runs a live-branded compute after hydration ends.
`armLiveTakeover` creates one shared gate signal. `onHydrationEnd` flips it.
The adopted stale value serves until the reconnect's first yield lands, so takeover is seam-free.
Source: `packages/solid/src/client/hydration.ts:487`–`:502`.

## React Flight facts

### R1 — The row format

A Flight row is `<id-in-hex>:<tag><payload>\n`.
`emitModelChunk` builds `id.toString(16) + ':' + json + '\n'` — a model row has no tag letter.
`emitTextChunk` builds `id.toString(16) + ':T' + binaryLength.toString(16) + ','` followed by the bytes.
`emitHintChunk` builds `':H' + code + json + '\n'` with no id.
Sources: `packages/react-server/src/ReactFlightServer.js:4835`, `:5214`, and `:4824`.

The client's `processFullStringRow` switches on the tag byte.
`I` resolves a module. `H` resolves a hint. `E` resolves an error model. `T` resolves text.
`R` and `r` start a readable stream. `X` and `x` start an async iterable. `C` stops a stream.
`N`, `D`, `J`, and `W` carry timing, debug, IO and console data.
The default branch — `"`, `{`, `[`, `t`, `f`, `n`, and digits — is treated as JSON and resolves a model.
Source: `packages/react-client/src/ReactFlightClient.js:5227`.

### R2 — Reference sigils inside a model

Model JSON encodes a reference as a string beginning with `$`.
`serializeByValueID` gives `'$' + hex`.
`serializeLazyID` gives `'$L' + hex`.
`serializePromiseID` gives `'$@' + hex`.
`serializeWeakPromiseID` gives `'$w' + hex`.
`'$$'` is an escaped literal string that happened to start with `$`.
Sources: `packages/react-server/src/ReactFlightServer.js:3073`–`:3093`; `packages/react-client/src/ReactFlightClient.js:2653` and `:2678`.

### R3 — A pending promise becomes `$@<id>`, emitted before its value row

`serializeThenable(request, task, thenable)` switches on the thenable's status.
For a pending thenable it creates a new task, attaches `.then`, and returns the new task's id immediately.
The parent model therefore carries `$@<id>` while the value is still unknown.
On fulfilment the handler sets `newTask.model = value` and calls `pingTask`, which schedules the value row.
On rejection it calls `erroredTask` and `enqueueFlush`, which schedules an `E` row for the same id.
Source: `packages/react-server/src/ReactFlightServer.js:1110`, `:1256`, and `:1262`.

A fulfilled thenable takes a shortcut: it sets the model and pings at once.
A rejected thenable errors the task at once.
Both still allocate their own id and their own row.
Source: `packages/react-server/src/ReactFlightServer.js:1116`–`:1129`.

React added a weak variant that does not block the stream from closing.
`pending_weak` reserves only an id. It creates no task.
Its comment is explicit: if the stream closes before the listeners are notified, the value is dropped and the reference is left unfulfilled.
Both settle handlers guard on `request.status > OPEN` and return early when the stream has closed.
Source: `packages/react-server/src/ReactFlightServer.js:1136`–`:1215`.

### R4 — The client creates a pending chunk and resolves it later

The client models every row id as a chunk, which is a `ReactPromise`.
`createPendingChunk` returns `new ReactPromise(PENDING, null, null)`.
`createPendingWeakChunk` returns `PENDING_WEAK`, and its comment says a weak chunk may never settle, so it holds no strong reference to the `Response`.
Source: `packages/react-client/src/ReactFlightClient.js:493` and `:508`.

Parsing `$@<id>` returns that chunk directly. The chunk is a thenable, so React suspends on it.
Parsing `$L<id>` wraps the chunk in a `React.lazy`.
Parsing `$w<id>` uses `getWeakChunk`.
Source: `packages/react-client/src/ReactFlightClient.js:2695`–`:2728`.

`resolveModelChunk` flips a pending chunk to `RESOLVED_MODEL`, stores the raw JSON, and wakes listeners.
`triggerErrorOnChunk` rejects a pending chunk.
Both check the current status first: if a chunk is already resolved, the extra data is treated as a stream chunk and forwarded to the stream controller instead.
Sources: `packages/react-client/src/ReactFlightClient.js:949` and `:802`.

### R5 — RSC rows embed in the HTML document as script pushes

React itself hands the caller a byte stream. The embedding is the framework's job.
Next.js writes each Flight chunk as an inline `<script>` that pushes into a global array.
The bootstrap is `(self.__next_f=self.__next_f||[]).push(...)`.
Each later chunk is `self.__next_f.push(...)`.
Every payload passes through `htmlEscapeJsonString`, and the opening tag carries the CSP nonce when one exists.
Source: `packages/next/src/server/app-render/use-flight-response.tsx:226`, `:231`, `:270`, and `:169`.

This is the same pattern Solid uses, with a different global and a different payload.
Next.js pushes opaque row text that a `react-server-dom-*` client parses.
Solid pushes executable resolver calls that the browser evaluates directly.
The generic `react-server-dom-webpack` client instead reads a `ReadableStream` or `fetch` response, with no document embedding.

### R6 — Out-of-order arrival

`getChunk(response, id)` creates the chunk on first reference.
If the id is not in `response._chunks`, it creates a pending chunk and stores it.
So a model row that references `$@7` before row `7` arrives is fine: row 7 later finds the existing pending chunk and resolves it.
Source: `packages/react-client/src/ReactFlightClient.js:1658`.

The server does not guarantee id order in the stream.
It guarantees only that the referencing row can be parsed without the referenced row.
`serializeThenable` returns the id synchronously while the value row is scheduled for later.
Source: `packages/react-server/src/ReactFlightServer.js:1110`.

The client also detects reference cycles.
`resolveBlockedCycle` walks a blocked chunk's listeners to find whether adding a listener would form a cycle, and resolves the cycle if so.
Source: `packages/react-client/src/ReactFlightClient.js:694`.

### R7 — What happens when the stream ends before resolution

Three distinct paths exist on the server.

`abort(request, reason)` is the render path.
It sets `request.status = ABORTING` and aborts the cache controller.
It allocates one shared error id, emits one `E` row for it, and then makes every abortable task reference that one row.
`finishAbortedTask` writes a reference row, not a full error per task: `encodeReferenceChunk(request, task.id, serializeByValueID(errorId))`.
When the reason is absent, the error message is `'The render was aborted by the server without a reason.'`
Source: `packages/react-server/src/ReactFlightServer.js:6929`, `:6951`, `:6966`, and `:6497`.

`haltTask` is the prerender path.
It finishes a task without emitting anything into its slot.
The comment states the reference is intentionally left unfulfilled and never resolves on the client.
`finishHaltedTask` only decrements `request.pendingChunks`.
Source: `packages/react-server/src/ReactFlightServer.js:6528` and `:6537`.

The weak-thenable path is the third. It drops the value silently, as R3 describes.

On the client, `close(weakResponse)` branches on `_allowPartialStream`.
When partial streams are allowed, it halts every pending chunk and closes stream chunks gracefully with `'"$undefined"'`.
Otherwise it calls `reportGlobalError(weakResponse, new Error('Connection closed.'))`.
Source: `packages/react-client/src/ReactFlightClient.js:5701` and `:5736`.

`reportGlobalError` sets `_closed` and `_closedReason`, then walks every chunk.
A `PENDING` chunk is errored. A `PENDING_WEAK` chunk is halted instead, because a weak reference may never be emitted.
An `INITIALIZED` chunk with a stream controller has its controller errored.
Source: `packages/react-client/src/ReactFlightClient.js:1289`–`:1313`.

After close, `getChunk` no longer creates pending chunks.
It creates a halted chunk when partial streams are allowed, and an error chunk otherwise.
So a reference that arrives after close fails immediately instead of hanging.
Source: `packages/react-client/src/ReactFlightClient.js:1658`.

## Effect Frame's current wire

### F1 — Four single-shot HTTP verbs plus one SSE stream

`packages/actor/src/http/wire.ts:13` documents the whole protocol in one comment block.

```
POST {base}/send      SendBody     -> WireReceipt | WireError
POST {base}/call      CallBody     -> WireProjection | WireError
POST {base}/snapshot  AddressBody  -> WireProjection | WireError
GET  {base}/changes?contract&version&key&after -> text/event-stream
```

Every body is JSON.
Only `changes` streams, and it carries one `data:` line per revision.
The delimiter is `eventPrefix = "data: "`.
Source: `/Users/cvr/Developer/personal/effect-frame/packages/actor/src/http/wire.ts:18` and `:117`.

### F2 — The encoded shapes

`WireAddress` is `{ contract: string, version: number, key: string }`.
`WireProjection` is `{ revision: number, snapshot: string }` — the state is a pre-encoded string, not a nested schema.
`WireReceipt` is `{ commandId, admitted, committed: Option<number> }`.
`SendBody` and `CallBody` carry the payload as a string for the same reason.
Source: `packages/actor/src/http/wire.ts:23`, `:50`, `:44`, `:31`, and `:37`.

`WireError` is a closed union of seven tagged errors, and `statusOf` maps each to one HTTP status.
Three narrower unions constrain what each verb may fail with.
Source: `packages/actor/src/http/wire.ts:55`, `:67`, `:75`, `:84`, and `:92`.

### F3 — Schema is the only codec; there is no `devalue`

Both sides encode with `Schema.fromJsonString`.
The server holds `encodeReceipt`, `encodeProjection`, and `encodeError`.
The client holds `encodeSend`, `encodeCall`, `encodeAddress`, and `decodeProjection`.
Sources: `packages/actor/src/http/server.ts:37`–`:48`; `packages/actor/src/http/client.ts:42`–`:48`.

`resumeCodec(definition)` is the one shape built for page resume.
It returns `Schema.fromJsonString(Schema.Struct({ revision: Schema.Finite, state: snapshot }))`.
It is exported from the browser-safe entry.
Sources: `packages/actor/src/contract.ts:69`; `packages/actor/src/client.ts:14`.

### F4 — Revisions live on the projection, and resume is a single `Option`

`RefOptions.resume` is `Option.Option<Applied<SnapshotOf<C>>>`.
Its doc comment says it is a snapshot the client already holds, for example one rendered into the page by the server.
`fetchInitial` uses the resumed value when present, and calls `transport.snapshot(address)` otherwise.
Source: `packages/actor/src/ref.ts:10`–`:31`.

`decodeProjection` turns `{ revision, snapshot }` into `Applied<A>` by decoding the snapshot string with the contract schema.
`newest(current, next)` keeps the higher revision, because revisions arrive from two paths.
`changes` on the HTTP client tracks the last revision in a `Ref`, reconnects from it, and filters out revisions at or below the starting point.
Sources: `packages/actor/src/ref.ts:33`, `:43`, `:71`; `packages/actor/src/http/client.ts:140`–`:147`.

### F5 — The HTML host writes one settled JSON script

`Html.renderToString` mounts the view, renders exactly one frame, serializes the tree, and closes its scope.
The doc comment says setup runs, one frame is drawn, the tree is serialized, and every resource is released before the string returns.
It returns a `string`, not a stream.
Source: `packages/view/src/hosts/html.ts:172`–`:190`.

`jsonScript(id, json)` emits `<script type="application/json" id="...">...</script>`.
`escapeJsonScript` escapes `<`, `>`, `&`, U+2028, and U+2029 so the JSON can never close the element.
The client reads it back with `Dom.readJsonScript(id)`, which returns `Option<string>` from `document.getElementById(id).textContent`.
Sources: `packages/view/src/hosts/html.ts:192`, `:44`, `:69`; `packages/view/src/hosts/dom.ts:214`.

### F6 — What the current wire lacks for streaming

Each item below is a direct consequence of F1–F5.

There is no pending placeholder.
`WireProjection` requires a `snapshot` string, so an unsettled value has no representation.
Source: `packages/actor/src/http/wire.ts:50`.

There is no chunk identifier.
Rows in `changes` are addressed only by an actor address in the query string, and ordered only by `revision`.
Two different in-flight queries on one page have no distinct slot.
Source: `packages/actor/src/http/wire.ts:21`; `packages/actor/src/http/client.ts:95`.

There is no late-arriving patch channel inside the HTML document.
`jsonScript` is written once, by a `renderToString` that has already closed its scope.
A second `<script>` later in the same document has no defined meaning, because nothing on the client subscribes to a document-embedded channel.
Sources: `packages/view/src/hosts/html.ts:177` and `:192`; `packages/view/src/hosts/dom.ts:214`.

Resume is single-shot.
`RefOptions.resume` takes one `Option` of one settled `Applied` value.
There is no shape for "the value for this id is still coming".
Source: `packages/actor/src/ref.ts:10`.

There is no stream-end signal for an unresolved value.
The `changes` client reconnects on failure and resumes from the last seen revision.
That is the correct behavior for a long-lived subscription. It is not a terminal verdict for a one-shot query that never answered.
Source: `packages/actor/src/http/client.ts:137`–`:147`.

The escaping primitive already exists and is correct.
`escapeJsonScript` covers the five characters that matter.
It is reusable for a multi-chunk document channel without change.
Source: `packages/view/src/hosts/html.ts:44`.

## Implications for Effect Frame

These are implications drawn from the facts above. They are not decisions.

A streaming wire needs a stable identifier per in-flight value, separate from the actor address.
Both studied systems address a value by an id that the placeholder and the later patch share.
Effect Frame's current addressing is `{contract, version, key}` plus `revision`, which identifies an actor, not a query. See F5 and R2.

A streaming wire needs a placeholder shape in the encoded union.
`WireProjection` today admits only a settled snapshot string.
A streaming shape would need a variant that carries an id and no value. See F2, R3, and A3.

A streaming wire needs the placeholder to precede its patch on the wire.
Seroval enforces this by buffering during the initial parse, and React enforces it by returning the id synchronously from `serializeThenable`. See A4 and R3.

A streaming wire needs the client to create a real pending cell at placeholder time.
Both systems create a client-realm `Promise` before the value exists, and resolve that same instance later.
Solid holds it in `_$HY.r[id]`; React holds it in `response._chunks`. See A3, A7, R4, and R6.

Out-of-order tolerance follows from creating the cell on first reference, not from wire ordering.
React's `getChunk` creates a pending chunk for an unseen id.
Solid's `$R` header creates the cross-reference container before any data.
Neither system requires monotonic id order in the byte stream. See R6 and A7.

A streaming wire needs a terminal verdict when the response ends with a value still pending.
React chooses one of two: reject every pending chunk with `Connection closed.`, or halt them so they never settle.
Solid chooses a third: close the serializer, which leaves the client promise pending, and adds a separate abandonment ledger so a dead subtree cannot hold the response open.
Effect Frame's reconnect-from-last-revision behavior is a fourth thing, and does not cover this case. See R7, A8, and F6.

A Schema-based encoding can carry this without `devalue` and without script evaluation.
Solid's `createJSONSerializer` and `createJSONDataTable` prove the keyed-record form: `{ key, node, initial }` in, patched table out, no eval on the consumer.
The `initial` flag is what distinguishes a placeholder record from a patch record. See A6.

An actor revision and a query patch are different kinds of late data and would occupy the same document channel.
A revision is a monotonic replacement addressed by actor.
A query patch is a one-time settle addressed by id.
Effect Frame currently has a transport for the first (`changes` SSE) and none for the second. See F1, F4, and F6.

A shared reference space matters when one value appears under two ids.
Seroval's `Serializer` reuses one `refs` map across every `write`, so a value referenced twice dedupes and decodes to one instance.
Solid's `guardChannel` keeps one guard per channel object for the same reason. See A6 and A8.

Hydration id stability is a precondition, not a detail.
Solid's own types state that one extra client-only owner shifts every later sibling's hydration id and breaks serialized lookups.
Any id scheme that a streamed patch addresses must be derived identically on both sides. See A7.

Error content on the wire is a disclosure decision.
Solid sanitizes every rejection at one funnel and strips `Error.prototype.stack` outside development.
React emits a digest in production and the full error only in development.
A patch channel carrying failures would face the same choice. See A8 and R7.

## Tests performed and limits

Performed: local package inspection, GitHub raw source reads at pinned commits, and exact line-number verification of every cited function.
No code was written. No dependencies were installed. No framework test suite ran. No runtime behavior was observed.

Not proved: that seroval `main` matches the published 1.6.7 that Solid pins; that the Solid `next` head matches any published RC; that any of these mechanisms work under Effect Frame's own runtime; or that a Schema-encoded equivalent preserves the ordering guarantees described here.
The local store contains `@solidjs/signals` only. `solid-js`, `@solidjs/web`, and `seroval` are absent and were read remotely.

## Primary source inventory

Solid links are fixed to `49887e1b29fc6f04500b0dbc47c23d90b1ec5255` (branch `next`).
React links are fixed to `59aff3e18cb5b3a336c280bbfa57ec37999511b9` (branch `main`).
Seroval links are fixed to `7a83da9b0e6a4a460ab0380a839e76d7876bbb3e` (branch `main`).

- **A0 — Local signals package.** `/Users/cvr/Developer/personal/effect-frame/node_modules/.bun/@solidjs+signals@2.0.0-rc.8/node_modules/@solidjs/signals/package.json:3`.
- **A1 — Solid 2 seroval dependency.** [`packages/web/package.json`](https://github.com/solidjs/solid/blob/49887e1b29fc6f04500b0dbc47c23d90b1ec5255/packages/web/package.json#L317).
- **A2 — Hydration and cross-reference globals.** [`packages/web/serialization/src/serializer.ts#L141`](https://github.com/solidjs/solid/blob/49887e1b29fc6f04500b0dbc47c23d90b1ec5255/packages/web/serialization/src/serializer.ts#L141); [`packages/seroval/src/core/keys.ts#L6`](https://github.com/lxsmnsyc/seroval/blob/7a83da9b0e6a4a460ab0380a839e76d7876bbb3e/packages/seroval/src/core/keys.ts#L6).
- **A3 — Promise placeholder and patch nodes.** [`sync-parser.ts#L539`](https://github.com/lxsmnsyc/seroval/blob/7a83da9b0e6a4a460ab0380a839e76d7876bbb3e/packages/seroval/src/core/context/sync-parser.ts#L539); [`sync-parser.ts#L479`](https://github.com/lxsmnsyc/seroval/blob/7a83da9b0e6a4a460ab0380a839e76d7876bbb3e/packages/seroval/src/core/context/sync-parser.ts#L479); [`constructors.ts#L12`](https://github.com/lxsmnsyc/seroval/blob/7a83da9b0e6a4a460ab0380a839e76d7876bbb3e/packages/seroval/src/core/constructors.ts#L12).
- **A4 — Initial-before-patch ordering.** [`sync-parser.ts#L907`](https://github.com/lxsmnsyc/seroval/blob/7a83da9b0e6a4a460ab0380a839e76d7876bbb3e/packages/seroval/src/core/context/sync-parser.ts#L907); [`sync-parser.ts#L972`](https://github.com/lxsmnsyc/seroval/blob/7a83da9b0e6a4a460ab0380a839e76d7876bbb3e/packages/seroval/src/core/context/sync-parser.ts#L972); [`Serializer.ts#L41`](https://github.com/lxsmnsyc/seroval/blob/7a83da9b0e6a4a460ab0380a839e76d7876bbb3e/packages/seroval/src/core/Serializer.ts#L41).
- **A5 — Document script embedding and stub batching.** [`packages/web/src/server.ts#L2108`](https://github.com/solidjs/solid/blob/49887e1b29fc6f04500b0dbc47c23d90b1ec5255/packages/web/src/server.ts#L2108); [`server.ts#L1946`](https://github.com/solidjs/solid/blob/49887e1b29fc6f04500b0dbc47c23d90b1ec5255/packages/web/src/server.ts#L1946).
- **A6 — Eval-free keyed JSON codec.** [`serializer.ts#L283`](https://github.com/solidjs/solid/blob/49887e1b29fc6f04500b0dbc47c23d90b1ec5255/packages/web/serialization/src/serializer.ts#L283); [`serializer-decode.ts#L395`](https://github.com/solidjs/solid/blob/49887e1b29fc6f04500b0dbc47c23d90b1ec5255/packages/web/serialization/src/serializer-decode.ts#L395).
- **A7 — Client adoption and hydration ids.** [`packages/web/src/client.ts#L2045`](https://github.com/solidjs/solid/blob/49887e1b29fc6f04500b0dbc47c23d90b1ec5255/packages/web/src/client.ts#L2045); [`packages/solid/src/client/hydration.ts#L394`](https://github.com/solidjs/solid/blob/49887e1b29fc6f04500b0dbc47c23d90b1ec5255/packages/solid/src/client/hydration.ts#L394); [`hydration.ts#L432`](https://github.com/solidjs/solid/blob/49887e1b29fc6f04500b0dbc47c23d90b1ec5255/packages/solid/src/client/hydration.ts#L432); `/Users/cvr/Developer/personal/effect-frame/node_modules/.bun/@solidjs+signals@2.0.0-rc.8/node_modules/@solidjs/signals/dist/types/signals.d.ts:116`; `.../dist/types/core/error.d.ts:1`.
- **A8 — Stream end, close, and abandonment.** [`server.ts#L1639`](https://github.com/solidjs/solid/blob/49887e1b29fc6f04500b0dbc47c23d90b1ec5255/packages/web/src/server.ts#L1639); [`server.ts#L2137`](https://github.com/solidjs/solid/blob/49887e1b29fc6f04500b0dbc47c23d90b1ec5255/packages/web/src/server.ts#L2137); [`server.ts#L2226`](https://github.com/solidjs/solid/blob/49887e1b29fc6f04500b0dbc47c23d90b1ec5255/packages/web/src/server.ts#L2226); [`Serializer.ts#L101`](https://github.com/lxsmnsyc/seroval/blob/7a83da9b0e6a4a460ab0380a839e76d7876bbb3e/packages/seroval/src/core/Serializer.ts#L101); [`sync-parser.ts#L998`](https://github.com/lxsmnsyc/seroval/blob/7a83da9b0e6a4a460ab0380a839e76d7876bbb3e/packages/seroval/src/core/context/sync-parser.ts#L998).
- **A9 — SSR source policies.** [`packages/solid/src/server/signals.ts#L567`](https://github.com/solidjs/solid/blob/49887e1b29fc6f04500b0dbc47c23d90b1ec5255/packages/solid/src/server/signals.ts#L567); [`signals.ts#L1319`](https://github.com/solidjs/solid/blob/49887e1b29fc6f04500b0dbc47c23d90b1ec5255/packages/solid/src/server/signals.ts#L1319); [`signals.ts#L1338`](https://github.com/solidjs/solid/blob/49887e1b29fc6f04500b0dbc47c23d90b1ec5255/packages/solid/src/server/signals.ts#L1338).
- **R1 — Row format.** [`ReactFlightServer.js#L4835`](https://github.com/facebook/react/blob/59aff3e18cb5b3a336c280bbfa57ec37999511b9/packages/react-server/src/ReactFlightServer.js#L4835); [`ReactFlightClient.js#L5227`](https://github.com/facebook/react/blob/59aff3e18cb5b3a336c280bbfa57ec37999511b9/packages/react-client/src/ReactFlightClient.js#L5227).
- **R2 — Reference sigils.** [`ReactFlightServer.js#L3073`](https://github.com/facebook/react/blob/59aff3e18cb5b3a336c280bbfa57ec37999511b9/packages/react-server/src/ReactFlightServer.js#L3073); [`ReactFlightClient.js#L2653`](https://github.com/facebook/react/blob/59aff3e18cb5b3a336c280bbfa57ec37999511b9/packages/react-client/src/ReactFlightClient.js#L2653).
- **R3 — `serializeThenable` and weak thenables.** [`ReactFlightServer.js#L1110`](https://github.com/facebook/react/blob/59aff3e18cb5b3a336c280bbfa57ec37999511b9/packages/react-server/src/ReactFlightServer.js#L1110).
- **R4 — Pending chunks and resolution.** [`ReactFlightClient.js#L493`](https://github.com/facebook/react/blob/59aff3e18cb5b3a336c280bbfa57ec37999511b9/packages/react-client/src/ReactFlightClient.js#L493); [`ReactFlightClient.js#L949`](https://github.com/facebook/react/blob/59aff3e18cb5b3a336c280bbfa57ec37999511b9/packages/react-client/src/ReactFlightClient.js#L949); [`ReactFlightClient.js#L802`](https://github.com/facebook/react/blob/59aff3e18cb5b3a336c280bbfa57ec37999511b9/packages/react-client/src/ReactFlightClient.js#L802).
- **R5 — Document embedding (Next.js).** [`use-flight-response.tsx`](https://github.com/vercel/next.js/blob/canary/packages/next/src/server/app-render/use-flight-response.tsx) lines 169, 226, 231, 270. Branch `canary`; not commit-pinned.
- **R6 — Out-of-order tolerance.** [`ReactFlightClient.js#L1658`](https://github.com/facebook/react/blob/59aff3e18cb5b3a336c280bbfa57ec37999511b9/packages/react-client/src/ReactFlightClient.js#L1658); [`ReactFlightClient.js#L694`](https://github.com/facebook/react/blob/59aff3e18cb5b3a336c280bbfa57ec37999511b9/packages/react-client/src/ReactFlightClient.js#L694).
- **R7 — Abort, halt, and close.** [`ReactFlightServer.js#L6929`](https://github.com/facebook/react/blob/59aff3e18cb5b3a336c280bbfa57ec37999511b9/packages/react-server/src/ReactFlightServer.js#L6929); [`ReactFlightServer.js#L6497`](https://github.com/facebook/react/blob/59aff3e18cb5b3a336c280bbfa57ec37999511b9/packages/react-server/src/ReactFlightServer.js#L6497); [`ReactFlightServer.js#L6528`](https://github.com/facebook/react/blob/59aff3e18cb5b3a336c280bbfa57ec37999511b9/packages/react-server/src/ReactFlightServer.js#L6528); [`ReactFlightClient.js#L5701`](https://github.com/facebook/react/blob/59aff3e18cb5b3a336c280bbfa57ec37999511b9/packages/react-client/src/ReactFlightClient.js#L5701); [`ReactFlightClient.js#L1289`](https://github.com/facebook/react/blob/59aff3e18cb5b3a336c280bbfa57ec37999511b9/packages/react-client/src/ReactFlightClient.js#L1289).
- **F1, F2 — Wire shapes and verbs.** `/Users/cvr/Developer/personal/effect-frame/packages/actor/src/http/wire.ts:13`, `:23`, `:31`, `:44`, `:50`, `:55`, `:92`, `:110`, `:117`.
- **F3 — Schema codecs and resume codec.** `/Users/cvr/Developer/personal/effect-frame/packages/actor/src/http/server.ts:26`, `:37`; `/Users/cvr/Developer/personal/effect-frame/packages/actor/src/http/client.ts:37`, `:42`; `/Users/cvr/Developer/personal/effect-frame/packages/actor/src/contract.ts:69`; `/Users/cvr/Developer/personal/effect-frame/packages/actor/src/client.ts:14`.
- **F4 — Revisions and resume.** `/Users/cvr/Developer/personal/effect-frame/packages/actor/src/ref.ts:10`, `:19`, `:33`, `:43`, `:71`; `/Users/cvr/Developer/personal/effect-frame/packages/actor/src/http/client.ts:95`, `:137`.
- **F5 — HTML host and JSON script.** `/Users/cvr/Developer/personal/effect-frame/packages/view/src/hosts/html.ts:44`, `:69`, `:172`, `:192`; `/Users/cvr/Developer/personal/effect-frame/packages/view/src/hosts/dom.ts:214`.
- **F6 — Reactive source contract.** `/Users/cvr/Developer/personal/effect-frame/packages/actor/src/source.ts:7`; `/Users/cvr/Developer/personal/effect-frame/packages/view/src/index.ts:1`.
