# Issue 67 reconciliation proof

This note records a private prototype. It does not authorize a public command
handle or prediction API.

The proof uses the real `ActorHost`, hosted `durable` actor,
`MailboxStore.layerMemory`, and the existing `TransportService`. The transport
wrapper delegates every server operation. It only holds selected real replies
or selected real stream projections. It does not implement a backend or a
second mailbox.

The pure prototype is in
`packages/effect-frame/tests/actor/reconciliation-prototype.ts`. It classifies
an exact command receipt by revision. It uses an admission and revision anchor
to classify a known prefix or suffix. Unknown membership retains the prior
coherent view and stores one conflated candidate. A candidate is never used as
command identity.

## Results

The companion test file passes 11 tests with 73 assertions.

1. A real stream projection for A arrives while A's real send reply is held.
   The classifier retains the old visible counter at 0. The exact stored
   receipt later settles the base at 1. The counter never becomes 2.
2. A's stored receipt contains private `serverOnly: "A:1"` data. The public
   projection hides that field. B is admitted and held in the real durable
   loop. The anchor classifies B as excluded from A's base, so B is predicted
   once. Reprocessing the same candidate remains at count 2.
3. The test records logical send intent A then B. A client gate dispatches the
   real requests so B is admitted first. The real mailbox produces B at
   admission 1 and A at admission 2. A's exact receipt is revision 2 and
   already contains B. Releasing B's held reply does not add B again. B's own
   exact result remains revision 1.
4. B's real reply is held, so the client has no B admission even though the
   real stream advances. The classifier retains the prior view through B and a
   later autonomous revision. The B receipt then classifies the candidate.
5. A real autonomous revision arrives between command evidence. The newest
   candidate remains visible after A's older receipt arrives. A later B receipt
   advances the candidate. A late A receipt cannot regress it.
6. A real stream projection is held after the command's exact result is
   available. The base remains at revision 0 and its overlay remains visible.
   The overlay is released only when the held revision 1 projection arrives.
7. Eight private automatic attempts call the real transport. The wrapper drops
   each real reply. Autonomous stream traffic does not create a ninth attempt.
   A manual ninth request uses the same command ID and byte-identical payload.
   No call or classification request is started by the stream.
8. The real actor commits a supplied ID before reference construction. The
   initial reference starts at revision 1. A duplicate send reports committed
   revision 1 and does not apply a second command. Generated IDs use the
   immediate prediction policy in the private classifier. Supplied IDs wait
   for receipt classification. Retry keeps the original ID and payload.
9. Closing the client scope interrupts the waiter and its reference stream
   worker. The real store still has the admitted command pending. Releasing the
   server behavior gate lets the still-live server host commit that command.
   The proof makes no cancellation claim about admitted durable work.
10. A real accepted request has its reply dropped after the store receipt is
    present. A later real authorization refusal is classified as uncertain.
    A real stopped durable actor returns `ActorStopped` after admission. That
    outcome is also classified as uncertain. Neither outcome is a terminal
    rejection proof.

## Cost and boundary

The selective policy keeps one committed candidate, one held candidate, the
pending overlay set, and exact receipt anchors. It does not retain an
unbounded stream snapshot history. A stream update performs classification
from already available evidence. It does not start a receipt probe or another
automatic attempt. Unknown admission or a missing receipt can delay unrelated
remote state until evidence arrives.

The conservative hold-all-pending-cohort policy needs less classification
state. It also hides A's server-only field until every pending command settles.
The selective rule exposes A's exact base plus B's overlay when the A anchor
proves B follows it. The private proof therefore supports the selective rule,
with the explicit latency cost for unknown admission.

The current production protocol still requires an ordinary admitted send to
obtain exact post-commit state through the existing same-ID call path. This
prototype does not add that settlement API. It does not add wire fields,
verbs, event-log entries, projection attribution, global registries, or UI
simulators.

## Source receipts

- `/Users/cvr/Developer/personal/effect-frame/packages/effect-frame/src/actor/durable.ts`
- `/Users/cvr/Developer/personal/effect-frame/packages/effect-frame/src/actor/mailbox-store.ts`
- `/Users/cvr/Developer/personal/effect-frame/packages/effect-frame/src/actor/host.ts`
- `/Users/cvr/Developer/personal/effect-frame/packages/effect-frame/src/actor/transport.ts`
- `/Users/cvr/Developer/personal/effect-frame/packages/effect-frame/src/actor/ref.ts`
- `/Users/cvr/Developer/personal/effect-frame/packages/effect-frame/src/actor/vocabulary.ts`
- `/Users/cvr/Developer/personal/effect-frame/packages/effect-frame/src/actor/implement.ts`
- `/Users/cvr/Developer/personal/effect-frame/packages/effect-frame/tests/actor/reconciliation-prototype.ts`
- `/Users/cvr/Developer/personal/effect-frame/packages/effect-frame/tests/actor/reconciliation.test.ts`
- `/tmp/effect-frame-reconciliation-proof-scope.md`
- `/tmp/effect-frame-command-decision-issue.md`
- `/tmp/effect-frame-command-settlement-scope.md`
