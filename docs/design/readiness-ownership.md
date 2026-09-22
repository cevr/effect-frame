# Readiness ownership boundary

`Loading` and `Errored` now retain the content producer while they present a
fallback. The immediate children Effect still runs once and provides the real
readiness service. The runtime starts the content tree in its own Solid owner
and Effect scope, including `View.list` row setup. It presents the fallback
through the existing destructive branch machinery.

The retained node uses a private host wrapper. It delegates creation,
properties, text, and listeners to the existing host. It stages inserts into
external parents while hidden. `Host` has optional detached constructors for
hosts whose normal constructors acquire connected nodes; `Dom.hydrate` uses
them for hidden content, while visible content uses its normal claiming
constructors. The fallback is built before hidden content, and reveal inserts
content before the fallback anchor so hydration cursors and following
siblings keep their identity. The wrapper releases created-node and
descendant bookkeeping on real removal, while hide still keeps the owner and
logical graph for reveal. When the content becomes visible, it replays the
retained direct children, then releases queued attachments through the
existing `Host.attach` operation. `Portal` writes use the same staging path.
Root or key removal closes the existing owner and clears its staged writes.
Ordinary `Show` continues to close its branch on hide.

The boundary keeps the existing type channels. `Loading` and `Errored` still
return `Effect<Node, E, Exclude<R, LoadingScope | ErroredScope>>`. `ready`,
`orErrored`, and `View.list` keep their existing `R` and `Scope` requirements.
No public retained constructor was added. The optional detached host
capability is part of the generic `Host` contract and is preserved by the
runtime and `ViewTest` wrappers. A custom host that acquires connected nodes
must provide both detached constructors.

## Evidence

The focused ownership file uses the production DOM host, `ViewTest`, actual
`QueryTest`, `Deferred`, and real query receipts.

| Proof                             | Observable receipt                                                                                                                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unseeded list producer            | A `View.list` row setup and its real QueryTest handler start while `Loading` still presents `#fallback`; the row appears after the gate settles.                                                                                     |
| Sibling and repeated pending keys | Ready row `a` keeps one setup and one DOM identity while pending keys `b` and `c` each return the boundary to the fallback.                                                                                                          |
| Key ownership                     | Removing `b` and then `c` closes only those row scopes. Row `a` remains open.                                                                                                                                                        |
| Blocked setup and root close      | A row blocked on a `Deferred` starts under the fallback and its finalizer runs when the owning root closes.                                                                                                                          |
| Error parity                      | A failed QueryTest row starts once, remains owned while `Errored` presents its fallback, and recovers after the same entry refreshes.                                                                                                |
| Portal and attachment timing      | A pending Portal target has no content and no attachment receipt. After settlement, the target receives the node and the attachment observes `isConnected === true`; root close removes the Portal.                                  |
| Hidden hydration                  | The exact section and matching paragraph probes report no mismatch or unclaimed node; fallback and following-sibling identities remain stable. Visible retained content adopts its server node and sibling.                          |
| Removed-node ownership            | The exact WeakRef/Bun GC probe releases a removed retained row before boundary close. The ordinary and retained cases both report `retainedAfterRemoval: false`.                                                                     |
| HTML                              | An already-Ready list producer starts during server mount, while its deferred registration cannot affect the first synchronous HTML frame, so the fallback is serialized. Existing direct already-Ready HTML coverage remains green. |
| OpenTUI                           | A headless `createTestRenderer` mounts the retained boundary, draws pending and ready frames, then closes it. The compile-time `Host<TuiNode>` assignment remains green.                                                             |
| Destructive Show                  | The existing DOM, listener, and scope tests remain green, including hidden Show subscription and finalizer checks.                                                                                                                   |

The focused file contains 10 tests and 50 assertions after this repair. The
complete view suite count is recorded after the final gate. The repository
gate is the release check; these counts describe the local run that accompanies
this note.

## Limits

The HTML host serializes the first synchronous frame. A registration created by
a deferred list row cannot change that frame after serialization closes the
scope. The proof records the truthful fallback output and the producer start.

This boundary does not change keyed-list transition ordering. `View.list` still
removes an exited key before creating a new key. Router transition overlap,
nested route data, outlet APIs, streaming, and later layout work remain
separate boundaries. No claim about those behaviors follows from these tests.

The headless OpenTUI proof covers pending-to-ready drawing and close. It does
not claim a live terminal probe of every retained Portal or attachment
behavior. The generic host proof does not claim hydration behavior for a
custom host that omits the detached constructors.
