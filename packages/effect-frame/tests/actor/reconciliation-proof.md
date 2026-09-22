# Issue 67 reconciliation proof

This note records a private prototype. It does not authorize a public command
handle or prediction API.

The prototype uses the real `ActorHost`, hosted `durable` actor,
`MailboxStore.layerMemory`, and the existing `TransportService`. The wrapper
delegates every server operation. It only delays or drops selected real replies
and stream projections. It does not implement a backend, a second mailbox, a
new wire verb, an event attribution field, or a public API.

The pure classifier and the private scoped coordinator are in
`packages/effect-frame/tests/actor/reconciliation-prototype.ts`. The companion
tests are in `packages/effect-frame/tests/actor/reconciliation.test.ts`.

## Actual evidence

The focused test run passes 13 tests with 103 assertions:

```text
bun test --conditions=source packages/effect-frame/tests/actor/reconciliation.test.ts
13 pass
0 fail
103 expect() calls
```

The tests prove these bounded cases:

| Requirement                         | Evidence                                                                                                   | Result and limit                                                                                                                                                                                                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Selective admission rule            | Pure 3 by 3 table for `b<a`, `b=a`, `b>a` crossed with `r<V`, `r=V`, `r>V`                                 | A newer anchor excludes only admissions at or after its own admission. Earlier admissions remain unknown.                                                                                                                                                            |
| Held candidate retention            | Pure V5 held, late V3 safe base, then later anchor evidence                                                | V3 becomes the safe base. V5 stays held. The later evidence publishes V5 without another V5 stream emission.                                                                                                                                                         |
| Older anchor regression             | Real B admission 1 and public revision 1 arrive before real A admission 2 and public revision 2            | The B candidate stays held because A's newer anchor cannot classify the earlier B admission. B's real exact call then releases it.                                                                                                                                   |
| Stream before receipt               | Coordinator mints a generated ID, predicts count 1, and holds the real send reply after the server commits | Public count stays 1 while the stream delivers revision 1. The exact call projection settles the command. The stream does not predict again.                                                                                                                         |
| Public server field                 | Server state contains private `serverOnly` and public server-computed `publicToken`                        | The server generates the public token through the test `Crypto` layer. Coordinator evidence contains only decoded public projections. A private store read checks the server assertion only. The predictor retains the prior token and cannot compute the new token. |
| Reverse admission                   | Real B is admitted before A although logical intent is A then B                                            | A's exact public result already includes B. B's exact public result remains its own revision. The classifier does not apply B twice.                                                                                                                                 |
| Unknown admission and remote change | Real B send reply is held while a real autonomous public projection arrives                                | The prior coherent view remains visible. The candidate is held until B's real receipt evidence arrives.                                                                                                                                                              |
| Autonomous revision                 | Real autonomous public revision arrives between A and B exact calls                                        | The newest safe base remains visible. A late exact public projection cannot regress it.                                                                                                                                                                              |
| Overlay incorporation               | Real exact public call result arrives while its stream projection is held                                  | The overlay remains visible over the older base and is incorporated when the real stream projection arrives.                                                                                                                                                         |
| Eight-attempt bound                 | Private coordinator worker, real dropped send replies, busy real autonomous stream, `TestClock`            | Automatic sends stop at attempt 8. No call or classification traffic starts from the stream. Manual retry sends the same ID and byte-identical payload.                                                                                                              |
| Supplied ID safety                  | Real command commits before coordinator construction                                                       | Supplied ID does not predict before real evidence. Duplicate send plus exact call returns the existing public result once.                                                                                                                                           |
| Scope ownership                     | Coordinator stream worker and command worker run in a separate client scope                                | Closing the client scope stops both workers. The real store keeps admitted work and later commits it after the server gate opens. The prototype makes no cancellation claim for admitted work.                                                                       |
| Lost reply and refusal              | Real send commits, wrapper drops the reply, then authorizer refuses the same ID                            | The coordinator records possible admission and classifies the later refusal as `uncertain`. It does not claim terminal rejection.                                                                                                                                    |

## Reconciliation rule

An exact receipt anchor has admission `a` and revision `r`. A candidate has
revision `V`. For another known admission `b`:

