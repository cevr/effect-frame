# Architecture pass 2: actor area, `actor/http`, `actor/testing`, `src/frame.ts`

Read-only. The only file written is this report. The scratch probes are in
`/tmp/claude-1000/-home-exedev-Developer-personal/cacfac5c-ac95-4967-a839-81db3553734d/scratchpad/pass2-actor/`: `probe-f2.ts` with its `tsconfig.json`, and `g.sh`, the grep wrapper.

Caller-count grep, run from the repo root for every count below:

```
rg -g '!**/node_modules/**' -g '!**/dist/**' -g '!*.md' -g '!**/worker.js' <pattern> packages apps tooling
```

A count reported as "tests=N other=M" counts files outside `src/actor/`. `other` lists the files by name when it matters.

Ledger checked: every pass 1 row is done, rejected, or skipped (`plans/architecture-loop-2026-09-24.md`). No candidate below re-opens a done or rejected row without a new receipt. A16 (`read-ahead.ts:20` `heldPatch`) and A18 (`command-id.ts:35` `minted`) stay as they are. No candidate changes a wire or stored format.

---

## Answers

### Q1. F2: a view write that can fail with `ActorStopped`

**The premise is half true: `send` cannot fail today.**

- `ActorRef.send` has no error channel: `vocabulary.ts:300-303` types it `Effect.Effect<CommandHandles<…>[Kind]>`, and its doc says "`send` never fails" (`vocabulary.ts:285-286`).
- The local implementation keeps that promise. `actor.ts:124-133` maps a failed `admit` to `stoppedHandle()`, a handle already `Rejected(ActorStopped)` (`actor.ts:34-40`).
- Probe `probe-f2.ts` (tsc over the package source): `const _: Effect.Effect<unknown, never> = open.send(Value.Set(true))` compiles, and `View.event(() => open.send(…))` compiles. `View.event(() => modify(open, …))` fails with `effect(missingEffectError)`: "Missing errors ActorStopped".

The writes that fail are the call-shaped ones:

- `derive`, which awaits the reply: `actor.ts:106-108` and `:138-141`.
- `modify`, which is `derive` (`actor.ts:160-177`).
- `call`.

EGW's `whileMounted` wraps five writes (`app.tsx:277, 341, 476, 726, 730`). Three of them wrap `send` and are dead code. Only the two `modify` wraps (`:476`, `:730`) do anything. The same catch appears in the framework's own tests and tooling:

- `tests/view/dom.test.tsx:43` and `:885-887`
- `tests/view/listener-ownership.test.tsx:267-270`
- `tests/router/url-state.test.tsx:331` (`call`)
- `tooling/dom-bench/src/fixtures/effect-frame.tsx:45-50` (`call`)

**Can a handler run during or after its view's teardown?** No, for an actor its own view or an ancestor made. Receipts:

- A handler forks into the scope current when its element was built (`view/runtime.ts:902-905`, then `runOwned` at `:836-845` does `Effect.forkIn(…, scope)`).
- A scope is marked `Closed` before its finalizers run (effect `src/internal/effect.ts:3921-3922`). A fork into a closed scope is interrupted before it starts (`effect.ts:5558-5561`).
- The listener is removed by a finalizer on the same scope (`runtime.ts:889-894`).
- Finalizers run last-in, first-out (`effect.ts:3950`, the loop from `arr.length - 1` down). The actor's stop finalizer is added during setup (`local-engine.ts:106-108`), before the build forks branch and row scopes and registers listeners, so those close first.

So `ActorStopped` cannot reach a handler through an actor made in its own or an ancestor's setup. It can reach one through an actor from a sibling scope, and through an actor opened later than the branch in the same scope. The runtime cannot tell these cases apart.

**The options:**

| Option | Verdict | Receipt |
| --- | --- | --- |
| The runtime catches `ActorStopped` for handlers | Rejected (explicit). It swallows a failure the runtime cannot attribute to an actor. It is the swallow A14 deleted with `Cell` (pass 1 `actor.md` A14, `cell.ts:25-26`). | Soundness holds only for own and ancestor actors (above). |
| `Handler` accepts `Effect<unknown, ActorStopped>` | Rejected (explicit). The runtime still has to drop the failure, and the view layer would name an actor error. | `view/view.ts:83-88`: "Its failures must already be handled". |
| `View.state(initial)` | Rejected. It is a second spelling of `Actor.local(Behavior.value(x))`, against the A14 decision (actor-model), and it does not stop `modify` from failing. | Ledger row A14. |
| **Local writes are send-shaped** | **Adopt (actor-model): candidate P2-A1.** A write is a message, its submission never fails, and its fate is a state of the handle. `send` already works this way; `derive` and `modify` do not. | `actor.ts:124-141` |

