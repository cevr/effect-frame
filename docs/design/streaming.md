# Streamed documents

This note records how #22 (streaming SSR, serialized pending queries, and
hydration order) is built. It lists the decisions that the ticket left to
the build and the places where the build differs from the ticket text. The
ticket stays the source of the design.

Sources:

- `packages/effect-frame/src/actor/streaming.ts` — `Streaming` (browser safe):
  the records, the server half (`shell`), and the client half (`resume`).
- `packages/effect-frame/src/actor/query-client.ts` — the document seeds
  inside `QueryCache.layer`.
- `packages/effect-frame/src/actor/query.ts` — `StreamEnded`.
- `packages/effect-frame/src/view/hosts/html.ts` — `Html.renderToStream`,
  `Html.renderAwaitAll`, `Html.streamRecord`, the boundary marks.
- `packages/effect-frame/src/view/hosts/dom.ts` — `Dom.readRecords`, and the
  boundary adoption and `resolvedAhead` in `Dom.hydrate`.
- `packages/effect-frame/src/view/boundary-mark.ts` — the mark texts.
- `packages/effect-frame/src/view/runtime.ts` — the two optional host
  capabilities that a readiness boundary calls.

Proofs: the #22 rows in [the acceptance matrix](acceptance.md), and the
#28 row "A server render holds one cache for one request and releases it".

## The rule

The document is the transport. The server writes the shell, then one
`<script type="application/json" class="frame-record">` per event, in the
order the events happen. No record runs. The client reads the records the
parser appended and watches the container for the rest.

## The document

```html
<!doctype html>
<html>
  <head>
    …
  </head>
  <body>
    <div id="app">
      <!-- the renderer writes this element for Html.Document.rootId -->
      <!-- the shell: each open readiness boundary draws its fallback -->
      <!--frame-boundary:fallback-->
      <p>loading</p>
      <!--/frame-boundary-->
    </div>
    <!-- tail: actor resume payloads, form issues -->
    <div id="frame-records" hidden>
      <script type="application/json" class="frame-record">
        {"_tag":"Placeholder",…}
      </script>
      <!---->
      <script type="module" src="/client.js"></script>
      <script type="application/json" class="frame-record">
        {"_tag":"Patch",…}
      </script>
      <!---->
      <script type="application/json" class="frame-record">
        {"_tag":"Closed","patched":[…]}
      </script>
      <!---->
    </div>
  </body>
</html>
```

1. The first chunk holds `head`, the shell, `tail`, the open container, a
   `Placeholder` for every entry the shell declared, a `Patch` for every
   entry that settled while the shell rendered, and `bootstrap`.
2. Then one `Patch` per entry in settle order, then `Closed`, then
   `</div>` and `end`.
3. `Html.Document` names the four parts. The caller writes the head and the
   bootstrap tag. The framework writes nothing that runs.

`Html.streamRecord(record)` writes a record with the same escaping as
`Html.jsonScript`. A value that holds `</script>`, `<!--`, U+2028 or U+2029
cannot close its script or start a comment. An empty comment follows each
record; see "A record is read when it is whole".

## Decisions

### A record id is the query key

`Streaming.recordId(key)` is `keyOf(key)`. The ticket derived the id from
the scope path and the key. The build drops the scope path, for these
reasons:

1. The #28 cache is keyed by the query key. One entry can be declared under
   many scopes. The ticket's "an entry gains its `RecordId`" holds only for
   an id that the key alone derives.
2. The trap the ticket closes is a counted id. The key is not counted, so a
   client that renders one more scope, or its scopes in another order,
   addresses the same entries.
3. Two `ready` calls on one key are one entry and one record. That is the
   ticket's own rule for duplicates.

So `Placeholder` has no `key` field: its `id` is the key.

### Every declared entry gets a placeholder

The ticket wrote a placeholder only for an entry that was not yet settled.
The build writes one for every entry the shell declared, and a patch right
after it for an entry that already settled. So every patch has a
placeholder before it, and `Closed.patched` lists every settle, the early
ones too.

### Records land in the cache, not in a view

`QueryCache.layer` keeps a document table beside its entries. The table is
private to the source. `Streaming.shell` and `Streaming.resume` reach it
through the cache the caller provides.

