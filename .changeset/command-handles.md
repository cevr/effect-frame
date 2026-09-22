---
"effect-frame": minor
---

`send` now returns a command handle for local, durable, and remote references, and never fails. A handle has a `state` source (Sent, Admitted, Applied, Rejected, or Uncertain) and a `settled` effect. Durable and remote handles also carry `commandId` and `retry`. A local handle is never Uncertain.

Durable and remote references own each command. The framework creates a fresh command ID with native secure crypto, or keeps a supplied `commandId`. A remote command runs one send and one same-ID call per pass, for up to 8 passes with a 10 second pass deadline and capped, jittered backoff. At exhaustion it stays `Uncertain{attempt: 8}` until `retry` settles it with the same ID and bytes.

Breaking: `Applied.revision` is now a `CommittedRevision` (`{_tag: "Committed", value}`), and `ProvisionalRevision` is added. Wire, store, and change stream revisions stay numeric; `resumeCodec` decodes them as committed. `Receipt`, `SendError`, and the `Admitted` export are removed. `call` options for durable and remote references take an optional `commandId`.

Remote commands claim their contract's live query entries, which stay stale until the last command settles and refresh after it applies. `Frame.inspect` now reports `commands` as `Available` with its retained records.
