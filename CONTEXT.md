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

**Durable work record**:
Stored information from which unfinished actor work can resume after a host restart.
_Avoid_: Persisted fiber.
