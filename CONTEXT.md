# Effect Frame

Effect Frame provides one actor model for full-stack declarative interfaces.

This file is the glossary, and only the glossary: each term is defined once (`bun run docs` refuses a second definition). `_Code_` names the symbols a term is written as, so one word has one meaning in prose and in code.

How an app uses these words is [the package README](packages/effect-frame/README.md); how to change the repository is [AGENTS.md](AGENTS.md).

## Language

**Actor contract**:
The public description of an actor's identity, messages, results, and visible state.
_Avoid_: Server implementation.

**Actor behavior**:
The rules that process an actor's messages and change its private state.
_Code_: `Behavior.value`, `Behavior.reducer`, `Behavior.machine`; the option `behavior` of `Route.actor` and `Actor.remote`. The word "behavior" means this and nothing else: what a navigation does to scroll and focus is its landing, and code that runs on a host node is an attachment.
_Avoid_: Actor contract.

**Actor reference**:
A client's handle for observing an actor and submitting its messages. Its placement is named where it is made, and shows in its type.
_Code_: `Actor.local` (`LocalActorRef`), `Actor.remote` (`RemoteActorRef`), `Actor.remoteCommands` (`RemoteCommandRef`), `Actor.durable` (server only).
_Avoid_: Actor instance.

**Public snapshot**:
The state that an actor permits a client to observe.
_Avoid_: Internal state.

**Query**:
A named server read that returns data for given arguments, may be cached by those arguments, and can be refreshed. A query has no identity, no mailbox, and cannot change state.
_Code_: `query(name, { version, args, result, policy, depends })`, served by `implementQuery`. A view reads one through its route (`Route.query`); other code follows one with `followQuery`. The `<Await>` tag draws a query state; no tag is named `Query`.
_Avoid_: Loader, read model, actor snapshot.

**Command**:
A message a client submits to an actor to change its state. Every state change in Effect Frame is a command; there is no second mutation path.
_Avoid_: Mutation, action, server function.

**View**:
A function from props to an Effect that produces a node tree once, in a scope that owns everything the setup opened. A view is composed by yielding it inside another view's setup, never by placing it as a JSX tag; a JSX tag is a synchronous function or an intrinsic name. A view names the props it is given, even when it reads none: a leaf types them `Route.PropsOf<typeof segment>`. An exported view with no parameter is refused by the Effect language service's `lazyEffect` rule.
_Code_: `(props) => Effect.gen(function* () { ... })`, typed `View.View<Props, E, R>`. `View.mount` puts a view on a host; the router's `mount` puts a route tree on one.
_Avoid_: Component, widget, render function.

**Attachment**:
An Effect given a host node, run once the node is in the document, in the scope of the shown branch or row that owns the element; the scope closing ends it. It is the only way a view reaches its own host node: nothing outside the attachment holds the node, so there is no node reference to keep in step with the tree. Several compose on one element in order.
_Code_: `View.attach`, the type `Attached`.
_Avoid_: Ref, node reference, mixin, directive, attached behavior.

**Portal**:
A region of a view drawn under a host node outside the view's own subtree. The view still owns it: it reads the view's sources, runs in its scope, and leaves with its shown branch or row.
_Code_: `<Portal into>`, whose `PortalTarget` only a host module makes (`Dom.target(element)`). A host draws only into a target it made; the HTML and Remote hosts make none and refuse a Portal with `View.PortalTargetRefused`.
_Avoid_: Teleport, overlay root.

**Source**:
A value that changes: its current value and a stream of its changes. A view reads state through sources and binds them into nodes, so a change moves only what reads it.
_Code_: `Source<A>` and the `Source` namespace (`Source.select`, `Source.zip`, `Source.switchMap`, ...).
_Avoid_: Signal, observable, atom, store.

