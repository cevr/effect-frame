# Owned runtime seams

Research for [Identify reusable seams in Effect Machine and Encore](https://github.com/cevr/effect-frame/issues/4).
Checked on 2026-09-18. This report does not select the public Frame API.

## Result

Reuse Machine for local behavior, event order, state observation, and scoped work.
Reuse Encore and Effect Workflow for durable command and workflow protocols.
Neither package currently supplies the complete Frame contract on celld.
In particular, Machine's save hook runs after state publication.
Encore's transaction tools do not by themselves delay state publication until commit.

Keep one authority for each actor's state and command order.
Build host and view adapters around that authority.
Do not place a second writable state store in the view.
Do not add an independent Frame workflow engine.
These are recommendations. The evidence and limits follow.

## Source versions

| Source                                   | Version and revision                               | Evidence                                                                                |
| ---------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Machine warm source                      | 0.25.4; `33beb71591c4e36da3b86bd07e907a3d69ddab69` | `/Users/cvr/Developer/personal/effect-machine/package.json:3`; `git rev-parse HEAD`     |
| Current Machine source                   | 0.27.0; `70ab7698254ecfec36af13e70ebda2b07710bee4` | `/Users/cvr/.cache/repo/cevr/effect-machine/package.json:3`; cache `git rev-parse HEAD` |
| Encore source                            | 0.31.0; `5d2813abae1ee849a0015b1d3bd064fe86ddd14a` | `/Users/cvr/Developer/personal/effect-encore/package.json:3`; `git rev-parse HEAD`      |
| Installed Effect used for runtime checks | 4.0.0-rc.112                                       | `/Users/cvr/Developer/personal/effect-encore/node_modules/effect/package.json:4`        |

`npm view <package> version dist-tags peerDependencies gitHead --json --prefer-online`
confirmed Machine 0.27.0 and Encore 0.31.0 as `latest`.
Both peer ranges are `>=4.0.0-rc.112 <5`.
The Machine source cache matches its published `gitHead`.
The warm sources stayed unchanged.

The earlier notes used Machine 0.25.4.
I checked their findings against 0.27.0.
The later release adds `ActorHost` and lifecycle repairs.
It retains the publication and persistence order described below.
Sources: `/tmp/effect-machine-ui-review.md`; `/tmp/effect-ui-source-notes.md`;
`/Users/cvr/.cache/repo/cevr/effect-machine/CHANGELOG.md:1`;
`/Users/cvr/.cache/repo/cevr/effect-machine/src/internal/runtime.ts:927`.

## Reuse and ownership

| Requirement                          | Existing support                                                                                                     | Remaining responsibility                                                                                                                                      |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Simple state and machine behavior    | Machine schema, transition, mailbox, and lifecycle runtime. Encore `State` can read and write another owner's store. | Frame can lower simple behavior to the same actor contract. A separate simple-state runtime is not required. The lowering and public syntax remain undecided. |
| Local and remote references          | Machine local `ActorRef`; Machine cluster `EntityActorRef`; Encore operation handles.                                | Frame needs a shared application contract and explicit local or remote capabilities. Existing refs are not interchangeable.                                   |
| Browser and OpenTUI views            | Machine snapshots, subscriptions, and Atom selectors.                                                                | Frame owns renderer bindings and connection lifetime. Renderer bindings must not own domain state.                                                            |
| SSR and hydration                    | Machine accepts hydrated state.                                                                                      | Frame owns request scope, snapshot encoding, revision checks, connection handoff, and prevention of duplicate startup work.                                   |
| Accepted commands and stored results | Encore persisted sends, execution IDs, storage lookup, and Effect Cluster reply storage.                             | The celld adapter must prove durable acceptance, duplicate handling, restart recovery, and terminal result retention.                                         |
| Resumable work                       | Encore delegates named steps, clocks, signals, and resume to Effect Workflow.                                        | A celld host must supply durable Workflow services. Machine tasks need a durable work bridge.                                                                 |

This table is a recommendation from the source findings below.
It does not prescribe constructor names, command syntax, or renderer APIs.

## Machine facts

### Order and lifecycle

The local runtime has one event queue.
It takes one event and waits for event processing before it takes the next.
Effectful guards and transition handlers can therefore block the actor.
Tasks and spawned work send completion events back to that queue.
Sources:

- `/Users/cvr/.cache/repo/cevr/effect-machine/src/internal/runtime.ts:913`
- `/Users/cvr/.cache/repo/cevr/effect-machine/src/internal/runtime.ts:1088`
- `/Users/cvr/.cache/repo/cevr/effect-machine/src/machine.ts:983`

State exit closes the old state scope.
New entry work uses the new scope.
Actor ownership requires `ActorScope` or `Machine.scoped`.
The Atom adapter removes its subscription when the Atom closes.
It does not stop the actor.
Sources:

- `/Users/cvr/.cache/repo/cevr/effect-machine/src/internal/transition.ts:484`
- `/Users/cvr/.cache/repo/cevr/effect-machine/src/actor.ts:398-405`
- `/Users/cvr/.cache/repo/cevr/effect-machine/src/atom.ts:39`

`ActorHost` now supplies lazy, shared child startup.
Its host scope owns the child.
Consumer cancellation does not own that lifetime.
This is reusable for screen or session actors.
It is not a durable host or remote registry.
Source: `/Users/cvr/.cache/repo/cevr/effect-machine/src/actor-host.ts:18-42,94-188`.

### State publication precedes persistence

The current event path is:

1. Run the transition and close the previous state scope when needed.
2. Set the state `SubscriptionRef` and latest transition.
3. Start new state entry work.
4. Notify synchronous state listeners.
5. Call the durability save hook.
6. Settle call, ask, or send-wait replies.
7. Publish transition observations.

Sources:

- `/Users/cvr/.cache/repo/cevr/effect-machine/src/internal/transition.ts:460-500`
- `/Users/cvr/.cache/repo/cevr/effect-machine/src/internal/runtime.ts:927-1002`
- `/Users/cvr/.cache/repo/cevr/effect-machine/src/actor.ts:966-980`

The save hook receives actor ID, generation, previous state, next state, and event.
It receives no command ID or typed reply value.
It only runs for selected transitions.
A command with no state change can still need a stored result.
Therefore this hook cannot provide the required complete atomic command contract.
Source: `/Users/cvr/.cache/repo/cevr/effect-machine/src/machine.ts:170-191`.

The cluster adapter shares Machine's runtime kernel.
External requests and internal events reach that kernel.
However, the journal append occurs in the external Send and Ask request paths.
It occurs after the runtime processes the event.
An internal task completion does not directly enter those journal append sites.
Snapshot mode saves from a background state stream and a shutdown finalizer.
Those snapshot effects ignore persistence errors.
Sources:

- `/Users/cvr/.cache/repo/cevr/effect-machine/src/cluster/entity-machine.ts:197-253`
- `/Users/cvr/.cache/repo/cevr/effect-machine/src/cluster/entity-machine.ts:268-330`

Inference: These adapters support recovery, but they do not prove atomic state,
command result, and work scheduling before publication.
A celld adapter must not inherit that guarantee from the word “journal.”
The kernel must commit internally generated events through the same durable path.

### Tasks do not resume fibers

`.task` runs an Effect and sends a success or failure event.
It does not store an activity identity or result.
Interruption does not emit a normal failure event.
The runtime can restart entry work after recovery.
That is a fresh execution, not continuation of a saved fiber.
Source: `/Users/cvr/.cache/repo/cevr/effect-machine/src/machine.ts:965-1044`.

Recommendation: Keep transient tasks unchanged.
For durable work, record the work identity and intent with the actor commit.
Run that work through the existing Workflow engine.
Return a durable completion command through the actor's command path.
Use persisted data and step results for recovery.
Do not serialize fibers or depend on finalizers for process-crash recovery.

## Encore facts

### Accepted commands and duplicate handling

Operation IDs can separate entity routing from a command primary key.
A string ID uses the same value for both.
Repeated commands to one entity therefore need distinct command keys.
Retries must reuse the original key.
Sources:

- `/Users/cvr/Developer/personal/effect-encore/src/internal/invocation-compiler.ts:94-103`
- `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:134-138`

Persistence is opt-in through the `Persisted` annotation.
The storage-only sender rejects a non-persisted operation.
For a persisted operation, it waits for `saveRequest`.
It treats both a new request and a duplicate as accepted by that storage adapter.
`Client.send` returns the execution ID after this step.
This is an acceptance receipt, not proof of completed behavior.
Sources:

- `/Users/cvr/Developer/personal/effect-encore/src/internal/invocation-compiler.ts:281-288`
- `/Users/cvr/Developer/personal/effect-encore/src/actor-mailbox.ts:95-125`
- `/Users/cvr/Developer/personal/effect-encore/src/client.ts:211-216`

`peek` looks up the stored request and terminal reply.
It returns `Pending` when either the request or terminal reply is absent.
Thus `Pending` alone does not prove acceptance.
Operation `watch` polls this status. It is not a state subscription.
Sources:

- `/Users/cvr/Developer/personal/effect-encore/src/receipt.ts:227-255`
- `/Users/cvr/Developer/personal/effect-encore/src/internal/execution-observation.ts:23-31`

Inference: Frame needs an explicit acceptance record or an acceptance response
with a stable command identity. It also needs a policy for the same command ID
with different input. Current identity-based deduplication does not establish
that input conflict policy. External effects still require idempotency.

### Transactions: useful support, incomplete publication contract

`Client.withTransaction` delegates to `MessageStorage.withTransaction`.
The SQL storage delegates to `SqlClient.withTransaction`.
The existing SQL test proves rollback of host SQL writes.
It does not test state plus terminal command result plus publication.
Sources:

- `/Users/cvr/Developer/personal/effect-encore/src/client.ts:183-184,251`
- `/Users/cvr/Developer/personal/effect-encore/node_modules/effect/src/unstable/cluster/SqlMessageStorage.ts:748-751`
- `/Users/cvr/Developer/personal/effect-encore/test/sql-storage.test.ts:93-111`

Effect already has `ClusterSchema.WithTransaction`.
The entity manager passes the storage transaction as the RPC `onRequest` hook.
The RPC server wraps the handler and its reply callback with that hook.
Encore exposes a protocol transform through `withProtocol`.
Thus the first experiment should use this existing transaction path.
Do not build another transaction engine before testing it.
Sources:

- `/Users/cvr/Developer/personal/effect-encore/node_modules/effect/src/unstable/cluster/ClusterSchema.ts:30-55`
- `/Users/cvr/Developer/personal/effect-encore/node_modules/effect/src/unstable/cluster/internal/entityManager.ts:526-541`
- `/Users/cvr/Developer/personal/effect-encore/node_modules/effect/src/unstable/rpc/RpcServer.ts:284-320`
- `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:1665-1682`

The annotation defaults to false.
Encore's operation compiler sets `Persisted`, but not `WithTransaction`.
The source path establishes a transaction composition point.
It is not an end-to-end proof for Frame.
Tests must check shared storage context, failure replies, deferred replies,
rollback, and when acknowledgement leaves the process.
The storage wrapper notifies reply handlers after its save returns.
An enclosing transaction may still be open at that time.
Source: `/Users/cvr/Developer/personal/effect-encore/node_modules/effect/src/unstable/cluster/MessageStorage.ts:556-571`.

Encore `State` stores read and write capabilities, not a second authoritative value.
It uses a semaphore for each State object.
It publishes after its write Effect succeeds.
That write can finish before an enclosing transaction commits.
A semaphore also does not coordinate two processes or separate State objects.
Sources:

- `/Users/cvr/Developer/personal/effect-encore/src/state.ts:112-151`
- `/Users/cvr/Developer/personal/effect-encore/src/state.ts:162-178`
- `/Users/cvr/Developer/personal/effect-encore/src/state.ts:270-288`

Recommendation: Add commit-aware publication at the owner of durable state.
Use `State.makeReadable` to observe that owner.
Use the existing transaction capability where its host contract is sufficient.
Add a reusable Encore capability only for a demonstrated missing contract.

### Order, live state, and work

Encore forwards handler concurrency to Effect Entity.
The installed entity manager defaults to concurrency 1.
A caller can override it.
Consequently, the actor name alone does not guarantee sequential behavior.
Sources:

- `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:1257-1263`
- `/Users/cvr/Developer/personal/effect-encore/node_modules/effect/src/unstable/cluster/internal/entityManager.ts:208-215`

The state registry is a process-local map of read and watch handles.
Registration captures services and attaches cleanup to the entity scope.
It is useful for local observation.
It is not a remote state service or durable snapshot store.
Source: `/Users/cvr/Developer/personal/effect-encore/src/actor-state.ts:70-154`.

Encore steps delegate to Effect Activity, DurableClock, and DurableDeferred.
Workflow resume delegates to the upstream Workflow value.
This supplies reusable logical work primitives.
It still needs a durable engine and host storage.
Sources:

- `/Users/cvr/Developer/personal/effect-encore/src/step.ts:355-455`
- `/Users/cvr/Developer/personal/effect-encore/src/internal/workflow-actor.ts:492`
- `/Users/cvr/Developer/personal/effect-encore/docs/adr/0003-thin-wrappers-over-effect-rc.md:9-35`

## Browser, terminal, and hydration limits

Machine separates its core, Atom, and cluster exports.
Its core and Atom sources do not import a DOM, OpenTUI, Node, or Bun host.
The Atom adapter reads the actor and sends actor events.
This makes it a suitable source-level view boundary.
No browser bundle test ran for this report.
Sources:

- `/Users/cvr/.cache/repo/cevr/effect-machine/package.json:12-31`
- `/Users/cvr/.cache/repo/cevr/effect-machine/src/index.ts:1-70`
- `/Users/cvr/.cache/repo/cevr/effect-machine/src/atom.ts:7-20,39-45,110-142`

The local ref exposes synchronous subscriptions, lifecycle, and host callbacks.
The remote entity ref exposes Effect requests and a watch stream.
Its `send` returns state after processing.
These are different contracts.
A unified Frame ref must describe observation and commands without implying
that a remote request has local synchronous behavior.
Sources:

- `/Users/cvr/.cache/repo/cevr/effect-machine/src/actor.ts:139-208`
- `/Users/cvr/.cache/repo/cevr/effect-machine/src/cluster/entity-actor-ref.ts:36-59`

Encore exposes only the package root.
That root exports actor runtime, Workflow, Client, and SQL storage modules.
Those modules import Effect Cluster and SQL capabilities.
Keep them on the server side of the proposed Frame contract.
There is no inspected celld adapter in either library's `src` tree.
This is an import-boundary finding, not a claim that every import crashes a browser.
Sources:

- `/Users/cvr/Developer/personal/effect-encore/package.json:12-19`
- `/Users/cvr/Developer/personal/effect-encore/src/index.ts:1-91`
- `/Users/cvr/Developer/personal/effect-encore/src/client.ts:43-76`
- `/Users/cvr/Developer/personal/effect-encore/src/storage.ts:15-26`
- `/Users/cvr/Developer/personal/effect-encore/src/step.ts:2-8`

Recommendation: Keep schema contracts, serialized references, snapshots,
revisions, commands, and results in a browser-safe entry point.
Keep authorization, database handles, host services, and behavior effects in server modules.
Treat this as a package boundary. Do not depend only on tree shaking.

Machine hydration replaces recovery when supplied.
It supplies state, not an SSR request protocol or a remote revision handoff.
Frame must test request isolation and snapshot-to-stream races.
It must define which side owns startup work during hydration.
Source: `/Users/cvr/.cache/repo/cevr/effect-machine/src/actor.ts:1134-1157`.

## Direct callers checked

Machine's shared counter uses one actor and Atom selectors.
Its service example puts asynchronous work in `.task`.
The Solid example uses `@effect/atom-solid` and Solid 1-style effects.
These are useful caller examples. They do not prove Solid 2, SSR, or OpenTUI support.
Sources:

- `/Users/cvr/.cache/repo/cevr/effect-machine/examples/shared/src/counter.ts:21-62`
- `/Users/cvr/.cache/repo/cevr/effect-machine/examples/core/src/services-and-tasks.ts:22-50`
- `/Users/cvr/.cache/repo/cevr/effect-machine/examples/solid/src/app.tsx:1-43`

Gent separates command identity from entity identity.
It marks durable operations explicitly.
Its actor registers a read-only state view over the behavior owner.
It sets unbounded handler concurrency to keep control operations responsive.
The behavior queue and semaphore own serialization.
This is evidence against adding another actor merely to obtain a mailbox.
Sources at Gent commit `00fd7927abde30b9272e6b0bc577a3b7ac632611`:

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.protocol.ts:18-28,130-160`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:1-26,688-692,923-931`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:419-432`
- `/Users/cvr/Developer/personal/gent/package.json:60-61`

Loom explicitly runs its agent entity with concurrency 1.
It uses an application ledger to record accepted evaluation and stored outcomes.
Its workflow preparation places acceptance, signal declarations, and dispatch
inside `Client.withTransaction`. It starts result observation afterward.
The workflow host supplies `ClusterWorkflowEngine`.
These are caller patterns, not proof of a celld host.
Sources at Loom commit `1bea365fdf486d621dc3d8a2730b056790f4918a`:

- `/Users/cvr/Developer/personal/loom/packages/runtime/src/internal/agent-actor.ts:80-123,144-150`
- `/Users/cvr/Developer/personal/loom/packages/runtime/src/internal/workflow-run-preparation.ts:29-49`
- `/Users/cvr/Developer/personal/loom/packages/runtime/src/internal/loom-dynamic-workflow.ts:6-16`
- `/Users/cvr/Developer/personal/loom/packages/platform-bun/src/internal/loom-dynamic-workflow.ts:22-48`

## Required upstream changes and Frame adapters

The following items are recommendations, not implemented features.

| Owner                           | Required work                                                                                                                                                                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Machine                         | Add a supported commit boundary before state publication and entry work. Include command identity, terminal result, and internally generated events. Separate transition planning from visible lifecycle changes where durable execution needs it. Do not expose the internal kernel by deep import.   |
| Machine plus Encore integration | Record durable work intent with the state commit. Reuse Workflow execution and stable step IDs. Deduplicate completion commands and reject obsolete completions after state exit. Keep transient `.task` behavior distinct.                                                                            |
| Encore                          | Test existing `WithTransaction` and `withProtocol` composition first. Improve reusable transaction and receipt support only where these fail the required contract. Provide browser-safe contract exports if Frame needs Encore's types and schemas directly. Keep the live registry explicitly local. |
| Effect or storage adapter       | Guarantee commit before result notification where the existing path does not. Reuse Effect's transaction and Workflow services. Fix a generic primitive upstream if the gap belongs there.                                                                                                             |
| Frame celld adapter             | Own cell activation, one command order, durable acceptance, transaction binding, recovery, work wakeup, schema versioning, and remote publication. Prove the real celld host behavior. Do not treat an in-memory Effect Cluster layer as durable.                                                      |
| Frame view and network adapters | Own DOM and OpenTUI bindings, remote transport, authorization at the server edge, selector projection, request scope, hydration, disconnect, reconnect, and revision recovery. Do not copy domain state into a second writable authority.                                                              |

Required durable sequence: persist acceptance before acknowledging acceptance.
Then execute through the actor's single order.
Atomically commit state, terminal command result, and durable work intent.
Publish committed state and completion only after that transaction commits.
On restart, recover accepted unfinished commands and unfinished logical work.
The real host must prove this sequence. The current source does not prove it.

## Validation and test gaps

Focused existing tests passed with Bun 1.4.2:

- Machine warm source 0.25.4: 27 tests passed; 0 failed; 60 assertions.
  Command: `bun test --tsconfig-override=tsconfig.json test/persist.test.ts test/atom.test.ts test/integration/cluster-persistence.test.ts`.
  Files: `/Users/cvr/Developer/personal/effect-machine/test/persist.test.ts`;
  `/Users/cvr/Developer/personal/effect-machine/test/atom.test.ts`;
  `/Users/cvr/Developer/personal/effect-machine/test/integration/cluster-persistence.test.ts`.
- Encore 0.31.0: 28 tests passed; 0 failed; 49 assertions.
  Command: `bun test --tsconfig-override=tsconfig.json test/state.test.ts test/mailbox.test.ts test/sql-storage.test.ts test/integration/cluster.test.ts test/workflow-compensation-cluster.test.ts`.
  Files: `/Users/cvr/Developer/personal/effect-encore/test/state.test.ts`;
  `/Users/cvr/Developer/personal/effect-encore/test/mailbox.test.ts`;
  `/Users/cvr/Developer/personal/effect-encore/test/sql-storage.test.ts`;
  `/Users/cvr/Developer/personal/effect-encore/test/integration/cluster.test.ts`;
  `/Users/cvr/Developer/personal/effect-encore/test/workflow-compensation-cluster.test.ts`.

Bun printed an internal directory-mismatch warning in both runs.
Both processes exited 0.
Failure-injection tests also printed expected journal and compensation errors.
The current Machine cache has no installed dependencies.
I did not install packages or claim a 0.27.0 test run.
I did not run full library gates. This task changes one research document.
The empty Frame source has no build, lint, or test gate.

Before the first release, test these boundaries:

1. Block and fail a state commit. No subscriber, entry task, or completion response may observe the new revision early.
2. Crash after acceptance, during state commit, and after commit before reply delivery. A retry must return the stored result without applying the command twice.
3. Reuse a command ID with different input. Return the defined conflict outcome.
4. Test no-op, rejected, failed, deferred-reply, postponed, and internal completion commands. Each must have the defined durable result.
5. Roll back a transaction around state mutation and reply storage. Check observer silence and typed failure retention.
6. Stop the celld process during a named step, signal wait, or durable timer. Restart it and verify recovery from stored work, including duplicate completion and stale completion cases.
7. Connect two remote clients. Test concurrent commands, disconnect, missed revisions, reconnect, and snapshot-to-stream handoff.
8. Render two SSR requests concurrently. Verify state isolation, matching hydration, and no duplicate startup effect.
9. Bundle the shared contract and view adapters for the browser. Reject Cluster server, SQL, Bun, Node, and celld host imports from that graph.
10. Run the same behavior through DOM and OpenTUI bindings. Verify selector updates and actor cleanup.

Existing tests establish local behavior and selected storage behavior.
They do not establish these crash, publication, browser, or celld guarantees.

## Review guidance used

The research skill required primary-source checks and this single report.
Effect guidance required one state owner, explicit resource ownership, and reuse
of the pinned upstream runtime before a new wrapper.
No source changes, deployment, push, or issue mutation occurred.

- `/Users/cvr/Developer/personal/dotfiles/skills/research/SKILL.md`
- `/Users/cvr/Developer/personal/dotfiles/skills/code-review/SKILL.md`
- `/Users/cvr/Developer/personal/dotfiles/skills/code-style/SKILL.md`
- `/Users/cvr/Developer/personal/dotfiles/skills/architecture/SKILL.md`
- `/Users/cvr/Developer/personal/dotfiles/skills/architecture/references/boundaries.md`
- `/Users/cvr/Developer/personal/dotfiles/skills/effect/SKILL.md`
- `/Users/cvr/Developer/personal/dotfiles/skills/effect/references/PROGRAM_DESIGN.md`
- `/Users/cvr/Developer/personal/dotfiles/skills/effect/references/SERVICES_LAYERS.md`
- `/Users/cvr/Developer/personal/dotfiles/skills/effect/references/STREAMS.md`
- `/Users/cvr/Developer/personal/dotfiles/skills/effect/references/STYLEGUIDE.md`
- `/Users/cvr/Developer/personal/dotfiles/skills/effect/references/TESTING.md`
- `/Users/cvr/Developer/personal/dotfiles/principles/never-block-on-the-human.md`
- `/Users/cvr/Developer/personal/dotfiles/principles/redesign-from-first-principles.md`
- `/Users/cvr/Developer/personal/effect-machine/AGENTS.md`
- `/Users/cvr/.cache/repo/cevr/effect-machine/AGENTS.md`
- `/Users/cvr/Developer/personal/effect-encore/AGENTS.md`