- `Placeholder` marks the key as seeded and open.
- `Patch` settles the key. The first settle wins. A second patch for the
  same key changes nothing. A `late` patch, read before hydration is done,
  is held until then (see "A late patch waits for hydration").
- `Closed`, or the end of the record channel, fails every open seed with
  `StreamEnded`, held the same way.

A slot takes the seed for its key when it opens, in place of its first
read. A settled seed lands synchronously, so a view that declares the key
reads the value on its first read and starts no fetch. An open seed is
awaited in the slot's scope. A cache not built by `QueryCache.layer` has no
table. Its views read normally.

An open seed is a read that arrives by another path. It lands only when no
read started and no value landed in the slot since the slot opened. So a
client read, or a command's re-read, that completes first is never
replaced by the server's older value. The test "a seed that settles after
a client read never replaces the newer value" holds this.

Only the query's own failure is final. A `Patch` that carries
`QueryFailed` lands as the entry's failure. A `Patch` that carries any
other failure (`Unreachable`, `Unauthorized`, `StreamEnded`) describes the
server's read, not the query: it lands, and the slot reads again over
`POST /query` once hydration is done. So does a seed that fails
`StreamEnded` at the end of the channel, and a seed that lands stale.

A seed no slot took is dropped when the client runs `Resumed.hydrated`,
after its hydration finished. A key a view declares later reads over the
query path, never a value the document held since the page loaded. Seeds
are not dropped when the channel closes: a deferred module reads `Closed`
before it mounts.

A read that a landed seed calls for starts at `Resumed.hydrated` too, not
when the seed lands (review round 2). The seed is what the server drew.
A reply that came before the client's first drawing would draw a newer
value than the server's markup, and the page would not hydrate. So until
hydration is done, a seeded entry shows the seed; a read the client starts
itself, or a command's re-read, still runs at once. A principal change
runs the same point. A client that never runs `Resumed.hydrated` never
reads those keys again.

`Resumed.closed` completes after the channel ended and after every slot
that took a seed has put the seed's last state in the slot, or closed. So
right after `closed`, every live entry shows its value or its failure.

`Streaming.resume(records)` replaces the ticket's
`resumeFromDocument`. It is a module function, not a cache method, so the
cache service keeps its interface.

### One call reads the records

`Dom.readRecords` returns `{ present, later }`. The ticket split it into
`readRecords` and `observeRecords`. One call holds the one sequencing rule:
the observer is installed before the scan, so no record is lost between the
two. `later` completes on `Closed`, or on `DOMContentLoaded` when the
document ended without one. When the parser is already done, `later` is
empty.

### A record is read when it is whole

The parser can append a large record's element before all of its text.
Chrome does this for a 200 KB patch that arrives in two writes, and it
tells no `MutationObserver` about the text it appends. So:

1. A record element is marked read only when its text decodes. A part of
   a JSON object never decodes, and a failed decode is never marked read.
   The next scan reads the element again.
2. The server writes an empty comment after each record, in the same
   write. The parser appends that node when the record is whole, and the
   container's `childList` change starts the scan that reads it. Without
   it, a record would wait for the next record or for the end of the
   document.
3. At `DOMContentLoaded` every element not yet read is read once more.

The Chrome test "a patch the parser appends in parts is read whole, once,
with no second read" holds all three.

### The server marks each boundary it drew

The ticket expected the client to claim the fallback, find a different tag,
and count the discard as `resolvedAhead`. A tag compare cannot tell which
fallback to discard when boundaries nest, and a fallback may start with the
same tag as its content. The build marks every boundary instead.

1. Every readiness boundary, `Loading` or `Errored`, asks the optional host
   capability `boundaryMarks(kind)` for a comment pair. The runtime puts the
   open mark before the boundary's nodes and the close mark after them.
   The open mark names the branch between them:
   `<!--frame-boundary:fallback-->` or `<!--frame-boundary:content-->`.
   The close mark is `<!--/frame-boundary-->`. The runtime changes the name
   when a branch switch is complete, so the serialized name is always the
   branch that stands between the marks. A boundary whose branch draws
   nothing still has its pair.
