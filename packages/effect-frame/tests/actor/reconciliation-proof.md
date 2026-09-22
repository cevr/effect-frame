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

## Validation

The focused test run passes 16 tests with 144 assertions:

```text
bun test --conditions=source packages/effect-frame/tests/actor/reconciliation.test.ts
16 pass
0 fail
144 expect() calls
```

The exact five final-review probes also pass:

```text
bun test --conditions=source /tmp/effect-frame-reconciliation-review-probes/review.test.ts
5 pass
0 fail
34 expect() calls
```

## Evidence matrix

| Requirement                     | Evidence                                                                                       | Result and limit                                                                                                                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Selective admission rule        | Pure 3 by 3 table for `b<a`, `b=a`, `b>a` crossed with `r<V`, `r=V`, `r>V`                     | A newer anchor excludes only admissions at or after its own admission. Earlier admissions remain unknown.                                                                                     |
| Greatest held candidate         | Pure V5 held, late V3 safe base, valid later B receipt pair at V5                              | V3 becomes the safe base. V5 remains held. Valid later evidence publishes V5. The test does not change one command receipt revision.                                                          |
| R1 coordinator retention        | Real A/B sends, dropped stream V2, real autonomous V3, held B call                             | V1 becomes safe. V3 remains held. B evidence publishes V3 without another V3 stream delivery.                                                                                                 |
| R2 conclusive rejection         | Real authorizer refuses the first generated send                                               | The command is rejected after one attempt. Possible admission is false. The generated prediction is removed from the visible state.                                                           |
| Stream before receipt           | Coordinator mints a UUID, predicts count 1, and holds the real send reply after server commit  | Public count stays 1 while the real stream delivers revision 1. The exact same-ID call settles the command. The stream does not predict again.                                                |
| Public field while B is pending | Real A call reply is held while real B is admitted and held in the durable behavior            | A's opaque public token appears with B still pending. The predictor retains the old token. The private `serverOnly` field is absent from client state.                                        |
| Reverse admission               | Coordinator delays A's real send. B is admitted first. A and B use real send and call evidence | B has exact revision 1. A has exact revision 2 that includes B. The visible base reaches A once.                                                                                              |
| Unknown admission               | Real B send reply is held while a real autonomous projection arrives                           | The coordinator keeps the prior visible state. B's real send and call evidence then publish the newer projection.                                                                             |
| Autonomous late receipt         | A's real call reply is held while an autonomous revision arrives                               | The autonomous revision remains the base when A's older exact reply arrives.                                                                                                                  |
| Other-client revision           | A's real call reply is held while another real client command commits                          | The newer other-client projection remains the base. A retains its exact older result.                                                                                                         |
| Overlay incorporation           | A settles while B admission is unknown                                                         | A remains `applied` with its exact result. Its overlay stays over base V0 until B evidence allows the newer base to publish.                                                                  |
| Eight-attempt bound             | Private worker, real dropped sends, busy real autonomous stream, and `TestClock`               | Automatic traffic stops after eight sends. No call starts from the stream. Post-exhaustion stream and clock activity cause no ninth automatic send. Manual retry makes one send and one call. |
| Exact payload retention         | One encode counter and all real send/call records                                              | Encoding runs once. Automatic and manual requests keep the same ID and bytes.                                                                                                                 |
| Supplied ID safety              | Real command commits before coordinator construction                                           | The supplied ID does not predict before real evidence. Same-ID resend returns the existing public result.                                                                                     |
| Scope ownership                 | Coordinator stream and command workers run in a separate client scope                          | Closing the client scope stops both workers. The durable pending command survives and later commits after its server gate opens.                                                              |
| Lost reply and refusal          | Real send commits, the wrapper drops its reply, then the authorizer refuses the same ID        | The coordinator retains possible admission and reports `uncertain`. It does not claim terminal rejection.                                                                                     |

## Reconciliation rule

An exact receipt anchor has admission `a` and revision `r`. A candidate has
revision `V`. For another known admission `b`:

- If `r < V`, `b <= a` is included and `b > a` is unknown.
- If `r = V`, `b <= a` is included and `b > a` is excluded.
- If `r > V`, `b < a` is unknown and `b >= a` is excluded.

