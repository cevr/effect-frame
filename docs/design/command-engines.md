# Command engines and handles

## Engines (unit 1)

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

The celld counter fixture uses `HostedInstance`. It encodes messages at the
fixture boundary and decodes hosted projections at the response boundary. Its
SQL store and recovery paths remain the existing adapter proof.

## Handles (unit 2)

`send` returns a command handle and never fails. The handle has a `state`
source and a `settled` effect. A durable or remote handle also has its
`commandId` and a `retry` effect.

| Kind    | States                                       | `call` error                                                             |
| ------- | -------------------------------------------- | ------------------------------------------------------------------------ |
| local   | Admitted, Applied, Rejected                  | ActorStopped, the behavior's refusal                                     |
| durable | Sent, Admitted, Applied, Rejected, Uncertain | ActorStopped, CommandConflict, the behavior's refusal, Uncertain         |
| remote  | Sent, Admitted, Applied, Rejected, Uncertain | durable errors, Refused, Unauthorized, ContractMismatch, UnknownContract |

A local handle cannot be Uncertain. The type says so.

### Application refusal (#37)

A behavior can refuse a message: `Behavior.reducer({initial, reduce, refuse})`
and `Behavior.value(initial, {refuse})` take an optional pure rule
`refuse: (message) => Option<Refused>`. `reduce` stays total. A refused
message is never applied and commits no revision; its handle is
`Rejected(Refused {reason})`.

| Where            | When the rule runs                                 | Answer                                                       |
| ---------------- | -------------------------------------------------- | ------------------------------------------------------------ |
| local            | at the message's turn, before `apply`              | Rejected(Refused); `call` fails Refused                      |
| durable / hosted | at admission, before the append, for a new ID only | Rejected(Refused); nothing appended, no receipt              |
| HTTP wire        | the host's admission answer                        | 422 with the `Refused` body; the client decodes it           |
| plain form post  | the host's admission answer                        | 422 page, the reason as the form's issue, a fresh `$command` |
| predicting ref   | before `predict`, with the same behavior           | not predicted: no provisional row to take back               |

- The rule reads the message alone, never the state. The same bytes are
  therefore refused every time, so a refusal is conclusive in the owner (like
  CommandConflict) and is never retried, and admission can answer it without
  a turn, a pending row, or a store change.
- A command the store already holds (pending or with a receipt) is answered
  from its record, never refused: a same-ID retry cannot turn an admitted
  command into a refused one, even if the rule changed between releases.
- The type carries the refusal only where it can happen: a behavior without
  `refuse` is `Behavior<S, M, R, never>`, so its local and durable references
  keep `ActorStopped` (and `CommandConflict`) as their only rejections. A
  remote reference cannot see the host's behavior, so `Refused` is always a
  remote rejection.
- A refusal that depends on state is not this rule: it is an ordinary message
  the reducer answers with unchanged state (or a machine's guarded
  transition), because only a turn sees the state.

Public revisions are typed. `Applied.revision` is a `CommittedRevision`
(`{_tag: "Committed", value}`). `ProvisionalRevision` carries its committed base
and a depth, and has no number of its own. Protocol projections, the wire, and
the stores keep numeric revisions. `resumeCodec` decodes the numeric wire
revision into a `CommittedRevision`.

### The private owner

One private owner per durable or remote reference holds every command record.
Adapters give it `identify`, `submit`, one healthy `pass`, and `own`.

- Identity. The framework creates a fresh ID with native `crypto.randomUUID`. A
  supplied ID (`{commandId}`) is always treated as possibly admitted. A string
  that looks like a framework ID does not become fresh.
- Bytes. The message is encoded once. Retries resend those exact bytes. A second
  send with the same ID and the same bytes joins the live record. A second send
  with other bytes is Rejected(CommandConflict) and does not replace the record.
- A healthy remote pass is one `send` plus one same-ID `call`. The changes
  stream never settles a command.
- A sequence has 8 passes, and the first pass counts. Each pass has one 10 s
  deadline. The delay between passes is `Schedule.exponential("200 millis")`
  with jitter, capped at 10 s after jitter.