**The `Local<A>` alias.** An app writes the type only where a reference crosses a function boundary (props or a parameter). EGW's four `Local<A>` annotations (`app.tsx:270, 467, 722`, and the alias at `:74`) annotate `yield*` results that inference already gives. Where the type is required, it is written out in full in three places:

- `apps/notes/src/commands.ts:21` (`DraftRef`)
- seven test sites (`rg "LocalActorRef<"`: `opentui.test.tsx:51,62`, `dom.test.tsx:712,780`, `listener-ownership.test.tsx:264`, `testing-inspection.test.tsx:96`, `types.test.ts:206`)
- `modify`'s own signature, three times (`actor.ts:164, 167, 173`)

Export it, keeping "local" in the name: candidate P2-A2.

### Q2. A12: the query cache's state in closure variables

**Current shape.** `SubscriptionRef<SlotState>` (`query-client.ts:430-433`) is the published cell. Beside it, eight closure `let`s hold the rest of the slot's state:

- `own`, `pending` (`:435-436`)
- `readStarted` (`:462`)
- `freshAfter` (`:465`)
- `inflight` (`:469`)
- `generation` (`:472`)
- `granted` (`:477`)
- `heldSeed` (`:619`)

They are written:

- inside `SubscriptionRef.update` and `modify` callbacks: `write` `:437-443`, `amend` `:447-456`, `recount` `:457-461`
- inside `Effect.suspend`: `land` `:479-485`, `reject` `:487-499`, `read` `:508-511`, `forget` `:581-588`, `readAfter` `:591-597`
- inside `Effect.sync`: `clear` `:504-506`
- by a plain synchronous setter on the slot interface: `holdSeed` `:630-632`

The cache level has the same pattern:

- `claims`, `live`, `sequence`, `principal` (`:1146-1156`)
- `table`, `held`, `actorSeeds`, `expired` (`:925-932`)
- `followQuery`'s `current` (`:1515`). It is written by the args fiber (`enter`/`leave`, `:1527-1561`) and read by `refresh` and `override` from handlers (`:1593-1606`).

**The defect class.** Check-then-act across a yield point, and a publish ordered against private bookkeeping. `refresh` (`:538-556`) is an example: it reads `inflight`, yields, then sets it. The rule is enforced by stamps (`generation`, `readStarted`, `freshAfter`) and by comments, not by construction.

The history is the receipt: 6 of the 28 commits on `query-client.ts` fix ordering:

- `5d25f20`: "take a streamed seed and promise its publication in one step"
- `652b8b4`: "move stateful sources in one step"
- `b0654fc`: "mark uncovered dependents stale before a command releases them"
- `5efe89b`, `bacd899`, `be70a93`

The comments `:686` and `:750` ("review round 2") and `:967` ("review round 1") record more of the same.

**Should pass 2 do it?** Yes, as its own last group, gated in two steps. No public API change; north star actor-model and effect-native. The P2-A6 row below gives the step-by-step plan.

- **Step 0: a model-based test.** A pure reference model of one slot, with transitions `land`, `fail`, `refresh`, `recount`, `forget`, `readAfter` and `principalGone`, run against the real slot under random interleavings with `TestClock` and forced yields. It must pass on today's code before step 1.
- **Step 1: one owner of each transition's state.** One private `SlotState` record (`own`, `pending`, `readStarted`, `freshAfter`, `inflight`, `generation`, `granted`) in a `SynchronizedRef`. Each transition becomes one pure function applied by one `modify`, which returns the effect to run afterwards; the published `SubscriptionRef` is derived. `current` in `followQuery` moves into a `SynchronizedRef` the same way.

Gate: step 0, plus the `revocation`, `command-cache`, `streaming-*` and `query` tests. If step 0 cannot be written, A12 stays skipped.

### Q3. Carry-over

**Foldkit `Stale`: yes, `QueryState` drops the value on a failed refresh today.**