An exact receipt for the pending command itself uses only revision comparison:
`receipt revision <= candidate revision` means included. Otherwise it means
excluded. An unknown admission or missing receipt keeps the prior coherent view.
The coordinator stores one greatest held candidate. A safe older candidate can
advance the base while a greater unknown candidate remains available for later
classification.

Inclusion in a displayed base is separate from possessing the command's exact
result. The coordinator keeps an `Applied` command record and its exact public
result after the overlay is incorporated. It retains command records and
receipt anchors for the owning scope.

## Client boundary and worker policy

The coordinator receives client evidence from existing transport paths only:

1. A real `send` acknowledgment supplies admission and an optional committed
   revision.
2. A same-ID `call` supplies the exact decoded public projection and its
   revision.
3. A real `changes` stream supplies decoded public projections without command
   identity.
4. The initial `snapshot` supplies the initial decoded public projection.

Every admission and revision pair used by coordinator reconciliation comes from
real retained-ID send and call evidence. Direct `MailboxStore` reads remain
separate server assertions. They do not supply client overlay or receipt
evidence.

The coordinator encodes a message once when it creates a handle. Every
automatic and manual attempt reuses that exact payload and command ID. The
coordinator mints a fresh UUID for the generated path. A supplied ID waits for
real receipt evidence.

The command worker owns the bounded eight-pass sequence and sleeps between
passes. A successful pass performs one same-ID call for exact public state. A
stream worker only classifies received projections. A stream update never starts
a retry, receipt poll, or classification request.

## Cost and limits

The ordinary connected path uses one `send` and one same-ID `call`. Each retry
pass can use one send and one call. Eight retry passes can therefore use up to
16 transport requests. The dropped-send case uses eight sends and zero calls.

The classifier keeps one safe base, one greatest held candidate, active
overlays, and exact receipt anchors. The coordinator retains all submitted
command records and receipt anchors until its scope closes. This is scope-lifetime
state. It is not a bounded production handle store.

Unknown membership can delay unrelated remote state. The selective rule still
allows A's public field to appear while a later B remains pending when A's
receipt anchor proves B follows it. No fifth verb, stream command identity, or
new event log is required.

These tests use in-process real host fixtures. They do not prove network
reordering, process crash recovery of client workers, multi-host coordination,
global command ID uniqueness, an `ActorStopped` real-host case, or production UI
integration. The generated UUID source is private to this prototype. Production
still needs a global fresh-ID contract.

## Source receipts

- `/Users/cvr/Developer/personal/.rifts/effect-frame/command-reconciliation/packages/effect-frame/src/actor/behavior.ts`
- `/Users/cvr/Developer/personal/.rifts/effect-frame/command-reconciliation/packages/effect-frame/src/actor/durable.ts`
- `/Users/cvr/Developer/personal/.rifts/effect-frame/command-reconciliation/packages/effect-frame/src/actor/host.ts`
- `/Users/cvr/Developer/personal/.rifts/effect-frame/command-reconciliation/packages/effect-frame/src/actor/implement.ts`
- `/Users/cvr/Developer/personal/.rifts/effect-frame/command-reconciliation/packages/effect-frame/src/actor/mailbox-store.ts`
- `/Users/cvr/Developer/personal/.rifts/effect-frame/command-reconciliation/packages/effect-frame/src/actor/ref.ts`
- `/Users/cvr/Developer/personal/.rifts/effect-frame/command-reconciliation/packages/effect-frame/src/actor/transport.ts`
- `/Users/cvr/Developer/personal/.rifts/effect-frame/command-reconciliation/packages/effect-frame/src/actor/vocabulary.ts`
- `/Users/cvr/Developer/personal/.rifts/effect-frame/command-reconciliation/packages/effect-frame/tests/actor/reconciliation-prototype.ts`
- `/Users/cvr/Developer/personal/.rifts/effect-frame/command-reconciliation/packages/effect-frame/tests/actor/reconciliation.test.ts`
- `/tmp/effect-frame-reconciliation-review-round1.md`
- `/tmp/effect-frame-reconciliation-review-round2.md`
- `/tmp/effect-frame-reconciliation-proof-scope.md`
- `/tmp/effect-frame-command-decision-issue.md`
- `/tmp/effect-frame-reconciliation-root-counterexamples.json`
- `/tmp/effect-frame-reconciliation-review-probes/review.test.ts`
