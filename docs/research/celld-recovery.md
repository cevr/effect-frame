# celld and Alchemy recovery research

Date: 2026-09-18. Research for [Verify celld and Alchemy recovery capabilities](https://github.com/cevr/effect-frame/issues/3).

## Recommendation

Use **celld 0.5.0 directly for the local recovery proof**. Its source has the required storage, transaction, and alarm parts. This review does not prove the framework recovery contract. The framework still needs a durable command and work adapter. No JavaScript fiber persistence is promised.

Do not treat Alchemy celld support as released. [PR 1127](https://github.com/alchemy-run/alchemy/pull/1127) is open. Its current source still selects celld 0.1.0. Update and test that integration before making it a release dependency. Current celld guarantees do not prove the behavior of that older runtime.

## Exact versions

| Source                    | Version or commit                                                   | Result                                                                                                    |
| ------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| celld main and tag v0.5.0 | `12d5b6333fe52717325addcfe1e99e9fd4f77bcd`                          | Current local source. The release was published on 2026-09-15. The project still calls the runtime alpha. |
| Alchemy main              | `473c39591c7993a708199d0ef8f0d38416885dde`, package `2.0.0-beta.79` | No celld provider in this source.                                                                         |
| Alchemy PR 1127           | `b415ee69ffe63ce314baea89cf726078572c8475`                          | Open. GitHub reports an update at 2026-09-18T06:34:50Z.                                                   |
| PR runtime defaults       | celld `0.1.0`                                                       | Image: `ghcr.io/denoland/celld@sha256:2ba7fdeb91041a7e090027cf9d922b7b628e1fa0bb83818dcde059004ab809c8`.  |

Sources: [celld manifest](https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/Cargo.toml#L1-L5), [release](https://github.com/denoland/celld/releases/tag/v0.5.0), [alpha status](https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/docs/limitations.md#L1-L5), [Alchemy manifest](https://github.com/alchemy-run/alchemy/blob/473c39591c7993a708199d0ef8f0d38416885dde/packages/alchemy/package.json), [PR defaults](https://github.com/alchemy-run/alchemy/blob/b415ee69ffe63ce314baea89cf726078572c8475/packages/alchemy/src/Celld/CelldCli.ts#L40-L49). GitHub API checks supplied the PR status and release time.

## What the current source provides

### Storage and acknowledgements

Each cell owns SQLite storage. JavaScript memory does not survive a cold restart or eviction. The constructor runs again. An in-memory mailbox, Promise, Effect fiber, or actor scope is not a durable command queue.

The production runtime holds output behind a durability proof and an ownership check. A one-node fleet uses the bucket proof. A multi-node fleet can use follower disk proofs before bucket upload. The guarantees require a supported object store and a supervisor that restarts failed nodes. A disk commit alone is not the complete production durability contract.

Sources: [memory contract](https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/docs/README.md#L23-L37), [storage requirements](https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/docs/guarantees.md#L17-L35), [supervisor requirement](https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/docs/guarantees.md#L101-L114), [output proof](https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/docs/guarantees.md#L147-L199).

### Transactions and event order

Single-threaded does not mean one complete async event at a time. A second event can run while the first event waits. Runtime call order ends at event admission, not event completion.

The async storage transaction awaits its callback. It commits on success and rolls back on failure. It closes the input gate and orders concurrent transactions from one event. SQL, command rows, state, receipts, and work rows can use one cell transaction. This does not supply a transaction across cells or external services.

An alarm write uses the same SQLite connection. Inside an explicit transaction, its wake publication gate runs at transaction commit. Thus an async transaction can store a command and await the transaction handle's `setAlarm` before commit. This is the source-supported route for atomic admission plus wake. The proof must test it. Do not pass an async callback to `transactionSync`. Do not launch an unawaited alarm write through the root storage handle inside that callback.

`storage.sync()` proves prior committed writes. It is not a commit operation for an open transaction. Transactions and `blockConcurrencyWhile` have a 30-second limit. Do not hold them around long external work.

Sources: [event interleaving](https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/runtime.rs#L3906-L3911), [async commit](https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/js/harness.js#L1790-L1827), [transaction gate](https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/js/harness.js#L1856-L1938), [alarm transaction commit](https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/storage.rs#L4468-L4488), [alarm handle](https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/js/harness.js#L1681-L1697), [sync and limits](https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/docs/cloudflare-compat.md#L60-L67).

### Work recovery and external effects

Alarms persist their deadline and retry state. Failed handlers get bounded retries: six counted failures, with backoff. An alarm is a wake trigger, not a stored fiber. An application must define retry exhaustion and repair. A constructor scan alone cannot wake a dormant cell.

celld also has Cloudflare-shaped Workflows. Completed `step.do` calls return stored results on resume. This does not make an arbitrary Effect program resumable. Workflow limits include 1 MiB step results and event payloads, at most 30 days of terminal retention, and a 60-second limit for pending work outside steps. Do not use workflow result retention as the only permanent command receipt store.

A remote side effect can succeed before its local result is stored. After a crash, the caller cannot infer whether that side effect ran. celld does not retry a remote fetch after it transmits the request body. Its RPC retry only covers calls known not to have started. Store a stable external operation ID. Use provider idempotency or query the provider result. Otherwise report an uncertain result and require repair. Do not promise exactly-once effects for arbitrary external APIs.

Sources: [durable alarms](https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/docs/guarantees.md#L321-L339), [retry policy](https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/logic/alarm.rs#L3-L32), [workflow example](https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/examples/workflow/index.js#L1-L11), [workflow limits](https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/docs/cloudflare-compat.md#L282-L292), [remote retry rules](https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/docs/cloudflare-compat.md#L339-L363).

## Required framework adapter — proposed, not shipped

1. Store each command ID, payload hash, admission sequence, and status. Reject reuse of an ID with a different payload.
2. Commit command admission and its alarm in one transaction. Send an accepted response only after the durable output boundary.
3. Process admitted commands in the actor's defined order. Do not infer mailbox order from DO event interleaving.
4. Commit the new actor revision, state, command result, and new work records together. Persist terminal errors as results too.
5. Publish committed revisions to selectors and clients only after that commit. Keep speculative client state separate.
6. Run external work outside the transaction. Store work type, schema version, arguments, phase, attempt, deadline, and operation ID. Persist completion as a new event or result.
7. On restart, load committed state and unfinished work. Rebuild fresh Effect scopes and fibers. Use alarms to resume work without a client request.
8. Fence stale work completions with an attempt or revision token. Reuse one external idempotency key across retries of the same operation.
9. Return the stored receipt for a repeated command. Define receipt retention before deleting deduplication records.

Browser SSR/hydration and OpenTUI need the same committed revision and receipt contract. A renderer reconnect must not create another command identity. These client adapters remain separate work. They do not change the server's recovery guarantee.

## Exact local proof path

### Existing runnable entry point

celld 0.5.0 has `celld dev`. It starts one node with a local object store. It needs no Docker daemon, cloud bucket, account, or paid resource. It stores data below the application at `.celld/dev`. That data stays after normal shutdown. Use the same application path and binding names on restart. Never use `--clean` between crash-test phases.

The existing smoke app is `/Users/cvr/.cache/repo/denoland/celld/examples/counter`. Its `index.js` increments a stored count. Its `wrangler.jsonc` defines the `COUNTER` binding. Copy these two files into an isolated proof directory before running. Do not run dev against the shared source cache because it writes `.celld/dev` there. The counter is a state smoke test, not a durable-inbox test.

After local tools exist, the command shape is:

```sh
PATH="/absolute/proof-tools/bin:/absolute/proof-tools/node_modules/.bin:$PATH" celld dev --no-watch --logs --port 19876 /absolute/isolated/counter
curl --fail 'http://127.0.0.1:19876/?name=restart-proof'
```

Choose a free port first. The command above is a setup recipe, not an executed test. The paths are placeholders. The isolated fixture has not been created.

The `dev` command is a parent process. It starts a celld node child. A nonzero child exit makes the parent fail; it does not automatically restart the child. The proof runner must identify and kill the actual node child, wait for both processes to exit, and start the same command again. Validate PID ownership before sending a signal. Killing only the launcher does not establish that the node died on every platform.

Sources: [dev setup and data path](https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/docs/README.md#L300-L399), [parent exit behavior](https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/dev.rs#L531-L599), [node launch](https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/dev.rs#L602-L656), [counter](https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/examples/counter/index.js), [binding](https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/examples/counter/wrangler.jsonc).

### Tools and local checks

This host is Darwin arm64, macOS 15.7.7. Bun 1.4.2, Node, curl, Rust 1.95.0, and Cargo 1.95.0 are present. `celld` and `esbuild` are not on PATH. Docker exists, but its Colima socket is absent. Docker is not needed for this local path.

The release has a [Darwin arm64 binary](https://github.com/denoland/celld/releases/download/v0.5.0/celld-aarch64-apple-darwin.gz). Download and extract it into a proof-local tools directory in the implementation task. Record the archive digest. Install a fixed esbuild version into that directory, not globally. The npm version check returned `0.28.2`. This is a proposed test pin, not a tested compatibility result. The celld manifest requires Rust 1.94.1 for a source build; the release binary avoids that build. Binary startup and system-library compatibility remain untested.

### Required crash matrix

Create a separate framework proof fixture. It needs command submission, receipt lookup, committed-state lookup, and a controlled external-effect service. Give it barriers at transaction and external-call boundaries. Do not add those barriers to a production API.

| Kill point or test                              | Required result after restart                                                            |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Before durable command admission                | No accepted-command promise. A retry can admit the command.                              |
| After accepted response, before processing      | The command remains. An alarm starts it without another application request.             |
| During state and receipt transaction            | State, result, and work intents are all old or all new. No partial commit.               |
| After result commit, before HTTP response       | A retry returns the same receipt. It does not repeat the transition.                     |
| During a timer or async machine step            | The saved work phase resumes in a new fiber. The old fiber does not survive.             |
| After external success, before local checkpoint | The operation ID prevents a duplicate, or recovery reports an uncertain result.          |
| Concurrent duplicate commands across awaits     | One admission and one transition. Both callers get one stored result.                    |
| Persisted failure result                        | A retry returns the stored failure under the declared retry policy.                      |
| Alarm failure and retry exhaustion              | No command disappears. The adapter records terminal failure or an explicit repair state. |
| Old worker completion after a retry             | The stale attempt cannot overwrite the current committed revision.                       |

Use **SIGKILL on the node** for process-loss cases. Add a separate SIGTERM case for graceful shutdown. celld drains and hands off on SIGTERM; that is not a crash proof. During handoff it cancels firing alarms and records retries. Hot reload and hibernation are also different cases. Deployment can cancel old work and close sockets. Test schema and command compatibility across versions separately.

A local one-node proof covers process loss with the local disk retained. It does not prove machine loss, S3 consistency, follower failover, network partitions, or the Alchemy ECS deployment.

Sources: [graceful shutdown](https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/docs/README.md#L614-L645), [deployment transitions](https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/docs/README.md#L270-L293).

## Alchemy deployment path — current PR only

The current PR exports `Celld.DurableObject`, `Celld.DurableObjectState`, `Celld.Fleet`, `Celld.Worker`, and `Celld.EcsFleet`. This supersedes the older review at PR head `8313964abf1da05f067685234448d394bd559280`, which used `Celld.Ecs` and a shared Cloudflare declaration.

The source-shaped deployment is a `Celld.Fleet` resource plus a `Celld.Worker` bound through its `fleet` property. Its provider composition is:

```ts
Layer.mergeAll(AWS.providers(), Celld.providers(), Celld.EcsFleet());
```

The ECS host composes S3, a VPC, IAM, discovery, and an ECS service. A public worker can add ingress. These resources cost money. Do not use this deployment for the no-cloud proof. The host selects `props.image ?? DEFAULT_CELLD_IMAGE`; the deployment CLI defaults separately to 0.1.0. Upgrade and test both sides together. Do not infer current-runtime support from an image override alone.

Sources: [current exports](https://github.com/alchemy-run/alchemy/blob/b415ee69ffe63ce314baea89cf726078572c8475/packages/alchemy/src/Celld/index.ts#L1-L70), [host image and resources](https://github.com/alchemy-run/alchemy/blob/b415ee69ffe63ce314baea89cf726078572c8475/packages/alchemy/src/Celld/EcsFleet.ts#L45-L139), [provider example](https://github.com/alchemy-run/alchemy/blob/b415ee69ffe63ce314baea89cf726078572c8475/packages/alchemy/src/Celld/EcsFleet.ts#L297-L319), [CLI default](https://github.com/alchemy-run/alchemy/blob/b415ee69ffe63ce314baea89cf726078572c8475/packages/alchemy/src/Celld/CelldCli.ts#L118).

## Evidence and checks not run

Executed as source and environment checks: source reads, Git commit and tag checks, GitHub PR and release queries, tool-path and version checks, Docker daemon check, and npm package-version lookup.

### Executed against the running runtime

The `@effect-frame/host-celld` package now runs these checks. The receipt for every row below is `packages/host-celld/scripts/crash-harness.ts`. Run it with `bun run proof:celld` in `packages/host-celld`. It is not in the default gate: it needs the binary and takes about 30 seconds.

| Check                           | Result                                                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Binary download and startup     | celld 0.5.0 Darwin arm64 starts. `celld dev --no-watch --logs --port PORT <dir>` prints `ready  http://127.0.0.1:PORT`. |
| Isolated state directory        | State lives at `<projectDir>/.celld/dev`. The harness copies the fixture into `.proof/celld` and never uses `--clean`.  |
| SIGKILL and restart             | The launcher spawns one node child. SIGKILL on the child ends the launcher; it does not restart. The harness restarts.  |
| SQL storage                     | `ctx.storage.sql.exec(query, ...params)` with `.toArray()` serves the mailbox schema.                                   |
| Transaction commit and rollback | `ctx.storage.transaction(async txn => ...)` commits on resolve and rolls back on reject.                                |
| Transaction-scoped `setAlarm`   | `await txn.setAlarm(ms)` inside the async transaction publishes the wake at commit, with the command row.               |
| `alarm()` delivery              | The armed wake calls the object's `alarm()` after a restart, with no client request.                                    |
| `no_bundle` worker              | `bun build --target browser --format esm` output loads under `"no_bundle": true`. esbuild is not needed.                |
| `new_sqlite_classes`            | The migration needs `new_sqlite_classes`. `new_classes` is rejected.                                                    |

### Crash matrix rows now proved

| Row | Kill point or test                               | Result                                                                                                                   |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| a   | After accepted response, before processing       | The send returns 202 with the command still pending. SIGKILL, restart: the armed alarm drains it with no client request. |
| b   | After result commit, before HTTP response        | A retry with the same ID and payload returns the stored receipt at the same revision. The state does not change again.   |
| c   | Concurrent duplicate commands, different payload | The same ID with a different payload returns `CommandConflict` and leaves the committed state alone.                     |
| d   | Order of several admitted commands               | Three quick sends each apply once. The committed revision reaches 3 and the mailbox drains.                              |

All ten assertions across these four rows passed. The store also passes the shared `MailboxStore` conformance suite over an in-memory SQLite fake, in `packages/host-celld/tests/storage-store.test.ts`.

### Generic host proof

Rows a to d use a hand-written counter Durable Object. They prove the store, not the framework wire. The generic host proof replaces that fixture with the shipped one.

`packages/host-celld/src/frame-host.ts` exports `defineFrameHost`. It builds a Durable Object class from a list of `AnyImplementation` values. One object holds one actor instance, because the worker routes one address to one object. The class serves the generic actor wire and nothing else: `POST /send`, `POST /call`, `POST /snapshot`, and `GET /changes`. The client is the shipped `HttpTransport` and `ref`. No proof code knows the host is a Durable Object.

The fixture is `packages/host-celld/fixture-contract/`. Its worker routes `/actors/:contract/:version/:key/<verb>` to the object named `contract@version/key` and rewrites the inner URL to the bare verb. It hosts two contracts. `Counter` is a reducer. `Upload` is a `Behavior.machine` whose `Uploading` state carries a `.task` that sleeps for a duration the state holds, so a kill during the sleep is a kill during machine work.

The receipt for every row below is `packages/host-celld/scripts/contract-proof.ts`. Run it with `bun run proof:contract` in `packages/host-celld`. It is not in the default gate, like `proof:celld`. Both proofs share process control in `packages/host-celld/scripts/celld-process.ts`.

| Row | Kill point or test                         | Result                                                                                                                                                 |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| e   | Committed state and receipt across SIGKILL | A call commits at revision 1. SIGKILL, restart: the snapshot restores it, the retried ID returns the stored receipt, a new command reaches revision 2. |
| f   | Same ID, different payload, over the wire  | The generic wire returns `CommandConflict` with status 409. The committed state does not change.                                                       |
| g   | Kill during machine work                   | `Start` commits `Uploading`. SIGKILL 500 ms into a 4000 ms task. After a wake, the task runs again and commits `Done` one revision on.                 |
| h   | `changes` event stream from the celld host | A subscriber receives the new revision as a server-sent event.                                                                                         |

All twelve assertions across these four rows passed. The exact output:

```
celld binary: /Users/cvr/Developer/personal/effect-frame/.tools/celld/bin/celld
proof dir:    <rift>/.proof/celld-contract

rows:
  PASS  e. a call over the generic wire commits and returns revision 1
  PASS  e. after SIGKILL and restart the committed state is restored
  PASS  e. the retried command ID returns the stored receipt and does not reapply
  PASS  e. a new command after the restart reaches revision 2 and state 8
  PASS  f. the same ID with a different payload is a typed CommandConflict
  PASS  f. the rejected command left the committed state alone
  PASS  g. the Start command commits Uploading
  PASS  g. the wake snapshot shows the machine still in Uploading, work unfinished
  PASS  g. machine work resumed after the restart and committed Done one revision on
  PASS  g. Done arrived one full task run after the wake, so the work re-ran
  PASS  g. the snapshot after the resume is Done, so the mailbox drained
  PASS  h. the changes event stream delivers the new revision over the wire

| row | check                                                            | result |
| --- | ---------------------------------------------------------------- | ------ |
| e   | a call over the generic wire commits and returns revision 1      | PASS   |
| e   | after SIGKILL and restart the committed state is restored        | PASS   |
| e   | the retried command ID returns the stored receipt and does not r | PASS   |
| e   | a new command after the restart reaches revision 2 and state 8   | PASS   |
| f   | the same ID with a different payload is a typed CommandConflict  | PASS   |
| f   | the rejected command left the committed state alone              | PASS   |
| g   | the Start command commits Uploading                              | PASS   |
| g   | the wake snapshot shows the machine still in Uploading, work unf | PASS   |
| g   | machine work resumed after the restart and committed Done one re | PASS   |
| g   | Done arrived one full task run after the wake, so the work re-ra | PASS   |
| g   | the snapshot after the resume is Done, so the mailbox drained    | PASS   |
| h   | the changes event stream delivers the new revision over the wire | PASS   |

all 12 checks passed
```

Row g is the destination proof. It measures the wall time, not only the end state. `Done` arrives at least one full task run after the wake. The task therefore ran again from the start. It did not resume a saved fiber, and it was not skipped.

#### The wake obligation

Machine work resumes on the next wake, not on its own. A wake is one of two things: the alarm an admission transaction armed, or any request the object receives. Row g uses the second: after the restart the proof sends one `snapshot` request, which is exactly the first request a reconnecting client sends. The object then opens the instance, restores `Uploading`, and re-enters the task.

An idle-time heartbeat alarm is not implemented. An object whose machine sits mid-task, with no pending command and no client, stays dormant until something calls it. `alarm()` in `defineFrameHost` covers the armed case: the first request writes the address into a `hosted_address` row in the same storage, and the alarm reads that row back and opens the instance with no client request. Nothing arms a wake for mid-task machine work alone. State a heartbeat alarm as required work before this host serves unattended machine work.

#### A machine spends one revision before any command

`Behavior.machine` emits the state it hydrated on its `changes` stream when it opens. The durable actor commits that as an autonomous advance. A fresh machine therefore commits its initial state as revision 1, and the first command lands at revision 2. This is `packages/actor/src/durable.ts` behavior and predates this proof. Row g asserts the relations between revisions, not fixed numbers, so it measures recovery and not that starting cost. Decide whether that first advance should be suppressed before a machine contract ships.

### Still not executed

Row g now covers a kill during an async machine step. The remaining matrix rows need a controlled external-effect service or a second process: kill during the state and receipt transaction, kill after external success and before a local checkpoint, a persisted failure result, alarm retry exhaustion, and a stale worker completion after a retry. An idle-time heartbeat alarm for mid-task machine work is not implemented, so a dormant object with no pending command and no client does not resume on its own. SIGTERM graceful shutdown, hot reload, and hibernation are separate cases. Workflow recovery, SSR and hydration, OpenTUI, cloud deployment, and paid resource allocation remain unrun.

A local one-node proof covers process loss with the local disk retained. It does not prove machine loss, S3 consistency, follower failover, network partitions, or the Alchemy ECS deployment. No shared source cache was changed.

### Full local source paths

These paths supplied the conclusions above. PR source copies use the current head. The pinned GitHub links preserve the references if temporary files expire.

- `/Users/cvr/.cache/repo/denoland/celld/crates/celld/Cargo.toml:1`
- `/Users/cvr/.cache/repo/denoland/celld/docs/limitations.md:1`
- `/Users/cvr/.cache/repo/denoland/celld/docs/README.md:9` (also 23, 51, 270, 300, 614)
- `/Users/cvr/.cache/repo/denoland/celld/docs/guarantees.md:17` (also 101, 147, 321)
- `/Users/cvr/.cache/repo/denoland/celld/docs/cloudflare-compat.md:60` (also 282, 339)
- `/Users/cvr/.cache/repo/denoland/celld/crates/celld/runtime.rs:3906`
- `/Users/cvr/.cache/repo/denoland/celld/crates/celld/storage.rs:3492` (also 4468)
- `/Users/cvr/.cache/repo/denoland/celld/crates/celld/js/harness.js:1542` (also 1661, 1681, 1723, 1744, 1790, 1856, 9637)
- `/Users/cvr/.cache/repo/denoland/celld/crates/logic/alarm.rs:3`
- `/Users/cvr/.cache/repo/denoland/celld/crates/celld/dev.rs:531` (also 602)
- `/Users/cvr/.cache/repo/denoland/celld/examples/counter/index.js:1`
- `/Users/cvr/.cache/repo/denoland/celld/examples/counter/wrangler.jsonc:1`
- `/Users/cvr/.cache/repo/denoland/celld/examples/workflow/index.js:1`
- `/Users/cvr/.cache/repo/alchemy-run/alchemy/packages/alchemy/package.json:2`
- `/tmp/alchemy-pr-1127-b415ee69ffe63ce314baea89cf726078572c8475/packages/alchemy/src/Celld/CelldCli.ts:41` (also 48, 118)
- `/tmp/alchemy-pr-1127-b415ee69ffe63ce314baea89cf726078572c8475/packages/alchemy/src/Celld/EcsFleet.ts:45` (also 70, 297)
- `/tmp/alchemy-pr-1127-b415ee69ffe63ce314baea89cf726078572c8475/packages/alchemy/src/Celld/index.ts:1`

Research process: `/Users/cvr/Developer/personal/dotfiles/skills/research/SKILL.md`. The earlier `/tmp/alchemy-celld-ui-review.md` supplied search leads only; its Alchemy API and head are stale.
