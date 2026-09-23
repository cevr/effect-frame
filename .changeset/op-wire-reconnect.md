---
"effect-frame": minor
---

Stream host operations to a server-driven client, and reconnect from the actor's snapshot (#15, #27, #87).

New exports on `effect-frame/view`: `Remote`, the client half of the op wire. `Remote.recorder` (a `Host` that records each operation, with a shadow that drops writes that would not change the client's tree, and an optional `limit` on undrained operations), `Remote.client` (`resume`, `apply`, `position`, `retained`), `Remote.draw`, `Remote.payloadOf`, `Remote.digestOf`, `Remote.addressOf`, `Remote.sameAddress`, `Remote.root`, the wire schemas `Remote.Op`, `Remote.Patch`, `Remote.RemoteEvent`, `Remote.PatchJson`, `Remote.RemoteEventJson` and one schema per operation (with `Remote.Forget`), the errors `Remote.ForeignSession`, `Remote.StaleClient`, `Remote.UnknownNode`, and `Remote.Diverged`, and the types `Remote.Recorder`, `Remote.RecorderOptions`, `Remote.Retained`, `Remote.ClientRetained`, `Remote.RemoteNode`, `Remote.Drive`, `Remote.Target`, `Remote.Client`, `Remote.Drawn`.

New subpath `effect-frame/view/driven` (server only): `session(view, props, drive, { limit })` returns a `Session` with `resume`, `patches`, `fire`, and `retained`; `Backlogged` ends `patches` when a client falls more than `limit` operations behind (`defaultLimit`, 10 000).

New optional `Host.forget(node)`: the runtime calls it when the owner that drew a node ends. A host that keeps state for each node uses it to forget the node; the recorder sends a `Forget` operation.

A connection starts with the session id, the drive's snapshot, and a digest of the drawing, never with an operation log. A reconnect costs the snapshot at any age. Every patch names its session, and a client refuses a patch from another session. The server's mount holds back the drive's changes until its first drawing is drained, and reads only its drive, as the client does. A client whose drawing from the snapshot differs from the server's fails `Diverged` and applies nothing. An event reaches only a listener a patch has delivered. The wire carries every property value a host can receive, including `NaN`, the infinities, and `-0`. Patches are trusted server output.

No breaking changes: `Host.forget` is optional.