- `reject` writes `Failed(error)` over the slot's `Ready` (`query-client.ts:487-499`, line `:494`).
- `tests/actor/query.test.ts:614-657` ("a failed refresh answers RefreshFailed…") asserts that a command refresh failure turns the held `Funnel` into `Failed`.
- `Source.load` does the same (`source.ts:286-293`).
- `View.errored` then trips on it (`view/readiness.tsx:316, 324-325`).

Pass 1's wire objection is obsolete. A3 removed the view `QueryState` Schema (`rg "QueryState\.schema"` finds nothing), and `RefreshFailed` carries only the error (`transport.ts:28`), so the value is already on the client. The inspection record keeps its tag set (`frame.ts:75`).

What remains is an owner question, not a change. CONTEXT says "Never two of these at once" (Query state), and the change touches what readiness means. See owner question O1.

**P15 (a debounced input marks results stale): no framework change now.**

- Consumers: `rg "followQuery\("` finds 7 test call sites, 0 in-repo apps, and 1 in EGW (`app.tsx:296`).
- EGW's hand-written `pending` zip (`app.tsx:297-305`) needs a second source, `settledState` (`app.tsx:687-688`, `:725`). Otherwise a revert inside the debounce window reads as a fresh answer and resets `expanded`.
- A `followQuery(…, { debounce })` would have to expose the same two sources, so it moves 10 lines into the framework and saves nothing. Hold it until a second consumer shows up.

**Per-field form issues through the one decoder: yes, but the defect comes before pre-submit validation.**

- A scripted submit that does not decode is logged and dropped: `view/form.ts:280-282` (`Effect.logWarning("View.form: the form did not decode", …)`).
- The plain post of the same input answers with issues through `issuesOf` (`http/form-post.ts:354`).
- `tests/view/plain-form.test.tsx:404` states it: "the form does not decode and sends nothing".
- `FormBinding.issues` is a static array (`view/form.ts:61-63`).

So one form shows issues without a script and nothing with one, which is a per-mode branch. Fix that first (P2-A3). Foldkit-style pre-submit field state then derives from the same decode and the same `issuesOf`, with no second validator (pass 1 7a stays rejected).

### Q4. Module-level side-channel maps in `src/actor`

**No findings.** `rg -n "^const .*new (Weak)?(Map|Set)|^let |^export let" src/actor src/frame.ts` finds:

- `command-id.ts:35` `minted`: A18, kept.
- `form.ts:152` `refusedSegments`: a constant set of `__proto__`, `constructor` and `prototype`.

`read-ahead.ts:20` `heldPatch` is a symbol key (A16, kept). `rg "WeakMap|WeakSet" src/actor src/frame.ts` finds only `minted`.

### Q5. Other findings

- **Framework plumbing is public API (P2-A4).** `src/view` and `src/router` import actor internals through the public entry `effect-frame/actor/client`, while 8 other imports reach the same modules by relative path (`rg -c 'from "\.\./actor/|from "\.\./\.\./actor/'`). `export * as Form/Generated/Streaming/Wire` therefore publishes every helper.
- **One concept with two owners.**
  - `Form.codec` and `Form.decode` (P2-A5).
  - The "stale Ready" rule is written four times (not-worth list).
  - Local admission-to-handle is written twice, in `send` and `derive` (folded into P2-A1).
- **`src/frame.ts`:** no candidate. `Frame.QueryValue` has 0 users. `Frame.layer`'s `name?` is an optional label. Both are on the not-worth list.
- **`http/`:** nothing new beyond `Wire` (P2-A4). `rg "Promise|\.then\(|runFork|runPromise|addEventListener" src/actor` finds nothing.
- **`testing/`:** no new findings. `HttpTest.client` has 6 files of callers. `factoryFromLayer` has one caller (already on the pass 1 edges not-worth list).

---

## Candidates

### P2-A1. Local writes are send-shaped: `derive` and `modify` return a handle and never fail

- **Files:**
  - `packages/effect-frame/src/actor/actor.ts:100-109` (`LocalActorRef.derive` type), `:124-141` (`send`, `derive`), `:160-177` (`modify`).
  - Callers:
    - `rg "\bmodify\("` gives 13 test sites: `tests/actor/local.test.ts:110,130,398`, `tests/view/testing.test.tsx:209,262,288,732,939,1011`, `tests/view/dom.test.tsx:43,885`, `tests/view/opentui.test.tsx:84`, `tests/view/listener-ownership.test.tsx:267`.
    - 0 in apps and 0 in tooling. EGW has 2 (`app.tsx:476, 730`).
    - `rg "\.derive\("` finds only `actor.ts:176`.
