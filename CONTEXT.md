# Effect Frame

Effect Frame provides one actor model for full-stack declarative interfaces.

## Language

**Actor contract**:
The public description of an actor's identity, messages, results, and visible state.
_Avoid_: Server implementation.

**Actor behavior**:
The rules that process an actor's messages and change its private state.
_Avoid_: Actor contract.

**Actor reference**:
A client's handle for observing an actor and submitting its messages.
_Avoid_: Actor instance.

**Public snapshot**:
The state that an actor permits a client to observe.
_Avoid_: Internal state.

**Query**:
A named server read that returns data for given arguments, may be cached by those arguments, and can be refreshed. A query has no identity, no mailbox, and cannot change state.
_Avoid_: Loader, read model, actor snapshot.

**Command**:
A message a client submits to an actor to change its state. Every state change in Effect Frame is a command; there is no second mutation path.
_Avoid_: Mutation, action, server function.

**View**:
A function from props to an Effect that produces a node tree once, in a scope that owns everything the setup opened. A view is composed by yielding it inside another view's setup, never by placing it as a JSX tag; a JSX tag is a synchronous function or an intrinsic name.
_Avoid_: Component, widget, render function.

**Attached behaviour**:
An Effect given a host node, run once the node is in the document, in the scope of the shown branch or row that owns the element; the scope closing ends it. It is the only way a view reaches its own host node: nothing outside the behaviour holds the node, so there is no node reference to keep in step with the tree. Several compose on one element in order.
_Avoid_: Ref, node reference, mixin, directive.

**Portal**:
A region of a view drawn under a host node outside the view's own subtree. The view still owns it: it reads the view's sources, runs in its scope, and leaves with its shown branch or row.
_Avoid_: Teleport, overlay root.

**Rendering mode**:
Where and when a route's view is turned into markup: on the client only (`Route.client`), on the server before hydration, streamed from the server as its data settles, on the server for every change, or at build time. The mount of a route tree names it (`Route.client(name, root)`), and naming it is choosing a constructor rather than setting a field. A plain form post is not a mode: it is a command path that works under every mode that renders on a server.
_Avoid_: Strategy, target.

**Query state**:
What a client can observe about a query at one moment: loading, ready with a value that may be stale, or failed with an error. Never two of these at once.
_Avoid_: isLoading, resource.

**Server module**:
A file that may run only on a server, named by a `.server` suffix before its extension. Server views, query implementations, actor implementations, and hosts are server modules.
_Avoid_: Server file, backend module, `"use server"`.

**Browser entry**:
A file a bundler compiles for a page. It is the root of the graph a browser downloads, and it is the only place the server/client boundary is measured.
_Avoid_: Client file, frontend entry.

**Readiness scope**:
A region of a view that shows a fallback until every query it was given has a first value, and afterwards keeps showing content while values refresh. A view declares the scope; reads inside it register with it.
_Avoid_: Suspense boundary.

**Route**:
A named, typed description of a page address that both parses and prints, and that declares the queries and actor references the page needs. Its template uses the URLPattern grammar; its params and search params carry Schemas.
_Avoid_: Path string, loader.

**Layout**:
A route that has children and wraps their view in its own. It declares its own data, which every route beneath it inherits.
_Avoid_: Wrapper route, shell.

**Outlet**:
The place in a layout's view where the matched child's view is put. A layout receives it as a value and places it; it is not discovered.
_Avoid_: Slot, children.

**Transition**:
The comparison of the matched route branch before a navigation with the one after it. Each segment is entering, stayed, or exited; a stayed segment keeps its view and re-derives its declarations.
_Avoid_: Route change, navigation event.

**Navigation behavior**:
What a navigation does to the viewport and to keyboard focus once the destination's shell is in the document. A default for the whole router, overridable by the destination route.
_Avoid_: Scroll restoration, scroll behavior.

**Shell commit**:
The moment a navigation's new route branch is in the document, with every readiness scope showing a fallback or content. It is when scroll and focus move, and it is before any pending query has settled.
_Avoid_: First paint, transition end, ready.

**Active query**:
A query entry some mounted route segment or view scope currently declares. Only active entries are named in a command and refreshed in its reply.
_Avoid_: Cached query, subscribed query.

**Command state**:
What a client can observe about one submitted command at one moment: sent, admitted, applied at a revision, rejected with a reason, or uncertain. Never two of these at once. A command is admitted before it is applied, and a client sees those separately.
_Avoid_: Pending, isSubmitting, mutation status.

**Command handle**:
What `send` returns at once: the command's state as a source, and an effect that waits until it settles. A durable or remote handle also carries the command's identity and a retry. The handle does not own the work; the actor reference does, so the handle can be dropped and an event can return before the command settles.
_Avoid_: Promise, future, mutation result.

**Uncertain**:
The command state a client holds when it cannot know whether a command committed: a reply was lost, a pass ran out of time, or the host stopped after it may have admitted the command. It carries the pass count and the admission sequence, if one was seen. It never becomes a refusal by running out of passes; only the same command identity sent again can settle it.
_Avoid_: Failed, timed out, unknown error.

