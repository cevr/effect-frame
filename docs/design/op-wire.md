# The op wire

This note records how #87 builds the server-driven op wire that #15
decided, and reconnect over it as #27 decided. It lists the decisions that
the tickets left to the build, and the places where the build differs from
the prototype, because the stack changed after the prototype was written.
The tickets stay the source of the design.

Sources:

- `packages/effect-frame/src/view/hosts/remote.ts` (browser safe, `Remote`
  on `effect-frame/view`): the wire schemas, `StaleClient`, `UnknownNode`,
  the recorder and its shadow, `draw`, and `client`.
- `packages/effect-frame/src/view/driven.server.ts` (server only,
  `effect-frame/view/driven`): `session`.
- `packages/effect-frame/tests/view/remote.test.tsx`: every proof below.
- The prototype this promotes: `packages/view/prototypes/remote-host.ts` and
  `packages/view/tests/server-wire.test.tsx` on the local branch
  `prototype/server-wire` (Rift `.rifts/effect-frame/prototype-server-wire`,
  commit `93bcf80`). `morph.ts` is not promoted, as #27 decided.

## The model

```ts
// Server: one session per connected client.
const serve = Effect.gen(function* () {
  const session = yield* Driven.session(RoomView, props, { contract: Room, key });
  send(session.resume); // the drive's snapshot: the first message, every time
  yield* Effect.forkScoped(Stream.runForEach(received, session.fire)); // events back
  yield* Stream.runForEach(session.patches, (patch) => send(encode(patch)));
});

// Client: draw from the snapshot, then follow the patches.
const client = Remote.client(RoomView, props, { contract: Room, key }, { host, root, send });
const follow = Effect.gen(function* () {
  yield* client.resume(payload); // the first connect and every reconnect
  yield* client.apply(patch); // ForeignSession, StaleClient, or UnknownNode, and nothing applied
});
```

A session mounts the view on a fresh recorder at the drive actor's latest
snapshot. It sends the snapshot, not the operations of that first drawing,
with its own session id and a digest of the tree it drew.
The client draws the view from the snapshot on a recorder of its own and
replays the operations it gets. The two recorders give the same ids,
because a drawing is a function of its snapshot. That is the one
precondition a server-driven view must meet: its drawing depends on its
props and its drive's snapshot, and nothing else. The client checks it
against the digest before it applies anything (decision 22). After that, each patch
carries the operations of one or more changes, with the writes that would
not change the client's tree left out.

A reconnect is the same door. The client does not say how old it is. It
gets the latest snapshot, removes what it drew, and draws again at
position 0. The session it left kept no operation and no snapshot for it.

## Decisions

1. **One recorder, and it always elides.** The prototype had
   `recorder({ elide })`. The log without elision was the baseline for a
   measurement, and #15 chose the eliding recorder. The option is gone.
2. **The shadow keeps child order exactly.** The prototype dropped an insert
   when the node's last recorded parent and anchor were unchanged. That
   drops a real move: with `a, b` drawn, "insert `a` last" has the same
   recorded anchor (none) as before, so the prototype sent nothing and the
   client kept `a, b`. The shadow now holds each node's parent, both
   neighbours, and each parent's last child. It drops an insert only when
   the node already sits directly before the anchor, the one case in which
   `insertBefore` changes nothing. A remove is recorded only when the node
   is a child of that parent, as the DOM host removes only such a child.
   This is #15 risk 4 at package level; the Chat row with 200 random
   messages stays open with its example.
3. **Patch positions count the frames of one session, not actor
   revisions.** #27 speaks of "revisions". A server-driven view also redraws
   on state that has no revision, such as a server-side cell a handler
   writes. A patch is cut when the drawing is whole, and one revision can
   reach the view over more than one source. So `Patch.from` and `to` are
   positions from 0, the drawing the resume payload gives. The actor
   revision travels only in the resume payload. `StaleClient` keeps its
   job: a patch whose `from` is not the held position is refused whole.
   Every session counts from 0, so a position alone does not name a
   session; decision 17 adds the session id.
4. **Every session starts with the resume payload.** No first-mount patch
   crosses the wire, on a first connect or on a reconnect. `session.resume`
   is the payload, and `session.patches` starts at position 0.