- **Problem:**
  - A local reference has two write shapes with different failure channels. `send` never fails (`vocabulary.ts:285-303`). `derive` and `modify` await the reply and fail with `ActorStopped | Refusal`.
  - A view `Handler` and a `Source.on` callback have no error channel (`view/view.ts:88`, `source.ts:194-198`), so every read-modify-write from a view needs a catch. There are 4 such catches in the repo (listed in Q1) and EGW's `whileMounted`.
  - The admission-to-handle mapping lives only in `send` (`actor.ts:125-132`). `derive` repeats the admission with a different shape (`:139-140`).
- **North star:** actor-model (a write is a message: submitting it never fails, and its fate is a handle state). Also explicit (no catch that hides a stop).
- **Change:**
  - `derive(compute)` returns `Effect<CommandHandle<State, "local", Refusal>>`, built exactly like `send`'s handle. `send(message)` becomes `derive(() => message)`.
  - `modify` returns the same handle.
  - A caller that needs the committed state writes `yield* (yield* modify(ref, f)).settled`, which gives `Applied` or `Rejected`, as a `send` caller already does.
  - `call` stays call-shaped: request and reply, failing.
  - Delete the 4 catches. EGW deletes `whileMounted` (`app.tsx:76-83`) and its 5 wraps.
- **Lines removed:** about 6 in `actor.ts` (one admission-to-handle path), about 10 of catches in the repo, and about 13 in EGW. About 8 test lines change to read `.settled` (`local.test.ts:110` asserts the refusal as a `Rejected` state; `testing.test.tsx:216` reads `applied.state`).
- **Risk:** low. The local handle path is already covered (`tests/actor/local.test.ts:294-310`).
- **Public API change:** yes (the return type of `derive` and `modify`). **Wire/stored format change:** no.

### P2-A2. Export the value actor's reference type

- **Files:** `actor.ts:160-177` (the three spellings in `modify`) and `client.ts:10`. Callers:
  - `apps/notes/src/commands.ts:21` (`DraftRef`, 1 use at `:29`)
  - the 7 test sites in Q1
  - EGW `app.tsx:74` (`Local<A>`)
- **Problem:** one concept, the reference to a local `Behavior.value` actor, has three owners: the library's inline spelling, notes' `DraftRef`, and EGW's `Local<A>`. Every prop that passes view state spells `LocalActorRef<X, SetValue<X>>` and repeats `X`.
- **North star:** expressive, without losing explicit: the name keeps the placement.
- **Change:** `export type LocalValueRef<A, Refusal = never> = LocalActorRef<A, SetValue<A>, Refusal>` beside `modify`. `modify` is typed with it. Add it to the `_Code_` of **Actor reference** in `CONTEXT.md`. Notes deletes `DraftRef`; EGW deletes `Local`.
- **Lines removed:** about 4, and each of about 9 annotations gets shorter.
- **Risk:** none. **Public API change:** yes (additive). **Wire/stored format change:** no.

### P2-A3. A scripted form submit shows the same issues as a plain post

- **Files:**
  - `packages/effect-frame/src/view/form.ts:56-70` (`FormBinding.issues`), `:155-163` (issues from `FormContext`), `:272-283` (the submit that logs a decode failure).
  - `packages/effect-frame/src/actor/form.ts:588-592` (`issuesOf`).
  - Readers of `.issues`: `apps/notes/src/page.tsx:98`, `examples/counter/routes.tsx:74`, `examples/features/forms.tsx:51`, `tests/plain-form-fixture.tsx:240,287`.
- **Problem:** a per-mode branch, and a failure swallowed where a state belongs.
  - The same undecodable input shows its issues when posted without a script (`http/form-post.ts:354`).
  - With a script, it shows nothing and only logs (`view/form.ts:281`). `tests/view/plain-form.test.tsx:404` records "does not decode and sends nothing".
  - Nothing a view can bind carries the refusal.