2. When a boundary starts, it calls `adoptBoundary(shown)`. The runtime
   starts the boundaries the server drew in document order, so the DOM host
   takes the next open mark, and finds its close mark by counting the pairs
   nested between them.
   - The server drew the same branch: the host removes the two marks, and
     the branch claims its server nodes.
   - The server drew the other branch, in either direction: the host
     removes the whole range, counts one `resolvedAhead`, and returns
     `true`. The boundary builds its branch detached, so nothing claims a
     server node. This covers content for a fallback, and an `Errored`
     fallback for content that a `QueryFailed` patch settled before
     hydration.
3. Content that is hidden takes no marks: the server did not draw it
   either. A boundary inside detached content takes none.
4. A created node with no anchor goes before the unclaimed server children
   of its parent, and before any marks among them. They are the tail of the
   parent's children, so the host walks from the end and stops at the first
   node that is neither. A parent the client created has no server child,
   and the walk ends at once. The earlier scan from the cursor over every
   pending node cost O(M·N).
5. `Dom.hydrate(...).finish` removes the marks of every boundary the client
   never started.

Two boundaries side by side do not swap, a boundary inside a fallback
replaces only its own fallback, and a fallback that is itself a boundary
goes whole. A late patch is an ordinary reactive update: no claim. Both
capabilities are optional. A host that omits them streams and hydrates as
before.

### `StreamEnded` is a `QueryFailure`

`StreamEnded { key }` is in the `QueryFailure` union, so a view matches it
like any failure. It is also in `WireQueryError` with status 502, beside
`Unreachable`, because the wire union and the client union share one
schema. No server writes it.

### `Closed` on every exit path

`Streaming.shell(options)` returns the patch stream with `Closed`
concatenated after it. A failed patch stream is caught, and `Closed` is
still written. A shell that fails writes nothing. A client that cancels the
response gets nothing, and the client treats a document with no `Closed` as
closed.

An entry the render releases before it settles writes no patch: its watch
ends when its slot closes. The client treats it as open, so it fails
`StreamEnded` at `Closed` and reads again.

### The time limit is required

`options.closeWhen` is a required option of `Html.renderToStream` and
`Html.renderAwaitAll`. A time limit is `Effect.sleep`. A document that may
wait for ever says so with `Effect.never`. When the limit completes first:

- `renderToStream` writes `Closed` with the entries still open. The client
  fails each of them `StreamEnded` and reads it again.
- `renderAwaitAll` serializes the drawing as it is. An entry still open has
  no seed, its boundary shows the fallback on both sides, and the client
  reads it.
- Either call fails with `Html.RecordsUnsettled`, and writes nothing, when
  the drawing and its records still disagree in the final pass (see rule 2
  below). The router reports it as `DocumentTimedOut { phase: "agree" }`.

### Each render holds its own cache (#28)

`Html.renderToStream` and `Html.renderAwaitAll` build a cache from
`Layer.fresh(QueryCache.layer)` for each call and release it when the
response ends. The layer is fresh because a caller's context that was
built from the same layer carries a memo map, and `Layer.build` would give
back the caller's own cache. The test "two concurrent renders share no
entry, and each cache is gone when its response ends" failed until the
layer was fresh.

The render's cache reads through `ActorTransport` under the
`CurrentPrincipal` that the caller provides, so each read is checked by
the query's policy. A client principal change drops every seed that no
slot took. See `authorization.md`, "Streamed documents".

### `AwaitAll` writes a seed, not a channel

`Html.renderAwaitAll(view, props, document, options)` draws the view once
and keeps the drawing live. It serializes the drawing when every entry the
drawing declares has settled, no `Loading` boundary in the tree shows
its fallback, and no setup the runtime started after the frame is still
running. An unchanged set of keys does not prove that the tree is ready:
rows set up after the mount, and their readiness, arrive later.

A list row's setup runs in a fiber the tracker forks, and it can end after
the frame, inside a boundary or not, and then declare a query. The runtime
tells a host that asks, through the optional capability `setupStarted()`,
when each such setup starts, and calls the returned function when it ends
or its scope closes. Only the `AwaitAll` host counts them. The render reads
the count before it reads the declarations, so a setup that ends between
the two wakes another pass. The test "holds an AwaitAll render until it
ends, outside any boundary" holds this.

