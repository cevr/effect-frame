# Effect primitives for query ownership and durable work

Source review: 2026-09-22. Effect version: `4.0.0-rc.115`.
Frame baseline: `0536578efc0cc7b6b0f627e22bc175f860e8a2cc`.

## Decision

Use `RcMap` for active query ownership. Keep Frame's query state and refresh
rules above it. Evaluate `PersistedQueue` for background work in #42.
Use `EventLog` only when committed event history or replication is required.
Neither durable module alone supplies Frame's command receipt contract.

| Module                      | Native contract                                                        | Frame use                                                        |
| --------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `Cache`                     | Shared lookup results with cache retention rules                       | Reusable result caching where a TTL or capacity policy is wanted |
| `ScopedCache`               | Cached resources with scoped cleanup and cache retention               | Resources whose lifetime follows cache retention                 |
| `RcMap`                     | One resource per key, retained by caller scopes                        | Active query slots, released by the last declaration             |
| `PersistedQueue`            | Persistent work delivery with IDs, attempts, acknowledgment, and retry | First candidate for background job delivery                      |
| `EventLog` / `EventJournal` | Typed handlers, committed journal entries, and optional replication    | Domain event history when the application needs it               |

## Active queries

Frame's active query entries have no idle eviction. An entry lives while a
view or route declares it. `RcMap` represents that lifetime directly.

`RcMap.get` installs an entry before its lookup starts. Concurrent callers
share the lookup Deferred. Each caller's Scope retains the entry. The default
idle lifetime is zero. The last release removes the key and closes the entry
Scope. Closing the map also closes its entries. `getOption` retains an existing
entry without opening a new key. `keys` reports the map's keys.

Keep the query slot in the entry Scope. Capture the app's inspection registry
and Clock when the cache is built. Do not attach a shared slot to its first
view's scope. Use a canonical Equal/Hash key that also carries the first
declaration's lookup data. Do not keep a second slot registry or a manual
reference count beside `RcMap`.

The cache Layer must live as long as the app. Providing it only around a mount
operation that returns does not retain it for a separate, longer view Scope.

## Persistent delivery

`PersistedQueue` supplies schema-encoded named queues, caller IDs, processing
attempts, scoped acknowledgment, retries, and memory, Redis, and SQL stores.
Processing can occur more than once after a failure. Application handlers must
account for that delivery contract.

The memory control below found a material difference from `MailboxStore`:
offering the same ID with a different payload succeeds and keeps the first
payload. It does not return `CommandConflict` or the stored application result.
The ID still deduplicates an offer after completion. Cleanup can later remove
completed IDs; the default cleanup horizon is 30 days.

Frame requires admission order, rejection of an ID with a different payload,
an exact committed receipt, and atomic state and receipt storage. Issue #29
also requires a retained deduplication record while a retry can reuse the ID.
Queue attempt exhaustion does not mean the same thing as a client's
`Uncertain` command state.

Before using this queue for #42, prove transaction ownership, enqueue and
deduplication, actor ordering, lease recovery, and receipt retention. Two
independent writes to a mailbox and a queue do not prove atomic delivery.

## Event history

`EventLog` provides typed event groups and handlers, a journal, local identity,
reactivity invalidation, and optional remote replication. Its write path runs
the handler before it commits the journal entry. The journal mints entry IDs.
An event primary key is not a command-ID receipt lookup.

The SQL journal's lock brackets work in `SqlClient.withTransaction`.
`EventLog.write` calls the journal inside that bracket. A handler that uses the
same SQL transaction context can compose with the journal write. An external
HTTP effect does not become part of that transaction.

Use this for an explicit history or replication requirement. Keep the #29
actor change stream as latest state. It has no command attribution and can
skip intermediate revisions. Keep `Frame.inspect` as a read of current owned
memory. Reading a journal does not establish which view or query is live.

## Executed controls

These controls used the installed Effect version above.

| Control                                                                 | Observed result                                                                                                 | Limit                               |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Ten concurrent `RcMap.get` calls for one key                            | One lookup; first caller close retained the entry; last close released it once and left zero keys               | Native memory ownership control     |
| Offer one queue ID with two payloads                                    | Both offers returned the ID; take returned the first payload; a later completed-ID offer was still deduplicated | Memory store only                   |
| `EventJournal.makeMemory.write`                                         | Handler ran before write returned; the journal held one entry                                                   | No SQL, replication, or crash proof |
| Real Frame QueryTest with ten concurrent callers at candidate `55a01f9` | One handler read, one inspected query, retained after first close, removed after last close                     | Candidate ownership regression only |

The candidate's original manual slot ownership produced ten records and nine
handler reads under the same concurrent test. `RcMap` removed that race.
This does not establish that the complete inspection feature is ready.
Astra review of `55a01f9` found separate route callback, mount cleanup, failed
owner cleanup, and diagnostic key-size defects. That candidate remains under
repair. No package release is claimed here.

No SQL rollback, host restart, celld recovery, or remote replication test ran
as part of these controls. Those proofs remain required for their later map
boundaries.

## Source receipts

Installed upstream source:

- `/Users/cvr/Developer/personal/effect-frame/node_modules/effect/src/Cache.ts`
- `/Users/cvr/Developer/personal/effect-frame/node_modules/effect/src/ScopedCache.ts`
- `/Users/cvr/Developer/personal/effect-frame/node_modules/effect/src/RcMap.ts`
- `/Users/cvr/Developer/personal/effect-frame/node_modules/effect/src/unstable/persistence/PersistedQueue.ts`
- `/Users/cvr/Developer/personal/effect-frame/node_modules/effect/src/unstable/eventlog/EventLog.ts`
- `/Users/cvr/Developer/personal/effect-frame/node_modules/effect/src/unstable/eventlog/EventJournal.ts`
- `/Users/cvr/Developer/personal/effect-frame/node_modules/effect/src/unstable/eventlog/SqlEventJournal.ts`

Frame source and deciding issue:

- `/Users/cvr/Developer/personal/effect-frame/packages/effect-frame/src/actor/query-client.ts`
- `/Users/cvr/Developer/personal/effect-frame/packages/effect-frame/src/actor/mailbox-store.ts`
- `/Users/cvr/Developer/personal/effect-frame/packages/effect-frame/src/actor/durable.ts`
- [Command receipt resolution, issue 29](https://github.com/cevr/effect-frame/issues/29)

Local execution receipts:

- `/tmp/frame-effect-primitives-proof.ts`
- `/tmp/frame-effect-primitives-proof.json`
- `/tmp/frame-inspection-concurrency-proof.ts`
- `/tmp/frame-inspection-concurrency-proof.json`
- `/tmp/frame-inspection-rcmap-concurrency-proof.json`
- `/tmp/effect-frame-inspection-review-round1.md`

The recorded results above preserve the useful findings if these temporary
files are later removed. They do not replace the package regression tests.