5. **The client rebuilds by drawing on its own recorder.** `Remote.draw`
   mounts the view on a fresh recorder with a transport that holds only the
   snapshot, waits for the drawing to be whole, drains it, and closes the
   mount. The client replays those operations against its host. The other
   option, numbering the nodes of a live DOM mount, keeps a second reactive
   mount on the client. That mount would have to stay inert, and its
   cleanup would remove nodes that the server's operations then address.
   With `draw`, "rendering is deterministic from a snapshot" is the
   correctness condition of reconnect, and its test runs the real path.
6. **A session pins the snapshot for its mount, then releases it.** The
   session reads the drive's snapshot once. The view's reference is served
   that same projection, so the drawing is the one the payload describes.
   Without the pin, a revision that lands between the read and the mount
   gives the server a newer tree than the client draws. The pin is released
   once the drawing is whole, and `retained.snapshot` says so. The pin
   covers the snapshot read only; decision 18 holds back the changes too.
7. **A drawing is whole when no late setup is running.** The recorder
   counts setups through `setupStarted`, as `Html.renderAwaitAll` does. A
   list row whose setup ends after the frame is drawn is in the drawing on
   both sides.
8. **A driven view draws from one actor, its drive.** On the client, the
   held transport serves the drive's snapshot, never delivers a change,
   sends nothing, and reads no query. Any other read fails `Unreachable`
   with a reason. The server refuses the same reads (decision 19). A
   second actor or a query in a server-driven view is not in this slice.
9. **The resume payload has the shape `resumeCodec` writes, read without the
   contract.** It is `{ session, revision, state, digest }` in one JSON
   string; `revision` and `state` are the shape `resumeCodec` writes. The session
   writes it from the committed projection, and `draw` reads it back into a
   projection. The reference decodes the state with the contract's own
   codec. This keeps the wire code free of a contract's generic types.
10. **An operation that names an id the client does not hold refuses the
    whole patch.** The prototype skipped such an operation. That is the
    silent failure #15 and #27 reject. The client checks every id a patch
    names before it applies any operation, and fails with `UnknownNode`.
    It does not catch an id space that has drifted but still names nodes
    the client holds; the determinism of `draw` is what prevents that.