**Bound value**:
A source placed where a node takes a value, a child or a prop, so the node follows it.
_Code_: `View.bind(source)` or `View.bind(source, project)`, the type `Bound`. A raw `Source` in that place does not compile.
_Avoid_: Binding (that word is a route's data), reactive prop.

**Prepared handler**:
An event handler made ready for a host: an Effect to run on the event, and whether the host suppresses the default action.
_Code_: `View.event(handler)` or `View.event(effect)` for a handler that reads no event (kind `"event"`), `View.submit(handler)` and a `View.form` binding's `submit` (kind `"submit"`), the type `Prepared`.
_Avoid_: Callback, listener, event prop.

**Rendering mode**:
Where and when a route's view is turned into markup. The mount of a route tree names it by its constructor, never by a field: on the client only (`Route.client`), on the server before hydration (`Route.ssr`), streamed from the server as its data settles (`Route.streamed`), on the server once every read settled (`Route.awaitAll`), at build time (`Route.prerender`, which renders as `awaitAll`), or on the server for every change (`Route.driven`, whose documents are streamed). A plain form post is not a mode: it is a command path that works under every mode that renders on a server.
_Code_: the constructors above; the type `Route.RenderingMode` has the four document modes `"ClientOnly"`, `"SSR"`, `"Streamed"`, `"AwaitAll"`.
_Avoid_: Strategy, target.

**Query state**:
What a client can observe about a query at one moment: loading, ready with a value that may be stale, or failed with an error. Never two of these at once.
_Code_: `QueryState.Loading()`, `QueryState.Ready(value, stale)`, `QueryState.Failed(error)`, `QueryState.match`. `QueryState.Loading` is a state; `View.loading` is a readiness scope.
_Avoid_: isLoading, resource.

**Server module**:
A file that may run only on a server, named by a `.server` suffix before its extension. Server views, query implementations, actor implementations, and hosts are server modules.
_Avoid_: Server file, backend module, `"use server"`.

**Browser entry**:
A file a bundler compiles for a page. It is the root of the graph a browser downloads, and it is the only place the server/client boundary is measured. It imports `effect-frame/actor/client`, never `effect-frame/actor`.
_Avoid_: Client file, frontend entry.

**Server/client boundary**:
The line between what may run only on a server and what a browser downloads. `bun run boundary` measures it from every browser entry. "Boundary" alone means this; a region that waits for queries is a readiness scope.
_Avoid_: Split point, bundle boundary.

**Readiness scope**:
A region of a view that shows a fallback until every query it was given has a first value, and afterwards keeps showing content while values refresh. A view declares the scope; reads inside it register with it. A scope nothing registers with shows its content.
_Code_: `View.loading` with `View.ready` (the service `View.LoadingScope`), and `View.errored` with `View.orErrored` (`View.ErroredScope`). These are services in the view's Effect context, not `Scope`s; an Effect `Scope` owns resources. `ScopesClosed` refuses a view whose readiness scope is still open where its services are final.
_Avoid_: Suspense boundary, boundary.

**Segment**:
A named, typed page address that both parses and prints, and that declares the data its page needs and the check that runs before it commits. Its template uses the URLPattern grammar; its params and search params carry Schemas. A child segment continues its parent's address and inherits its params.
_Code_: `Route.segment(name, { path, params, search, data, before })`, `Route.child(parent, name, { ... })`.
_Avoid_: Path string, loader, route (a route is the mounted tree).

**Declaration**:
One item of a segment's `data`: a query with its arguments, an actor with its key, or a command-only actor. The route derives it from the params and search, opens it when the segment enters, and moves or releases it as they change.
_Code_: `Route.query(contract, args)`, `Route.actor(contract, key, { behavior })`, `Route.commandRef(contract, key)`.
_Avoid_: Loader, fetcher, resource.

**Binding**:
What a declaration gives the segment's view, under the same name in `props.data`: a query's state and its refresh, or an actor's reference and its state, each as a source.
_Code_: `FollowedQuery` from `effect-frame/actor/client` (`{ state, refresh, override }`), `Route.FollowedActor` (`{ ref, state }`), `Route.FollowedCommands` (`{ ref }`); the view types its props with `Route.PropsOf<typeof segment>`.
_Avoid_: Loader data, route props.

**Branch**:
A segment with the view that draws it: a leaf, or a layout with its child branches.
_Code_: `Route.leaf(segment, view, options)`, `Route.layout(segment, children, view)`.
_Avoid_: Route config, route entry.

**Leaf**:
A branch with no children. Its view is the page itself.
_Avoid_: Page component, route view.

**Layout**:
A branch whose segment has children: its view wraps the matched child's view, which it receives as the outlet. Its segment's data is its own, and every segment beneath it inherits its params.
_Code_: `Route.layout`, and `Route.LayoutPropsOf<typeof segment, ChildR>` for its props.
_Avoid_: Wrapper route, shell.

**Route**:
One branch of root segments mounted by a rendering-mode constructor, under a name. The router serves a list of routes and matches a URL against them in order.
_Code_: `Route.client(name, branch)` and the other constructors; `Route.redirecting(name, segment, to)` is a route that only redirects. The type `Route.AnyRoute`. The router's `RouteMatch` is which route a URL matched; the `<Match>` tag branches a view on a tagged value.
_Avoid_: Route definition, page, match.

**Outlet**:
The place in a layout's view where the matched child's view is put. A layout receives it as a value and places it; it is not discovered.
_Code_: `props.outlet`, an Effect the layout yields or wraps in `View.loading`.
_Avoid_: Slot, children.

**Transition**:
The comparison of the matched route branch before a navigation with the one after it. Each segment is entering, stayed, or exited; a stayed segment keeps its view and re-derives its declarations.
_Avoid_: Route change, navigation event.

**Landing**:
What a navigation does to the viewport and to keyboard focus once the destination's shell is in the document. The router names one for every navigation, and a leaf may name its own.
_Code_: the option `landing` of the router's `mount` and `hydrate` and of `Route.leaf`, valued `NavigationBehavior.Restore` or `NavigationBehavior.Preserve`.
_Avoid_: Scroll restoration, scroll behavior, navigation behavior.

**Shell commit**:
The moment a navigation's new route branch is in the document, with every readiness scope showing a fallback or content. It is when scroll and focus move, and it is before any pending query has settled.
_Avoid_: First paint, transition end, ready.

**Leaf root**:
The element a leaf's view returns at its top. The router marks it `tabindex="-1"` and moves focus to it, or to the first `autofocus` element inside it, when the leaf enters.
_Avoid_: Route root, page root.

**Active query**:
A query entry some mounted route segment or view scope currently declares. Only active entries are named in a command and refreshed in its reply.
_Avoid_: Cached query, subscribed query.

**Command state**:
What a client can observe about one submitted command at one moment: sent, admitted, applied at a revision, rejected with a reason, or uncertain. Never two of these at once. A command is admitted before it is applied, and a client sees those separately.
_Avoid_: Pending (a route's `pending` is what a leaf shows while its view prepares), isSubmitting, mutation status.

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
A named rule that decides whether a principal may read or command one subject. Every contract and every query names one; the host holds the rules and refuses a name it does not know. A route names no policy: its segment's `before` check decides whether the page continues or redirects, and every read the page makes is still judged by the read's own policy.
_Code_: the field `policy` of `contract` and `query`; `Policy.of`, `Policy.allowAll`, `Policy.byAction`.
_Avoid_: Authorizer, guard, permission check, ACL.

**Policy table**:
The host's map from policy name to rule. It has no default: a host that is given no table does not build, and a host whose table lacks a name that a contract or query declares fails before it serves anything. Allow-all is one entry in it, written by name.
_Avoid_: Authorizer, permission registry, default policy.

**Principal source**:
Who is asking, over time. A request reads it once. A live connection follows it and ends on the first value that differs from the one the connection was authorized under, so a sign-out, an expiry, and a change of subject all end the connection the same way.
_Avoid_: Session listener, revocation hook, token refresh.

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
_Code_: `<Show>` and `<Match>`; `View.show` and `View.match` when the branch runs a setup, which runs each time the branch is shown and whose scope closes when it hides.
_Avoid_: Hidden branch, cached branch.

**Proving example**:
An application in this repository that exists to make one decision fail loudly when it stops being true. It holds the smallest set of features its own claims need, and it names what it deliberately does not hold.
_Avoid_: Demo, sample app, playground.

**Acceptance row**:
One claim this system makes, the test that fails when the claim stops being true, and the decision that made the claim. A claim no decision made is not a row.
_Avoid_: Requirement, test case, checklist item.

**Durable work record**:
Stored information from which unfinished actor work can resume after a host restart.
_Avoid_: Persisted fiber.