- If `r < V`, `b <= a` is included and `b > a` is unknown.
- If `r = V`, `b <= a` is included and `b > a` is excluded.
- If `r > V`, `b < a` is unknown and `b >= a` is excluded.

An exact receipt for the pending command itself uses only revision comparison:
`receipt revision <= candidate revision` means included; otherwise it means
excluded. An unknown admission or missing receipt keeps the prior coherent view.
The coordinator stores one greatest held candidate. A safe older candidate can
advance the base while the greater held candidate remains available for later
classification.

Inclusion in a displayed base is separate from possessing the command's exact
result. The coordinator keeps an Applied command record and its exact public
result after the overlay is incorporated. This lets a later stream candidate
classify the command without retaining an unbounded snapshot history.

## Client boundary and worker policy

The coordinator receives evidence from four existing transport paths only:

1. A `send` acknowledgment supplies admission and an optional committed
   revision.
2. A same-ID `call` supplies the exact decoded public projection.
3. A `changes` stream supplies decoded public projections without command
   identity.
4. The initial `snapshot` supplies the initial decoded public projection.

The coordinator encodes a message once when it creates a handle. Every
automatic and manual attempt reuses that exact payload and command ID. The
coordinator mints a fresh UUID for the generated path. A supplied ID waits
for real receipt evidence.

The command worker owns the bounded eight-send sequence and sleeps between
attempts. A successful send performs one same-ID call to obtain exact public
state. A stream worker only classifies received projections. A stream update
never starts a retry, receipt poll, or classification request. The worker
stats are local test evidence that both workers stop with their owning scope.

## Cost and limits

The selective policy keeps one safe base, one greatest held candidate, active
overlays, and exact receipt anchors. It does not keep an unbounded stream
history. Unknown admission or a missing receipt can delay unrelated remote
state until evidence arrives.

The conservative hold-all-pending-cohort policy needs less classification state,
but it hides A's public server field until every pending command settles. The
selective rule can show A's exact public base plus B's prediction when A's
anchor proves B follows it. This prototype therefore supports the selective
rule with its explicit unknown-admission latency cost.

The current production protocol still needs the existing same-ID `call` path
after an ordinary admitted `send` to obtain exact post-commit state. This
prototype does not add that settlement API. The generated ID source is a
private UUID mint for this bounded proof. A production command handle still
needs the framework's globally fresh ID contract.

These tests use in-process real host fixtures. They do not prove network
reordering, process crash recovery of client workers, multi-host clock
coordination, global command ID uniqueness, or a production UI integration.

## Source receipts

- `/Users/cvr/Developer/personal/.rifts/effect-frame/command-reconciliation/packages/effect-frame/src/actor/durable.ts`
- `/Users/cvr/Developer/personal/.rifts/effect-frame/command-reconciliation/packages/effect-frame/src/actor/mailbox-store.ts`
- `/Users/cvr/Developer/personal/.rifts/effect-frame/command-reconciliation/packages/effect-frame/src/actor/host.ts`
- `/Users/cvr/Developer/personal/.rifts/effect-frame/command-reconciliation/packages/effect-frame/src/actor/transport.ts`
- `/Users/cvr/Developer/personal/.rifts/effect-frame/command-reconciliation/packages/effect-frame/src/actor/ref.ts`
- `/Users/cvr/Developer/personal/.rifts/effect-frame/command-reconciliation/packages/effect-frame/src/actor/vocabulary.ts`
- `/Users/cvr/Developer/personal/.rifts/effect-frame/command-reconciliation/packages/effect-frame/src/actor/implement.ts`
- `/Users/cvr/Developer/personal/.rifts/effect-frame/command-reconciliation/packages/effect-frame/tests/actor/reconciliation-prototype.ts`
- `/Users/cvr/Developer/personal/.rifts/effect-frame/command-reconciliation/packages/effect-frame/tests/actor/reconciliation.test.ts`
- `/tmp/effect-frame-reconciliation-review-round1.md`
- `/tmp/effect-frame-reconciliation-proof-scope.md`
- `/tmp/effect-frame-command-decision-issue.md`
- `/tmp/effect-frame-reconciliation-root-counterexamples.json`