- **North star:** explicit (no swallowed failure). Declarative (one form binding, the same issues in every rendering mode). Actor-model (the issues are view state held by a local value actor and written by a message).
- **Change:**
  - `FormBinding.issues` becomes `Source<ReadonlyArray<Form.FormIssue>>`, held by `Actor.local(Behavior.value(initial))` in the binding's scope and seeded from `FormContext`.
  - A scripted decode failure sends `Value.Set(Form.issuesOf(error))`, and a successful submit sends `Value.Set([])`.
  - The five readers draw the issues with `For` (a `.map` over a static array today).
  - Foldkit-style per-field validation before submit (pass 1 7b) can later be a `Source` over the same decode and `issuesOf`, with no second validator.
- **Lines removed:** 2 (the log). About 10 are added.
- **Risk:** low to medium. Hydration must draw the same issues the server drew; `IssuesJson` is unchanged, so the seed path is the same. `view/form.ts` is in the view sweep's scope, so coordinate with it.
- **Public API change:** yes (`issues` becomes a `Source`). **Wire/stored format change:** no. `IssuesJson` (`form.ts:526-537`) and the field names do not change.

### P2-A4. Framework plumbing leaves the public namespaces

- **Files:** `packages/effect-frame/src/actor/client.ts:55,77,81-82`, where `export * as` publishes whole modules. The importers through the public entry:
  - `src/view/form.ts:8` (`Form`, `Generated`, `Wire`)
  - `src/view/hosts/html.ts:2` and `src/view/hosts/dom.ts:1` (`Streaming`, `Form`)
  - `src/router/branch.ts` (`canonicalize`, `keyOf`)
- **Problem:** there are two import conventions for one package. `view/form.ts:14` and 7 other imports reach actor modules by relative path, yet the plumbing named below is imported through the public entry, so every helper is public. Deletion test, counting files outside `src/actor` (tests and other):
  - **No user and no test** (28 values):
    - `Form.FormMalformed`, `Tree`, `flatten`, `Fields`, `Structure`, `IssuesJson`
    - `Generated.annotation`, `generationOf`, `memberNamed`, `drawFresh`
    - `Streaming.ValueOutcome`, `ErrorOutcome`
    - 16 of the 23 `Wire` members: `WireAddress`, `WireQueryKey`, `QueryBody`, `QueryBatchBody`, `WireQueryValue`, `WireQueryError`, `WireQueryBatch`, `SendBody`, `WireReceipt`, `WireError`, `SendWireError`, `CallWireError`, `statusOf`, `queryStatusOf`, `eventPrefix`, `errorEvent`. The other 7 (`paths`, `AddressBody`, `CallBody`, `ReadWireError`, `WireApplied`, `WireProjection`, `WireRefreshed`) have test users.
  - **Used only by `src/view` or `src/router`:**
    - `Form.frameworkFields`, `decode`, `withValues`, `without`
    - `Generated.membersOf`, `mint`, `mintAll`
    - `Streaming.shell`, `declared`, `awaitDeclared`, `actorSeeds`, `settledPatches`
    - `canonicalize`
  - Tests reach `Wire` for raw requests (`rg "Wire\." tests`: `paths` 6, `WireProjection` 2, and 1 each for `AddressBody`, `CallBody`, `ReadWireError`, `WireApplied`, `WireRefreshed`). 26 test files already import `../../src/...` directly.
- **North star:** explicit (a public name is one an app uses and a test takes as its subject). Deletion test.
- **Change:**
  - `src/view` and `src/router` import plumbing by relative path.
  - Each public namespace re-exports a curated module:
    - Form: the codec types, `Checkbox`, `FormContext`, `FormIssue`, the issue encoding the router needs, `encodeKey`, `last`, `fromEntries`
    - Generated: `fromCommandId`, `freshId`, `send`, `Input`
    - Streaming: what the tests and hosts need
  - Tests reach the rest by relative path, as 26 already do.
  - `Wire` leaves `effect-frame/actor/client` if `bun run boundary` and `bun run declarations` stay green; otherwise it keeps `paths` only.
- **Lines removed:** about 0 lines of code. About 41 public value names go (28 unused, 13 framework-only).
- **Risk:** medium. `tsconfig.build.json` notes that declarations emit through self-imports. `bun run declarations` refuses a value reachable by two paths (G5), so each move has to keep one path. Delegate the mechanical rewrite with these rules.
- **Public API change:** yes. **Wire/stored format change:** no. The wire schemas stay as they are; only their export changes.