11. **An event carries its listener id and its value, and nothing else.**
    On the server, the handler gets `form: None`, and `preventDefault` does
    nothing. A form in a server-driven view does not post its fields over
    the wire; a client child view (#24) owns forms. A behaviour (`attach`)
    never runs on the recorder, as on the HTML host.
12. **The server half is a server module; the recorder is not.**
    `driven.server.ts` is reachable only through `effect-frame/view/driven`.
    The recorder, `draw`, and `client` are in `Remote` on
    `effect-frame/view`, because the client draws too.
13. **`session.patches` has one subscriber: the connection.** Two
    subscribers would split the frames between them.
14. **No connection transport.** The session and the client exchange
    values. A connection encodes them with `Remote.PatchJson` and
    `Remote.RemoteEventJson`. The socket, `Route.driven` (#18), and the
    Chat example (#43) come later, and no row in this slice needs them.

15. **A mount runs pending reactive work before it opens its root.** This
    is a runtime fix that the op wire exposed. `mount` flushed Solid inside
    its own `createRoot`. When another mounted view had a list update
    pending, that flush created the new rows under the new mount's root.
    A render that closes at once, such as `Html.renderToString`, then
    disposed the rows' bindings, and those rows stopped following their
    items. The server session and the test's reference render run side by
    side, so the drift test hit it. `mount` now flushes before it creates
    its root. The runtime test "a row added just before another view mounts
    and closes stays live" in `tests/view/list-moves.test.tsx` proves it on
    the DOM host, without the wire.
16. **`settled` does not yield before it flushes.** A yield there was tried
    as a guard for a Deferred that resumes inside a flush. No test needed
    it, and its mutation survived, so it was removed.

17. **Every patch names its session.** Counsel round 1 found that an old
    session's `0→1` patch applied on a client that had just resumed from a
    new session, because both count from 0. The session id is fresh for
    each `Driven.session`, from the platform's secure UUID source, as
    command ids are (never the application's `Random`, which a test may
    seed). It travels in the resume payload and in every `Patch`. The client
    keeps the id it resumed from and refuses any other with
    `ForeignSession`, before it checks the position. Before the first
    resume it holds none and refuses every patch.
18. **The drive's changes wait for the first drain.** The pin (decision 6)
    covered only the snapshot read. The view's reference subscribed to live
    changes during the mount, so a commit while a late row setup was still
    running reached the server's drawing, and the first drain dropped
    those operations with the rest; the client drew the older snapshot and
    never got them. The session now serves the drive's `changes` through a
    stream that waits on a `Deferred` completed after the first drain. The
    reference asks for the changes after the pinned revision, so the held
    changes arrive as the first patches and none is lost.
19. **One transport definition for both sides.** The server forwarded a
    second actor's snapshot, its changes, and every query to the real
    transport, where the client refused them, so a view could mount on the
    server and fail to resume. `drive-transport.ts` (internal) builds the
    transport both sides draw with: the drive's reads, whatever each side
    serves for them, and `Unreachable` for every other read, with one
    reason. Commands differ on purpose: the server sends a handler's
    command to the real transport, because handlers run there; the client
    sends nothing.
20. **A session holds at most `limit` undrained operations.** A client that
    stops taking patches let `record` grow without bound. The limit is an
    option on `Driven.session` (default `Driven.defaultLimit`, 10 000),
    counted from the first drain, because the first drawing is never sent.
    One operation past it, the recorder drops what it holds and stops, the
    session closes its mount and releases the recorder, and `patches` ends
    with `Backlogged`. The client must resume from a new session. A
    slow client costs the limit, never the backlog.
21. **A node's life ends with its owner, and the wire says so.** A removed
    node was never forgotten: the shadow and the client's id map grew with
    every row ever drawn. A remove is not the end of a node: a retained
    branch removes its nodes when it hides and inserts them again when it
    shows. The runtime already ends each node with the owner that drew it
    (the presentation host forgets there). The new optional `Host.forget`
    capability hears that end: `mount` wraps each create so the node's
    owner cleanup calls it. The recorder queues the id and, at the next
    drain, forgets it in the shadow and appends a `Forget` op after the
    patch's other operations, because an owner may end before the runtime
    writes its remove (a hidden branch is disposed, then removed). The
    client drops the id; a later operation that names it is `UnknownNode`.
    A dropped row costs one `Forget` for each node it drew.
22. **The drawing's precondition is checked, not assumed.** A view that
    reads the clock, a random number, or a service the two sides hold
    differently draws a different tree from the same snapshot, and later
    patches would address the wrong nodes. The resume payload carries a
    digest of the server's first drawing; the client draws, digests its
    own drawing, and fails with `Diverged` before it removes or applies
    anything. No patch can repair a divergence; the page must be drawn
    again from markup. The digest is of the tree the operations leave (each
    node by id with its tag, sorted properties, text, and children, and each
    listener by id), not of the operation order: a row whose setup ends
    late inserts its list before its rows on one side and after them on
    the other, and both trees are the same. It is 32 bits of `Hash.string`
    as fixed-width hex: a check, not a secret. Each property value is
    written with its type and its text (counsel round 2): JSON writes `NaN`
    and both infinities as `null` and `-0` as `0`, so a drawing with
    `title={NaN}` and one with `title={Infinity}` gave one digest. Now
    `NaN`, `Infinity`, `-Infinity`, `-0`, `0`, and the strings that spell
    them all differ.
23. **An event may name only a listener a drained patch gave out.** Ids
    count up, so a client could guess a listener made after the last patch
    it got and run its handler. Every such handler belongs to the client's
    own view, so this is no authority breach, but the wire should not reach
    what it has not delivered. Each drain records the highest id made so
    far, and `fire` ignores a higher one, as it ignores an unknown or a
    removed one. Each handler still authorizes its own command.
24. **Patches are trusted server output.** A client checks a patch's shape,
    its session, its position, and every id it names. It does not sanitize
    property names, values, or URLs, as the DOM host does not sanitize a
    view's own properties. A patch from anyone but the server is outside
    this design.

25. **The wire carries every property value exactly.** `Host.PropertyValue`
    is any `string | number | boolean`, but the wire's value was
    `String | Finite | Boolean`, so a patch that set a non-finite number
    failed to encode at the connection (`PatchJson` raised a
    `SchemaError`), and the client never got it. The value is now a union
    of a string, a boolean, a finite number, and an `{ number }` object for
    the four numbers JSON cannot write: `"NaN"`, `"Infinity"`,
    `"-Infinity"`, and `"-0"`. Effect's `Schema.Number` JSON codec writes the
    first three as bare strings, which a union with `String` decodes as
    strings, and it writes `-0` as `0`; a tagged object is taken for
    neither. `-0` is carried, not folded into `0`, because the DOM host
    receives the value the view set, and a property may tell them apart.

## Evidence

All in `packages/effect-frame/tests/view/remote.test.tsx`.

| Row                                                                   | Test                                                                                                       |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| A reconnecting server-driven client resumes from the actor's snapshot | "a reconnecting client resumes from the actor's snapshot"                                                  |
| A reconnect costs the snapshot, not the first-mount op log            | "a reconnect costs the snapshot, not the first-mount op log": 1084 B against 10185 B (193 ops) at 20 notes |
| A client of any age reconnects at constant cost                       | "a client of any age reconnects at constant cost": 2, 10, and 40 missed revisions give one payload size    |
| A stale patch is refused and never silently applied                   | "a stale patch is refused and never silently applied"                                                      |
| The server holds no per-client history                                | "the server holds no history for each client"                                                              |
| A rebuilt server-side mount reproduces the client tree exactly        | "a rebuilt server-side mount reproduces the client tree exactly"                                           |
| Rendering is deterministic from a snapshot                            | "rendering is deterministic from a snapshot"                                                               |

The resume grew from 1015 B with the session id and the digest; the test
asserts less than a fifth of the rebuild patch. The rebuild patch is
smaller than #27's 22489 B because the view has no
compose form and an absent anchor is an absent key, not `{"_tag":"None"}`.

The other tests prove the wire the rows stand on: a resumed client follows
patches to the HTML host's tree; a toggle in twenty notes sends one
`SetProperty`; an event reaches the server's handler and its change comes
back; the shadow keeps child order; the shadow does not drift over 60
changes from a seeded Park and Miller generator (an earlier generator gave
only toggles, and hid decision 15); a drawing waits for late row setups; a resume
releases every listener; and a revision that lands during the mount is
drawn on both sides.

Counsel round 1 added, in "what a session and a client guarantee each
other (#87)": "a patch from another session is refused, even at the held
position" (decision 17); "a change that lands while a late row is still
drawing reaches the client" (18); "a view that reads a second actor fails
on the server as it fails on the client" (19); "a client that stops
taking patches costs the limit, not the backlog" (20); "adding and
dropping rows for a long time holds a fixed number of nodes", 200 cycles
on the server and the client (21); "a view that draws differently from
the same snapshot fails the resume" (22); and "an event may name only a
listener a patch has delivered" (23).

Counsel round 2 added "a drawing with NaN where the server drew Infinity
fails the resume" and "a digest tells every property value apart"
(decision 22), and "every number a view can bind crosses the wire as it
is": `NaN`, both infinities, `-0`, `0`, and `1.5` pass through
`PatchJson` and reach the client host unchanged (decision 25).

## Mutations

Each mutation was applied alone, `tests/view/remote.test.tsx` was run, and
the change was reverted.

| Mutation                                                | Result | Test that failed                             |
| ------------------------------------------------------- | ------ | -------------------------------------------- |
| An insert is never elided                               | Killed | the shadow test                              |
| A property write is never elided                        | Killed | the toggle test                              |
| A text write is never elided                            | Killed | the toggle test                              |
| A remove is never elided                                | Killed | the shadow test                              |
| The in-place check reads the parent only                | Killed | the shadow test                              |
| `place` does not link the node to its anchor            | Killed | the shadow test                              |
| `unlink` leaves the next node's back link               | Killed | the shadow test                              |
| `unlink` leaves the previous node's forward link        | Killed | the shadow test                              |
| The client does not check `from`                        | Killed | the stale test                               |
| The client does not check the ids a patch names         | Killed | the stale test                               |
| The session keeps its first-mount operations            | Killed | six tests, the no-history test among them    |
| The session never releases the pin                      | Killed | the no-history test                          |
| `release` keeps the shadow                              | Killed | the no-history test                          |
| The mount reads the latest snapshot, not the pinned one | Killed | the mount race test                          |
| Ids come from a counter shared by recorders             | Killed | eight tests, the determinism test among them |
| `resume` keeps the old tree                             | Killed | the resume, any-age, and rebuilt-mount tests |
| `resume` removes no node                                | Killed | the resume, any-age, and rebuilt-mount tests |
| `resume` keeps the old position                         | Killed | the resume and rebuilt-mount tests           |
| `resume` keeps the old listeners                        | Killed | the listener test                            |
| The session does not advance its position               | Killed | four tests, the stale test among them        |
| The resume payload carries the op log                   | Killed | every test, the cost test among them         |
| The resume payload grows with the revision              | Killed | the cost and any-age tests                   |
| A drawing ignores late setups                           | Killed | the late setup test                          |
| The client sends a wrong listener id                    | Killed | the event and rebuilt-mount tests            |
| `mount` flushes inside its own root (decision 15)       | Killed | the list-moves runtime test and drift test   |
| The client ignores the session id                       | Killed | the other-session test                       |
| `resume` keeps the old session id                       | Killed | twelve tests                                 |
| The drive's changes are not held until the drain        | Killed | the late-row change test                     |
| Held changes start from the latest, not the pinned one  | Killed | the late-row change and mount race tests     |
| The session mounts with the real transport              | Killed | the second-actor test                        |
| No backlog limit                                        | Killed | the stalled-client test                      |
| An overflow leaves the mount open                       | Killed | the stalled-client test                      |
| Patches keep flowing after an overflow                  | Killed | the stalled-client test                      |
| The runtime never tells the host a node ended           | Killed | the add-and-drop test                        |
| The recorder ignores `forget`                           | Killed | the add-and-drop test                        |
| A drain keeps the shadow of forgotten nodes             | Killed | the add-and-drop test                        |
| The client keeps forgotten nodes                        | Killed | the add-and-drop test                        |
| The client skips the digest check                       | Killed | the diverging-view test                      |
| The digest leaves out text                              | Killed | the diverging-view test                      |
| `fire` ignores delivery                                 | Killed | the delivered-listener test                  |
| A drain never marks listeners delivered                 | Killed | the delivered-listener, event, rebuilt tests |
| Canonical values go through JSON again                  | Killed | the NaN-against-Infinity and digest tests    |
| Canonical values lose their type                        | Killed | the digest test                              |
| The canonical form writes `-0` as `0`                   | Killed | the digest test                              |
| The wire value is `Finite` again                        | Killed | the every-number test                        |
| The wire carries `-0` as `0`                            | Killed | the every-number test                        |

Every mutation above was run again after counsel round 1, with its
pattern moved where the code moved, and each was killed again.

Two mutations survived in the first rounds. `unlink` left each parent's first-child link stale:
nothing read that link, so it was deleted rather than tested. `settled`
without its first yield: no test needed that yield, so it was removed
(decision 16). The runtime mutation also ran `tests/view/list-moves.test.tsx`.

## What stays open

- **The op wire starts only after the document closes** (#22). This is
  done in the package by `Route.driven` (#36, `docs/design/driven-route.md`):
  a client adopts a driven leaf's server nodes through `resume` over a
  hydrating host, and no leaf connects before `OpWire.ready`. The
  application half, a real connection and its tests, belongs with the Chat
  example (#43).
- **Ids are never reclaimed** (#15 risk 5). A long session counts up. A
  reconnect starts the count again.
- **The shadow is memory per connected client** (#15 risk 3). It is state,
  not history: one entry per live node and property (decision 21), and
  the undrained operations are bounded (decision 20). It is released when
  the session's scope closes.
- **A second actor or a query in a driven view** (decision 8).
- **Form submissions over the wire** (decision 11).