The render wakes after each branch switch, each removal in its tree, each
setup that ends, and each wait for the declared entries. An `Errored` fallback is a final
drawing and does not hold the render. A `Loading` boundary that registers
no query shows its content, so it holds nothing. The document holds no `#frame-records`. The
settled values go in one `<script type="application/json"
id="frame-query-seed">`, a JSON array of `Patch`. `Dom.readRecords` returns
the seed as `present`, so the client entry is the same for both modes.

### A route actor's snapshot is a record too (#37)

A route that declares `Route.actor` holds its reference's committed
projection (revision and encoded snapshot) in the request cache's
document. `Streaming.actorSeeds` reads what the document holds. The
shell writes each as an `ActorSeed` record at the head of the first
chunk, before the placeholders; `SSR` and `AwaitAll` write them in
`<script type="application/json" id="frame-actor-seed">`, a JSON array
of `ActorSeed`, before the query seed. They are read inside `readDrawn`
with the query seed, so an actor seed and the drawing agree (next
section). `StreamRecord` is now `Placeholder | Patch | ActorSeed |
Closed`. `Dom.readRecords` returns the actor seed script as `present`,
before the query seed, and `Streaming.resume` lands each `ActorSeed` in
the document: the first one for an actor wins. The client's route opens
its reference from it while the page hydrates, and `Resumed.hydrated`
drops every actor seed. See [route-data.md](route-data.md), decision 16.

### A server drawing shows every value its seed carries

A value goes from the cache to the drawing through a chain of sources, and
a fiber carries each step: the tracker's subscription, a `followQuery`
copy, a `zip`, a `ready`. The seed is read from the cache, which never
lags. So a drawing read at the moment its seed is read can be older than
the seed. EGW search found this: an `AwaitAll` page that followed a query
with `followQuery` and a `zip`, with no `Loading` boundary, drew
"searching…" beside a seed that carried the results. The client drew the
results from the seed, and hydration did not agree. A 20 ms wait before
the check hid it. A `Loading` boundary does not hide it: its fallback can
leave before the value reaches the content.

The rule has two halves.

1. **A source's `get` is its value now.** A pure derivation (`select`,
   `zip`, `all`, and the readiness scope's pending source) reads its
   upstream in `get`. `ready`, `readyWithStale` and `orErrored` register
   `select`s of their state source. A derivation that keeps state
   (`followQuery` and a route's query binding carry the value shown last;
   `holdSome`, under `ready` and `readyWithStale`, holds the last value)
   keeps it in one `SubscriptionRef`, and moves it in one place only:
   `advance` (`src/actor/advance.ts`). `advance` takes the ref's lock,
   runs one step over the upstream now, and publishes the result only
   when it is not `Equal` to the state. `get` advances and returns the
   state. An upstream delivery only asks for an advance: it never applies
   the value it carried. So (review round 1, findings 1 and 3):
   - `get` never runs ahead of `changes`. Every value `get` returns was
     published before it returned, in order, and an equal value is never
     published twice.
   - A delivery that arrives late reads the upstream again, so it cannot
     undo a newer value that a read already showed.
   - When a followed key moves on to one still loading, the value shown
     last stays, stale, even if only a read ever saw it.

   The first version read the upstream live in `get` over a copy that a
   fiber moved later. A read could then show B while the copy held A; a
   switch to a loading C then carried A, not B, and B never reached
   `changes`. `holdSome` had the same fault with a late delivery of A.
   The client mount reads every binding's first value with `get`, so this
   also makes the client's first drawing the value the seed holds.