### P2-A5. One form decoder: `Form.decode` is built on `Form.codec`

- **Files:** `packages/effect-frame/src/actor/form.ts:386-397` (`Structure`), `:406-407` (`codec`), `:423-430` (`decode`).
  - `rg "Form\.codec"`: `tests/actor/form-codec.test.ts`, `tests/actor/form-types.test.ts` (tests=2, other=0).
  - `rg "Form\.decode\("`: `src/view/form.ts:233`, plus `http/form-post.ts` through the flat import.
- **Problem:** one concept, fields to message, has two owners. `codec` is `Structure` → schema (fields to tree through `tree`/`flatten`). `decode` is `tree(strip(…))` → `decodeUnknownEffect(schema)`. The public, typed one runs only in tests; the untyped one runs in production.
- **North star:** explicit (one decode), effect-native (a Schema codec, not a hand-written pipeline).
- **Change:** `decode(schema)` is `strip` followed by `Schema.decodeUnknownEffect(codecOf(schema))`, where `codecOf` is the unconstrained core. `codec` stays as the `Codable`-typed public spelling over `codecOf`. `FormMalformed` stays the error of a body that cannot nest.
- **Lines removed:** about 4.
- **Risk:** low. The error channel must still separate `FormMalformed` from `SchemaError` (`form-post.ts` answers each differently).
- **Public API change:** no. **Wire/stored format change:** no.

### P2-A6. A12, gated: the query cache's state in one owner per transition

See Q2. Files: `query-client.ts:414-700` (slot), `:925-1010` (document), `:1135-1180` (cache), `:1503-1608` (`followQuery`).

- **North star:** actor-model, effect-native.
- **Change:** step 0 (the model test), then step 1 (one `SlotState` in a `SynchronizedRef`, pure transitions; `current` in a `SynchronizedRef`).
- **Lines removed:** about 0 net.
- **Risk:** high. Step 0 is what brings the risk down.
- **Public API change:** no. **Wire/stored format change:** no.

---

## Owner questions

- **O1: Foldkit `Stale`.** A failed refresh drops the held value today (Q3). Three choices:
  - (i) `Failed { error, last: Option<A> }`. The failure is still one state, `View.errored` still trips, and an `Await` `failed` branch can draw `last`.
  - (ii) Keep `Ready(value, stale: true)` and expose the refresh error beside it on `FollowedQuery`. The content stays, but CONTEXT's "never two of these at once" bends.
  - (iii) Keep today's behaviour.

  (i) keeps the glossary and readiness as they are. (ii) is closer to Foldkit. There is no wire change either way. North star: expressive against declarative, hence the owner question.

## Not worth a pass (under about 5 lines each)

- `local-engine.ts:49` names `Actor.spawn`, which no longer exists. Say `Actor.local`.
- Comments that tell history:
  - `query-client.ts:686` and `:750` ("review round 2"), `:967` ("review round 1"), and `:704` ("as it always has")
  - `http/wire.ts:40` ("the old behavior exactly")
- The stale-Ready rule is rebuilt inline instead of calling `markStale` (`query.ts:264`): `query-client.ts:403-412` (`display`), `:1466-1471` (`carry`), and `source.ts:286-288` (`load`).
- `Frame.QueryValue` (`frame.ts:61`) is exported with 0 users. `Frame.layer`'s `name?` (`frame.ts:504-509`) is optional with an empty default; under the E13 rule it would be `name: Option<string>`. It is only a label.
- `ActorHost.make` is public with 14 test callers and 0 app callers (`rg "ActorHost\.make"`).
- `tooling/dom-bench/src/fixtures/effect-frame.tsx:45-50` writes `call` plus a catch where `send` needs neither.
- EGW, independent of P2-A1: the three `whileMounted(x.send(…))` wraps (`app.tsx:277, 341, 726`) are dead code today.

## Receipts checked with no finding

- `rg "Promise|\.then\(|runFork|runPromise|runSync|addEventListener|setTimeout" src/actor src/frame.ts`: none.
- Module-level maps: see Q4.
- `testing/`: `mailboxStoreConformance` (3 callers), `HttpTest.client` (6 files).
- `HttpServer.*` and `HttpTransport.*`: every member has app callers.
- `Behavior.*`: only `value`, `reducer` and `machine` (A4 held).
