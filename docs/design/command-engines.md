# Private command engines

Unit 1 keeps the public actor contract unchanged while separating execution
from its adapters.

`Actor.spawn` opens the private local engine. It owns one behavior turn, one
mailbox, one committed source, and two scope-owned workers. The local module
does not import a mailbox store or a host, so the browser boundary stays
unchanged. `derive` remains inside the serial turn.

The public `durable` adapter and `implement.open` open the same private durable
engine. A hosted implementation therefore has one behavior turn, one mailbox
worker, one state source, one store, and one inspection registration for its
physical actor. `implement.open` passes the host construction context and scope
to that engine. A request caller cannot replace those services.

Durable admission encodes a message once before appending its payload and hash.
The stored payload is the retry and recovery boundary. A receipt stores the
encoded state produced by that command, so a later retry returns that exact
revision and state even when the actor has since advanced.

The celld counter fixture now uses `HostedInstance`. It encodes messages at the
fixture boundary and decodes hosted projections at the response boundary. Its
SQL store and recovery paths remain the existing adapter proof.

This slice does not add public command handles, prediction, command ID
generation, retries, cache ownership, command inspection, or runtime changes.