2. **The server drawing reads its bindings at the seed's instant.** The
   runtime tells a host that asks, through the optional capability
   `sourceBound(catchUp)`, of each source it binds. `catchUp` reads the
   source's `get` and writes it into the drawing when it is not `Equal`
   to what the drawing shows. The HTML host of `renderAwaitAll`,
   `renderToStream` (the first shell) and the `SSR` pipeline reads its
   records, runs every `catchUp` and draws, and reads the records again.
   It repeats until the two reads agree, so a query that settles between
   them is read again. The drawing then shows no less than the records
   carry, and no more. The equality check stops a render that waits from
   writing the same values again on each pass.

   Records that change on every pass would keep the reads going for ever,
   so the document's limit (`closeWhen`) ends them in every pipeline:
   `AwaitAll`, the streamed shell, and `SSR` (`renderSeeded` now takes
   the limit; the router passes the request's) (review round 1, finding
   4). A pass that starts after the limit is the last. If its two reads
   agree, the document is written. If they do not, a query moved after
   the catch-up drew, and nothing proves the drawing shows what the
   records carry: the call fails with `Html.RecordsUnsettled` and writes
   nothing, in all three pipelines. The router's document reports it as
   `DocumentTimedOut { phase: "agree" }`, and the prerender build as
   `PrerenderTimedOut { phase: "agree" }`, so the caller answers another
   way (EGW answers the client-only page). Round 1 wrote the last read as
   it was; a query that settled between the catch-up and that read put a
   newer value in the seed than in the HTML (review round 2). Writing a
   coherent snapshot instead would need the records read in the same
   synchronous step the drawing caught up from, and the fiber runtime can
   yield between the two, so the render refuses.

3. **A value the server shows stale is seeded stale.** A patch carries
   `stale: true` when the server's entry showed its value stale: a read,
   refresh or command it waits for was open, or `override` set it. The
   client seeds such a value `Ready{stale: true}` and reads it again once
   hydration is done, as it does a prerendered value. Before this, the
   server drew the flag and the client seeded `stale: false`, so a view
   that shows the flag did not hydrate (review round 1, finding 2). In
   round 1 the read started when the seed landed, so a reply that came
   before the first drawing drew the fresh value against the stale markup;
   it now waits for `Resumed.hydrated` (review round 2).

Prerender uses the `AwaitAll` pipeline, so it gets the rule too.

#### Mutations

