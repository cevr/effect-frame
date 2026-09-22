# Readiness ownership boundary

`Loading` and `Errored` now retain the content producer while they present a
fallback. The immediate children Effect still runs once and provides the real
readiness service. The runtime starts the content tree in its own Solid owner
and Effect scope, including `View.list` row setup. It presents the fallback
through the existing destructive branch machinery.

The retained node uses a private host wrapper. It delegates creation,
properties, text, and listeners to the existing host. It stages inserts into
external parents while hidden. It still builds descendants under detached
host nodes. When the content becomes visible, it replays the retained direct
children, then releases queued attachments through the existing `Host.attach`
operation. `Portal` writes use the same staging path. Root or key removal
closes the existing owner and clears its staged writes. Ordinary `Show`
continues to close its branch on hide.

The boundary keeps the existing type channels. `Loading` and `Errored` still
return `Effect<Node, E, Exclude<R, LoadingScope | ErroredScope>>`. `ready`,
`orErrored`, and `View.list` keep their existing `R` and `Scope` requirements.
No public retained constructor or host capability was added.

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
| HTML                              | An already-Ready list producer starts during server mount, while its deferred registration cannot affect the first synchronous HTML frame, so the fallback is serialized. Existing direct already-Ready HTML coverage remains green. |
| OpenTUI contract                  | A compile-time test assigns the existing OpenTUI factory to `Host<TuiNode>`. The retained runtime is generic over `Host<Node>` and does not add a host method.                                                                       |
| Destructive Show                  | The existing DOM, listener, and scope tests remain green, including hidden Show subscription and finalizer checks.                                                                                                                   |

The focused file contains 7 tests and 26 assertions. The complete view suite
contains 105 tests and 485 assertions after this repair. The repository gate
is the release check; these counts describe the local run that accompanies
this note.

## Limits

The HTML host serializes the first synchronous frame. A registration created by
a deferred list row cannot change that frame after serialization closes the
scope. The proof records the truthful fallback output and the producer start.

This boundary does not change keyed-list transition ordering. `View.list` still
removes an exited key before creating a new key. Router transition overlap,
nested route data, outlet APIs, streaming, and later layout work remain
separate boundaries. No claim about those behaviors follows from these tests.

The OpenTUI check proves the existing synchronous Host contract remains
accepted by the generic retained wrapper. It does not claim a live terminal
probe of every retained Portal or attachment behavior. No Host extension was
needed by the DOM, HTML, and generic contract proofs.
