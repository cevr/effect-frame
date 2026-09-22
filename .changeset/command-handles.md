---
"effect-frame": minor
---

`send` now returns a command handle for local, durable, and remote references, and never fails. A handle has a `state` source (Sent, Admitted, Applied, Rejected, or Uncertain) and a `settled` effect. Durable and remote handles also carry `commandId` and `retry`. A local handle is never Uncertain.

Durable and remote references own each command. The framework creates a fresh command ID with native secure crypto, or keeps a supplied `commandId`. A remote command runs one send and one same-ID call per pass, for up to 8 passes with a 10 second pass deadline and capped, jittered backoff. At exhaustion it stays `Uncertain{attempt: 8}` until `retry` settles it with the same ID and bytes.

Breaking: `Applied.revision` is now a `CommittedRevision` (`{_tag: "Committed", value}`), and `ProvisionalRevision` is added. Wire, store, and change stream revisions stay numeric; `resumeCodec` decodes them as committed. `Receipt`, `SendError`, and the `Admitted` export are removed. `call` options for durable and remote references take an optional `commandId`. A remote `call` no longer fails with `Unreachable`: a lost reply or an unreachable host ends the wait with `Uncertain`, because the command may still commit. `CallError["remote"]` is now the remote rejections (`ActorStopped`, `CommandConflict`, `Unauthorized`, `ContractMismatch`, `UnknownContract`) or `Uncertain`.

Remote commands claim their contract's live query entries, which stay stale until the last command settles and refresh after it applies. The claim is private to the cache that `queryCacheLayer` builds: `QueryCacheService` is unchanged, and a custom or wrapped cache keeps the public contract: the contract is invalidated when a command starts, and the reply's refreshes are applied when it settles. `Frame.inspect` now reports `commands` as `Available` with its retained records.