- At exhaustion the record stays `Uncertain{attempt: 8}`. It never becomes
  Rejected by exhaustion. `retry` starts one new sequence with the same ID and
  bytes. Concurrent retries join it. `retry` on a terminal record or a closed
  owner does nothing.
- One sequence at a time. Only the step that publishes the exhausted or held
  `Uncertain` clears `running`, and it does both in one serialized state
  update. A retry that sees `Uncertain` can start the next sequence, and no
  finished sequence can clear the flag of a later one. Terminal settlement and
  owner closure end the record, so they never clear it.
- Refusal. CommandConflict and Refused are always Rejected. Another refusal is Rejected only
  when no admission was possible. After a possible admission, ActorStopped is a
  lost pass, and Unauthorized, ContractMismatch, and UnknownContract hold the
  record Uncertain.
- Defects. A pass that dies (for example a reply that does not decode) ends
  the sequence with the record `Uncertain` and idle, and marks a possible
  admission, so `retry` can resume it and a later refusal is not conclusive.
  Uncertain is the honest state: the send may have reached admission. The
  owner logs `command.pass.defect kind=… commandId=… attempt=… defect=<class>`.
  A settlement hook that dies is logged as `command.settle.defect`, and the
  command still settles Applied, because it is applied. Log lines name the
  defect class only: its message can carry decoded state.
- Owner closure. A fresh send after closure is Rejected(ActorStopped). A
  supplied send after closure is `Uncertain{attempt: 0}`. Open handles keep
  their last nonterminal state, and their `settled` can stay pending.

Workers run with `forkIn` in a child scope of the reference, with the
reference's construction context and Scheduler. An event handler or a short
`call` waiter never owns a worker. Each worker scope closes on every exit. An
Uncertain record can outlive its worker. A record's own scope closes before its
state becomes terminal, and then the owner drops the record.

`submit` runs on the caller's fiber, which a timeout or an event can interrupt.
Insertion, adoption (`own`), and the first start run as one uninterruptible
step. A retained record therefore always has a worker, or is idle and
Uncertain so `retry` can start one. `own` must finish on its own. If adoption
dies, the owner removes the new record and closes its scope, so the same ID
starts fresh on its next submission.

### Cache ownership

A remote reference in a Frame with a `QueryCache` takes one cache claim per
command, in the record scope. While any claim for a contract is open, every
live query entry that depends on that contract shows Ready as stale. When a
command is Applied, the cache applies the refreshed values in the reply. Then it
refreshes every live dependent entry that the reply did not cover and that has
not read since the command settled. Each such entry is marked stale before the
settlement returns, and the record scope closes only after that. A read that
started before the settlement still lands, marked stale, and a later read
follows. The value from before the command never shows as fresh. Closing the
record scope releases the claim.

The claim is not on the public `QueryCacheService`. `QueryCache.layer`
provides a second, source-private service beside the cache,
`QueryCacheInternals` (the claim, the stamped read and the streamed document),
which names the cache it belongs to. A reference reads it from Context and uses
it only when it belongs to the `QueryCache` in the same context, so a claim
always lands in the cache the reference reads. A custom or wrapped cache has no
internals and owns nothing, as a Frame with no cache owns nothing.

### Inspection

`Frame.inspect` returns `commands: {_tag: "Available", records}`. Each record
comes from the owner's live registration: kind, command ID, identity (fresh or
supplied), attempt, running, and lifecycle (Sent, Admitted, or Uncertain).
Inspection does no transport work and shows no payload. Zero records is
`Available` with an empty list.

### Limits

- A remote reference predicts only when it is given a behavior with `predict`
  (see [optimistic.md](optimistic.md)). A durable or local reference never
  predicts. Notes passes a behavior, so its list reference predicts an add
  (#37).
- Inspection has no Applied case. An Applied record closes its scope first.
- A closed owner can leave a handle's `settled` pending forever.
- An entry mounted after a command committed can read once more after the
  post-settlement refresh.
- An inspection sample is not atomic across records.
- A durable reference passes no active query keys.
- Stores keep every receipt. Nothing prunes them.
