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

**Rendering mode**:
The place and time a view is turned into markup: on the client, on the server before hydration, on the server for every change, at build time, or on the server in reply to a plain form post.
_Avoid_: Strategy, target.

**Query state**:
What a client can observe about a query at one moment: loading, ready with a value that may be stale, or failed with an error. Never two of these at once.
_Avoid_: isLoading, resource.

**Readiness scope**:
A region of a view that shows a fallback until every query it was given has a first value, and afterwards keeps showing content while values refresh. A view declares the scope; reads inside it register with it.
_Avoid_: Suspense boundary.

**Route**:
A named, typed description of a page address that both parses and prints, and that declares the queries and actor references the page needs.
_Avoid_: Path string, loader.

**Durable work record**:
Stored information from which unfinished actor work can resume after a host restart.
_Avoid_: Persisted fiber.
