# Driven routes

This note records how #36 builds `Route.driven`: the mode of #18 §6 whose
leaves are drawn over the op wire, and the hand-over of #22 §5, where the
wire opens only after the document is over and adopts the nodes that the
document drew. It lists the decisions that the tickets left to the build.
The tickets stay the source of the design. The Chat example (#43) is the
application half and is not built here.

Sources:

- `packages/effect-frame/src/router/driven.tsx`: `Route.drivenView`,
  `Route.OpWireService`, `Route.WireFailed`, and the client's follow loop.
- `packages/effect-frame/src/router/hydrate.ts`: `hydrate`, the client half
  of a page load, which owns the op wire's start.
- `packages/effect-frame/src/router/branch.ts`: `Route.driven`, the
  definition-time refusal, and `Route.drivenAt`.
- `packages/effect-frame/src/view/hosts/dom.ts`: `Dom.hydrate` leaves the
  children of a driven container alone.
- `packages/effect-frame/src/view/hosts/remote.ts`: `Remote.Client.detach`.
- `packages/effect-frame/tests/router/driven.test.tsx`: the proofs.

## The model

```ts
const room = Route.child(shell, "room", { path: ":room", params: RoomParams });

const Rooms = Route.driven(
  "rooms",
  Route.layout(
    shell,
    [
      Route.leaf(
        room,
        Route.drivenView({
          drive: (params) => ({ contract: Room, key: params.room }),
          view: RoomView, // (params) => Effect<Node, E, ActorTransport | Scope>
        }),
      ),
    ],
    ShellView, // any view: it hydrates and streams
  ),
);

// The flat form: one driven leaf.
const Room1 = Route.driven("room", { path, params, search, drive, view: RoomView });
```

A driven tree is rendered as `Streamed`. Its layouts are ordinary views:
they hydrate, and their queries stream. Only its leaves are driven.

## What each side does

1. **The server's document.** A driven leaf draws its view inside one
   container, `<div data-frame-driven>`, over a transport that serves the
   drive and refuses every other read, as a session's transport does. The
   leaf knows that it draws a document from `SettledRequest`.
2. **The client's page.** The same leaf draws the container only, with no
   children. `Dom.hydrate` claims the container and does not walk its
   children, so the server's nodes stay as they are, with no mismatch.
3. **The hand-over.** `hydrate({ routes, notFound, root, wire })` reads the
   records, mounts the tree over the server's nodes, and finishes
   hydration. Once hydration is done and the record channel has ended
   (`Streaming.Resumed.closed`), each driven leaf connects for the page's
   URL. `Remote.client.resume` draws the view from the session's
   snapshot through a hydrating host over the container, so it adopts the
   server's nodes. Then the client follows the patches through `Dom.host`.
4. **The server end.** `Route.drivenAt(routes, url)` gives the view, props,
   and drive of the driven leaf at a URL. The application opens
   `Driven.session` with them.

## Decisions

1. **A client-only view is a view that needs a service other than
   `DrivenServices`** (`ActorTransport | Scope`). Such a view is drawn from
   something the session cannot replay. `Route.drivenView` and the flat
   form refuse it at the type level. `Route.driven` refuses a tree with a
   leaf whose view is not a `Route.drivenView` when the tree is declared,
   with `BranchRejected`. A leaf's view type cannot show that it came from
   `drivenView`, so that check is at definition time, not at the type level.
2. **`Route.drivenView` is a view, not a leaf.** A driven leaf is a
   `Route.leaf` with a driven view, so the leaf keeps its segment, data,
   options, and `errored` view. A driven view that can fail makes its leaf
   name an `errored` view, as any leaf does. The flat form takes a view
   that cannot fail, as every flat route does.
3. **No new rendering mode.** The document of a driven tree is `Streamed`.
   The wire is the difference, and it starts after the document.
4. **`hydrate` owns the wire's start.** It is the one owner that sees both
   the end of the record channel and the end of hydration, so it holds the
   wire until both, and it is the only way a page reaches the wire: the
   gate it provides to the leaves is not exported. No `OpWireService` can
   open the wire while the document is open (#22 §5). A page that needs a
   later start delays inside its own `connect`.
5. **A wire is optional.** A page hydrated with no `wire` keeps each driven
   leaf as its document drew it: a static page.
6. **The connection is the application's.** `OpWireService.connect(url)` gives a
   `Connection`: the resume payload, the patches, and `send`. A socket or a
   stream is a choice for the application (Chat, #43).
7. **Every connection adopts.** A reconnect, or a change of params that
   names a new drive, detaches the last client (its listeners leave with
   it) and adopts the container's nodes again from a new session's
   snapshot. A change of params closes the old connection first. Each
   event's send runs in its connection's scope, so a send still in flight
   ends with its connection.
8. **Reconnect is bounded.** A connection that fails before it adopts is
   retried 10 times, `reconnectAfter` apart. A connection that ends after
   it adopts starts again after `reconnectAfter`. `Diverged` stops the
   wire at once: a patch cannot repair a drawing that is not the server's.
   A stopped wire leaves the leaf as it shows.
9. **The server end reads a failure as a defect.** `Route.drivenAt` erases
   the view's failure type, so a view that fails in a session dies there.
   The leaf's own document keeps the typed failure for its `errored` view.
10. **A setup failure is drawn inside the container.** The client's view
    draws the container and cannot know that the server's view failed, so
    a driven leaf draws its `errored` view for a setup failure inside the
    container, where hydration keeps it. A wire that later resumes replaces
    it. A declaration failure is drawn as for any leaf.
11. **A leaf is found by its identity.** Sibling segments may share a name,
    so `Route.drivenAt` finds the leaf a URL ends at by its branch, never by
    its name.

## Proofs

`packages/effect-frame/tests/router/driven.test.tsx`:

- "the op wire opens only after the document closes, then adopts the drawn
  nodes": a layout query holds the document open. The page hydrates with a
  wire through `hydrate`. No connect happens while the document is open,
  not even after the layout's patch lands. After `Closed`, one connect
  happens, and the server's patches and the adopted button's handler move
  the node that the document drew.
- "a flat driven route adopts its document, and a change of params follows
  the new drive": navigation to new params connects again, and events go
  to the new session only.
- "a page with no op wire keeps each driven leaf as its document drew it".
- "a patch that moves an adopted node to the end moves it": after
  adoption, patches go through `Dom.host`.
- "a driven view's failure keeps its errored view through hydration".
- "a send still in flight when the leaf moves on is interrupted with its
  connection".
- "a driven tree whose leaf has a client view is refused when it is
  declared", "sibling leaves that share a segment name each resolve to
  their own drive", and the type fixtures at the end of the file.

## What stays open

- **The application half** (#43): a real connection over `hydrate`, and the
  Chat tests named in the acceptance matrix. The example apps still hydrate
  by hand; they have no driven leaf, and they can move to `hydrate` when
  they need one.
- **A failure over the wire.** A leaf the client enters by navigation has
  no document drawing, so a view that fails in its session shows the empty
  container.
- **A second actor or a query in a driven view** (`op-wire.md`, decision 8).