Each mutation was applied alone, and
`tests/view/streaming-delivery.test.tsx` was run. The original code
fails four of its five tests (it passes "a value that settles late draws
too" by the order of its fibers).

| Mutation                                                              | Failed                                                                                  |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `catchUp` never writes (`runtime.ts`, `track`)                        | "a view that follows a query with no boundary…", "a boundary whose value goes through…" |
| `followQuery`'s `get` returns the copy, not the entry carried over it | all four red tests                                                                      |
| `holdSome`'s `get` returns its last value, not the source's           | "a boundary whose value goes through several sources…"                                  |
| A readiness scope's pending `get` is a constant                       | "a boundary whose value goes through several sources…"                                  |

The second read in `readDrawn` had no mutation test here: a query that
settles between the two reads needs a fiber order that no test can hold.
Review round 2 holds it another way: a binding that moves only when a
catch-up reads it stands for the lagging one, and a later binding writes
the query inside the same catch-up (`Moving` in the streaming fixture).

Review round 1. Each mutation was applied alone, and
`tests/view/stateful-sources.test.tsx` and
`tests/view/streaming-delivery.test.tsx` were run. On the code before the
round, both stateful-source tests fail, "is seeded stale, and the page
hydrates with no mismatch" fails, and "end at the limit…" does not end
(it times out).

| Mutation                                              | Failed                                                                                 |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `advance` publishes an equal value too                | both stateful-source tests                                                             |
| `followQuery`'s `get` reads the ref without advancing | "a value a read showed stays on screen stale…" and four drawing tests                  |
| `holdSome` applies the value a delivery carried       | "a late delivery never undoes a value a read showed"                                   |
| a patch drops `stale`                                 | "is seeded stale, and the page hydrates with no mismatch"                              |
| `readDrawn` ignores the limit                         | "end at the limit: AwaitAll, the streamed shell and SSR each write a document" (hangs) |

Review round 2. Each mutation was applied alone, and the named tests were
run. The mutation is the code before the round's repair, so each test is
red on that code.

| Mutation                                                     | Failed                                                                                                                                                                                                                      |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a landed seed's read starts when it lands, not at `hydrated` | "a read that answers at once waits for hydration…" (mismatch `"Draft:true"` became `"Alpha:false"`)                                                                                                                         |
| `readDrawn` ignores `agreed` and returns the last read       | "AwaitAll, the streamed shell and SSR never write a seed the markup does not show" (mismatch `"Alpha:false"` became `"Draft-1:true"`); "end at the limit…" (hangs); route-data "fails DocumentTimedOut { phase: "agree" }…" |

#### Update: a streamed view with no boundary (0.26.2)

The first version of this rule left a known limit: a streamed view with no
boundary reported a mismatch when a patch beat hydration. The next section
removes it.

### A late patch waits for hydration; a boundary may draw it ahead

EGW search found the fault. From 0.20.1 (the rule above: the client mount
reads each binding's first value with `get`), a patch that the server
wrote after its shell, and that the client read before it hydrated, was in
the client's first drawing. The shell drew that entry open. So two views
did not hydrate:

- A text with no boundary: the shell holds "searching…", and the client
  drew the results. Hydration reported a mismatch, and the client's text
  won. EGW logs a mismatch, and its browser suite fails on it.
- A `Query` (a `Match`, so no marks): the client drew the `Ready` branch
  over the nodes of the `Loading` branch. `Dom.hydrate` claims an element
  by its tag, and a claimed element keeps its static attributes, so the
  results kept `aria-busy="true"` and `class="hit skeleton"`. No mismatch
  was reported.

The rule that fixes both is the one a seed already follows (review round
2, above): until hydration is done, an entry shows what the server drew.

1. **A late patch says so.** `Streaming.shell` writes `late: true` on each
   patch after the shell (`Patch.late`). A patch in the first chunk is the
   shell's own: the drawing shows it. The wire is the only place the
   client can learn this. A deferred module runs after the whole document
   is parsed, so every record is `present` when it starts.
2. **The cache holds a late settle until hydration is done.** The document
   table puts it in `Seed.held`, not `current`: a slot that takes the seed
   stays `Loading`, as the shell drew it. `Resumed.hydrated` (`expire`)
   lands each held settle, and the update is an ordinary reactive one,
   after the claims. A `StreamEnded` that `Closed` writes is late too. A
   late patch that arrives after hydration lands at once, as before.
   The held settle binds to the slot that took the seed: it is the slot's
   `heldSeed`, and it reads `None` once a read supersedes the seed or the
   slot closes. A slot opened later for the key never reads it (review
   round 1).
3. **Channel closure and hydration stay independent.** `Resumed.closed`
   waits for the seeds that landed, never for a held one, so it completes
   before hydration too. `Resumed.hydrated` lands each held settle and
   waits until each slot that took one shows it. A client can await them
   in either order, and after both, every taken seed is on screen
   (review round 1). A slot takes a seed and registers its publication
   in one uninterruptible step, so an interrupted open never leaves
   either one waiting (review round 2).
4. **A boundary may draw it ahead.** A readiness boundary has marks, so it
   can replace the server's branch (`resolvedAhead`). An entry's state
   source carries its held settle as a capability (`src/actor/read-ahead.ts`).
   `QueryCache.open`, `followQuery` and a route's query binding carry it; a
   derived source (`select`, `zip`) does not. `ready`, `readyWithStale`
   and `orErrored` read through `readAhead`, which shows the held settle
   in place of `Loading` while the boundary's `ReadAhead` flag holds.
   - A boundary gives its children the flag set when they run, so its
     first branch counts the held settles.
   - When it starts (`RetainedNode.started`), the flag stays set only if
     the hydrating host found the server's other branch and the boundary
     drew its own fresh. Then nothing below claims a server node.
   - If the boundary claims the server's branch, the flag is cleared, and
     every source below it shows what the server drew. An `Errored`
     boundary whose content binds the source `orErrored` returns is the
     case this matters for: a late value fails nothing, so its content is
     claimed, and it must show the server's text until hydration is done.
   - A nested boundary's flag is its own or its parent's.

So a claimed node always shows what the server drew, and hydration
reports no mismatch for a late patch, with or without a boundary.

**Why not a mark for each control.** The other fix gave `Show`, `Match`
and `Query` comment marks, so a control could replace the server's branch
as a boundary does. It fixes the `Query`, but not a text with no control
around it, such as EGW's status line: a text has no branch to replace. It
also puts marks around every control of every server page. The rule above
fixes both cases at the one owner, the document table, and it keeps
`resolvedAhead` for the boundaries that #22 specified it for.

**Why not hold every late settle, with no read-ahead.** That is simpler,
and it is correct: a boundary claims the fallback and draws its content
once hydration is done. But `resolvedAhead` would then never count a
patch, and a boundary would draw its fallback's setup only to throw it
away. The acceptance rows for #22 prove the read-ahead; they stay.

**One build writes both sides.** The server document and the client
bundle must come from one build. `late` is an optional field, so a
mismatched pair still decodes: an old client strips it, and a new client
reads a patch without it as a shell patch that lands at once (the
behaviour before this fix, proven by "a patch with no late flag lands at
once"). But either pair keeps the hydration fault this section fixes. A
deploy that serves HTML from one build and assets from another is out of
scope.

**Remaining limit.** A boundary over a derived source (`View.ready(Source.select(...))`)
cannot read ahead: it claims its fallback and draws the content once
hydration is done. It reports no mismatch. `resolvedAhead` does not count
it.

Tests: `tests/view/streaming-hydrate-order.test.tsx` holds the wire flag,
the text with no boundary, the `Query` and its attributes, the claimed
`Errored` content, a boundary that draws ahead beside a text that
reads the same key and waits, `closed` and `hydrated` in either order, a
read-ahead that ends when its slot closes or a read supersedes it, and a
patch with no `late` flag. The hand-built patches that the streaming
tests append after the first chunk now carry `late: true`, as the server
writes them (`lateRecord`).

#### Mutations

Each mutation was applied alone, and the new test file,
`streaming.test.tsx`, `streaming-edges.test.tsx` and
`tests/router/route-data.test.tsx` were run (63 tests).

| Mutation                                       | Killed by |
| ---------------------------------------------- | --------- |
| A late settle lands at once (no hold)          | 4 tests   |
| A boundary never clears its flag               | 1 test    |
| An entry carries no held settle                | 7 tests   |
| The shell marks no patch late                  | 7 tests   |
| `ready` reads without the flag (no read-ahead) | 7 tests   |
| `closed` waits for a held seed                 | 1 test    |
| `hydrated` does not wait for publication       | 2 tests   |
| A held seed ignores a superseding read         | 1 test    |
| A held seed outlives its slot                  | 1 test    |
| `closed` waits for no landed seed              | 1 test    |

### A streamed shell does not wait for a late setup

`Html.renderToStream` serializes the shell right after the first frame. A
list row whose setup ends later is not in the shell, and a query it
declares then has no placeholder and no patch: the stream watches only the
entries the shell declared. The client draws the row when its own setup
ends, after hydration, and reads the query over `POST /query`. The test "is
not in a streamed shell: the client draws the row and reads its query"
holds this.

### The modes are functions

The ticket put `RenderingMode` on #18's route type. The route type does not
carry it yet, so the modes are three functions: `Html.renderToString`
(unchanged), `Html.renderToStream`, and `Html.renderAwaitAll`. The router
will choose one per route. `ClientOnly` is not built.

Update (#36): the router chooses now. A mode is a mount constructor
(`Route.client`, `Route.ssr`, `Route.streamed`, `Route.awaitAll`), and
`renderDocument` runs these pipelines over the matched tree. `ClientOnly`
draws nothing on the server. See [route-data.md](route-data.md).

### The HTML host holds no `</script` in its source

The HTML host builds its script close tag at run time. A browser bundle of
`effect-frame/view` keeps the host, because Bun keeps each `Effect.fn`
value. The DOM benchmark writes its bundle inline in a `<script>`, and a
literal close tag in `jsonScript` ended that script early. The test "a
bundle of the view entry holds no script close tag" holds the rule.

### WebKit runs no external script before the parser ends

Bun.WebView's WebKit runs an external script, `async` or not, only after
the document ends. Inline script runs at once, but the policy forbids it.
So in WebKit, every patch is in the document before the client runs, and a
late patch cannot occur. The late path is proven in Chrome and in
happy-dom. A document is correct in both engines.

## What stays open

- The op wire row. The server-driven op wire (#15, #27) is not on main.
  `Resumed.closed` is the gate it must wait on, with hydration finish.
- The notes app does not stream yet. Its server answers
  `Html.renderToString`. The streamed refused-form path is proven in the
  package: "a refused page streams with its issues and hydrates under them
  with no mismatch".
