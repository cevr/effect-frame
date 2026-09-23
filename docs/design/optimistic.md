# Optimistic sends

This note records unit 3 of [#19](https://github.com/cevr/effect-frame/issues/19):
provisional revisions on a remote reference. It follows the selective-receipt
rule that [#67](https://github.com/cevr/effect-frame/issues/67) accepted.

Source: `packages/effect-frame/src/actor/provisional.ts`,
`packages/effect-frame/src/actor/ref.ts`, and
`packages/effect-frame/src/actor/behavior.ts`.
Proofs: `packages/effect-frame/tests/actor/optimistic.test.ts`.

## Public surface

```ts
interface Behavior<State, Message, R> {
  readonly initial: State;
  readonly open: (state: State) => Effect<Turn<State, Message>, never, R | Scope>;
  readonly predict?: (state: State, message: Message) => State;
}

interface RefOptions<C> {
  readonly resume: Option<Applied<SnapshotOf<C>>>;
  readonly behavior?: Behavior<SnapshotOf<C>, MessageOf<C>, unknown>;
}

type Displayed<State> = Applied<State> | Provisional<State>;

interface ActorRef<State, Message, Kind> {
  readonly applied: Source<Applied<State>>; // committed only
  readonly displayed: Source<Displayed<State>>; // what the reference shows
  readonly state: Source<State>; // displayed.state
  // send, call, kind: unchanged
}
```

- `Behavior.value` and `Behavior.reducer` have `predict`. It is the pure
  function that their `apply` already runs.
- `Behavior.machine` has no `predict`. A transition can run a task with server
  requirements, so a client cannot run it honestly. There is no flag.
- A remote reference predicts only when `RefOptions.behavior` has `predict`.
  A client can pass a behavior only when it can import it, so the
  `*.server.ts` rule (#24) decides which actors are transparent.
- A local or durable reference never predicts. Its `displayed` is its
  `applied`.
- A remote reference with no `predict` keeps no display. Its `displayed` is
  its `applied`, and `state` derives from `applied`, as before this change.
  So `applied` and `state` never disagree on that reference.
- On a predicting reference, `displayed` and `state` change only when the
  shown value changes. The same committed state seen through the stream and
  through a receipt emits once. `applied` is a separate source there. A
  reader that combines both can see `applied` one revision ahead of
  `displayed` for one step, and longer during a hold.

## Who predicts

A send predicts when all of these are true:

1. The reference is remote and its behavior has `predict`.
2. The framework minted the command ID. A supplied ID can already be admitted
   or committed, so it waits for its receipt (#67, rule 3).

   Two framework sends must know their ID before the send, so they pass it
   in (#37): `Generated.send` derives fields from it, and `View.form` draws
   it into the form's markup. The framework minted both IDs for one send
   alone, so both are fresh. They reach the reference through `mintedFor`,
   which marks the options with a module-private symbol that no public entry
   exports. An application cannot make that mark, so an ID it supplies stays
   supplied, whatever its origin. A form marks only an ID its own client
   binding minted. An ID that the server drew into the markup stays
   supplied, because a plain post that raced hydration can already have
   admitted it. Each later send from the same form mints, so it predicts.

3. The submission created a new command record. A join or a refusal before
   work does not predict.

## The pending log

The reference keeps one log. The log holds each predicted command that the
committed base does not hold, in send order. The displayed state is the base
with the log applied over it by `predict`. With an empty log, the revision is
`Committed`. Otherwise it is `Provisional{base, depth}`, and `depth` is the log
length.

A new command enters the log after the base. It cannot be in a base that the
client read before it sent the command.

### Classification

A committed state `V` can come from the change stream or from a same-ID call.
It becomes the base only when it is newer than the base and the client knows,
for each command in the log, whether `V` holds it.

- A command with its own receipt: `V` holds it when the receipt revision is at
  or below `V`.
- Otherwise the client uses the anchor. The anchor is the receipt with the
  greatest admission position that this reference saw. The mailbox is serial,
  so the anchor orders other admissions:
  - The anchor revision is above `V`: an admission at or after the anchor's is
    not in `V`. An earlier admission is unknown.
  - Otherwise an admission at or before the anchor's is in `V`. At the anchor
    revision, a later admission is not in `V`. After it, a later admission is
    unknown.
- A command with no known admission is unknown.

When all are known, `V` becomes the base. The commands that `V` holds leave
the log. The rest replay over `V`. When one is unknown, the display keeps its
last value, and the reference holds the greatest such `V`. Each new piece of
evidence (an admission, a receipt, a removal) offers the held state and every
receipt state in the log again, newest first.

### How a command leaves

The log entry lives in the command record's scope. The owner runs one
`Enlist` effect in that scope when a submission creates a record, in the same
uninterruptible step as the insertion.

- Applied: the same-ID call stores the exact receipt on the entry before the
  record closes. The entry stays until a base holds it. So an applied command
  can stay in the display while an older base shows (#67, rule 4).
- Rejected: the record closes with no receipt. The entry leaves, and the rest
  replays over the same base. A rollback is not an operation.
- Uncertain: the record stays open, so the entry stays. The guess stays on
  screen. A same-ID retry settles it once.
- The reference closes: every record closes, and the log goes with the
  reference.

The display changes before the handle turns terminal. A caller that waits on
`settled` then reads the display sees the result.

## Decisions against the #19 text

1. **The handle has no `provisional` field.** #19 put
   `provisional: Option<Applied<State>>` on `Admitted` and `Uncertain`. That
   value depends on the base, and the base changes when other commands commit.
   A copy on each handle would need its own sync (`derive-dont-sync`). The
   reference's `displayed` is the one place. The handle keeps the application
   lifecycle only (#67, rule 4).
2. **`applied` stays committed.** `Applied.revision` is a `CommittedRevision`
   by type (unit 2). The displayed value is a new source, `displayed`, of type
   `Displayed<State>`. A resume payload and a changes cursor still come only
   from `applied`.
3. **The stream never settles a command** (#29). A command settles from its
   own same-ID call. The stream only offers committed states to the log.
4. **The machine rule is structural at run time.** `Behavior.machine` returns
   a `Behavior` with no `predict` property. A narrower return type broke the
   `R` inference of `implement`, so the proof is the property check and the
   held-send test.

## Limits

- **The hold.** An entry whose membership is unknown holds every newer
  committed state on this reference. The display stays on the old base, and
  `applied` moves on. The hold ends at exactly one of three events: a same-ID
  call returns the entry's receipt, the record is rejected, or the reference
  closes. Two cases hold:
  - The entry has no known admission. Example: the first send is
    `Unreachable`, and later sends are `Unauthorized`. The owner reads this as
    Hold, and the handle is `Uncertain{admitted: None}`. A retry that meets the
    same refusal holds again.
  - The entry is `Uncertain` with a known admission, but no receipt anchors
    it. The test "Uncertain keeps the provisional state and the same-ID retry
    applies once" shows this: the display stays on base 0 while the server is
    at revision 1, until the retry returns the receipt.

  No API gives up a prediction today. #67 accepted the hold as the cost of
  selective receipts. The missing give-up path is raised with the owner on
  #67.

- The reference holds one greatest unclassified state and the receipt states
  of the log. An intermediate stream state can be dropped. A later state
  subsumes it.
- `predict` must be total, pure, and fast. When it throws during a replay,
  that entry leaves the log, and the display shows the base with the other
  entries. The reference logs `command.predict.defect commandId=…` as a
  warning. The change stream, `applied`, and the command itself continue:
  its handle still settles from its own receipt.
- A reload loses the log. The next page reads committed state.
- Notes stays opaque. No example app passes a behavior yet.

## Evidence

| Proof                                                   | What the test observes                                                                                                                                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| An optimistic send shows the new state in the same turn | The send is held before the host. When `send` returns, the handle is `Sent` and `displayed` is `Provisional{base: 0, depth: 1}`. The change stream is down, and the receipt alone commits it.    |
| A committed revision replaces a provisional one         | The server stamps each item. A's commit replaces its `pending` stamp while B stays provisional over base 1. No predicted field survives.                                                         |
| A rejected command rolls back by leaving the log        | A is refused while B is held. The display becomes B alone over base 0.                                                                                                                           |
| Provisional order converges on committed order          | A is sent first and admitted second. The view goes `[a?]`, `[a?, b?]`, `[b1, a?]`, `[b1, a2]`. The last value equals the server snapshot.                                                        |
| A supplied command ID never predicts                    | A held send with a supplied ID leaves the display committed.                                                                                                                                     |
| A framework-minted ID predicts                          | `Generated.send` with a held send shows `Provisional{base: 0, depth: 1}` (`optimistic.test.ts`). A client-drawn form's held send shows its text at once (`tests/view/form-prediction.test.tsx`). |
| A server-drawn form ID and a forged mark stay supplied  | A hydrated form's first send carries the server's `$command` and shows nothing until its receipt; its second send predicts. Options with a look-alike symbol leave the display committed.        |
| Uncertain keeps the provisional state                   | A lost call reply leaves `Uncertain{attempt: 1}` and the guess. One retry settles it: two sends, two calls, one application.                                                                     |
| A prediction that throws leaves the log                 | The prediction of "a" throws over a base that holds "boom". "a" leaves the log and still settles at revision 2. Another client commits revision 3, and `applied` and `displayed` both reach it.  |
| A machine behavior is never applied optimistically      | `Behavior.machine` has no `predict`. At `Sent` and at `Admitted`, the display stays committed.                                                                                                   |

Ten mutations were checked. Each made at least one proof fail: no log entry
on send, a rejected entry kept, included entries kept after a new base,
unknown membership read as excluded, a machine given an identity prediction,
a supplied ID predicted, an `Uncertain` record that closes its scope, a
refresh that keeps an override, an ignored receipt, and a replay that does
not catch a throwing `predict` (the stream stops and the test times out).

Five more mutations cover fresh-ID ownership (#37), and each was killed:
the old `form.ts` (both form tests fail); a form that marks every adopted ID
(the hydrated test fails); `Generated.send` passing a plain `{commandId}`
(its test fails); `isMinted` true for any options with a `commandId` (the
supplied, forged, and hydrated tests fail); and an owner that ignores the
mark (three tests fail).