**Committed revision**:
A revision a server has committed, as a client sees it: a tagged value, never a bare number, so it cannot be confused with a provisional revision. Wire, store, and change stream revisions stay plain numbers.
_Avoid_: Version, revision number.

**Command claim**:
A client cache's record that one unsettled command may change a contract's queries. While any claim is open, every active query that depends on that contract shows its value as stale. The claim closes with the command's record.
_Avoid_: Pending mutation, invalidation.

**Provisional revision**:
A state a client computed itself by applying a command it has sent but that no server has committed. It carries the committed revision it was computed from rather than a revision number of its own, so it can never be mistaken for, ordered against, or resumed from a committed revision. A committed revision replaces it; it is never merged with one.
_Avoid_: Optimistic update, local revision, pending state.

**Pending log**:
The commands a client predicted and the committed base does not hold yet, in the order this client sent them. The displayed state is the base with the log applied over it. A command leaves the log when a committed base holds it or when it is rejected; that is the whole of a rollback.
_Avoid_: Optimistic queue, undo stack, mutation cache.

**Change stream**:
Every committed revision an actor reaches, delivered to a client as the latest state rather than as a log. A client that was absent or slow observes the newest revision and not the ones it missed, which loses nothing because a later revision's state subsumes an earlier one's. It carries state, never command identity: a client learns the fate of its own command from the command's receipt, not from the stream.
_Avoid_: Event log, event stream, revision history.

**Principal**:
Who is making a request: nobody in particular, or a named subject with the claims a session published about them. Derived once where the request enters and unchanged for the rest of that request; a connection that outlives a request follows the session instead, and ends when the answer changes.
_Avoid_: User, session, current user, auth context.

**Policy**:
A named rule that decides whether a principal may read or command one subject. Every contract, query, and protected route names one; the host holds the rules and refuses a name it does not know.
_Avoid_: Authorizer, guard, permission check, ACL.

**Session**:
An actor whose state is what one sign-in established about a caller, and whose revisions are the authority on whether that caller is still who they were. Signing out and expiring are both revisions of it, not events beside it.
_Avoid_: Token, login, auth state, session store.

**Plain post**:
A command a browser submits by its own form machinery, with no client code involved. The page that rendered the form chose the command's identity, so a resubmission of that same rendered form is the same command and applies once.
_Avoid_: Form action, no-JS fallback, progressive enhancement.

**Form issue**:
One field's reason for refusing a posted value, named by the path the field carries. A refused post returns the page the user asked for, carrying its issues and the values they typed, and a fresh command identity.
_Avoid_: Validation error, form state, field error.

**Generated field**:
A value a message needs that no one types: an identity for the thing a command creates. The render that offers the command chooses it, from the command's own identity or beside it, so every submission of one rendered form carries the same value and the command applies once. Nothing generates it when a submission arrives.
_Avoid_: Default value, server-side default, auto id.

**Placeholder record**:
A note in a streamed document that a query's value is still coming, carrying the identifier the later value will use. It holds no value and never changes.
_Avoid_: Pending promise, suspense marker.

**Patch record**:
A note appended to a streamed document after its placeholder, carrying the value or the error that settles it. One per placeholder, at most once.
_Avoid_: Chunk, flush, resolver call.

**Prerender input**:
One page's worth of route parameters, produced at build time by a route's finite input list. A nested route's inputs are produced once per ancestor input, so a branch contributes one page per combination. Search parameters are never inputs.
_Avoid_: Path list, static path, `getStaticPaths`.

**Build-time snapshot**:
The actor revision and query values a prerendered page was rendered from, written into the page and marked with the moment they were read. A loaded page resumes its actors after that revision and revalidates those query values, so the mark is what tells the client the values are unconfirmed.
_Avoid_: Cached data, frozen state, baked payload.

**Shown branch**:
A conditional region of a view while its condition holds. A shown branch owns every node it and its descendants created, and owns its own subscriptions; hiding it ends both. A hidden branch does not exist: it holds no node and observes no source.
_Avoid_: Hidden branch, cached branch.

**Server module**:
A file that may run only on a server, named by a `.server` suffix before its extension. Server views, query implementations, actor implementations, and hosts are server modules.
_Avoid_: Server file, backend module, `"use server"`.

**Browser entry**:
A file a bundler compiles for a page. It is the root of the graph a browser downloads, and it is the only place the server/client boundary is measured.
_Avoid_: Client file, frontend entry.

**Proving example**:
An application in this repository that exists to make one decision fail loudly when it stops being true. It holds the smallest set of features its own claims need, and it names what it deliberately does not hold.
_Avoid_: Demo, sample app, playground.

**Acceptance row**:
One claim this system makes, the test that fails when the claim stops being true, and the decision that made the claim. A claim no decision made is not a row.
_Avoid_: Requirement, test case, checklist item.

**Durable work record**:
Stored information from which unfinished actor work can resume after a host restart.
_Avoid_: Persisted fiber.

**Shown branch**:
A conditional region of a view while its condition holds. A shown branch owns every node it and its descendants created, and owns its own subscriptions; hiding it ends both. A hidden branch does not exist: it holds no node and observes no source.
_Avoid_: Hidden branch, cached branch.
