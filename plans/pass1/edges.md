# Architecture pass 1: edges (http, testing, inspection, inspect, host-durable-object)

Tree: `/home/exedev/Developer/personal/effect-frame` (branch hydrate-order, treated as main). Read only; nothing in the repo was edited.
Read first: CONTEXT.md, docs/design/acceptance.md (rows 26-67, 152-178), north-stars.md, rejected.md, prior-art.md, ledger.md (Pass 1 table empty: nothing done or rejected yet), pass1-agent-trial.md (friction 7 = E1 here).
Prior art: Foldkit `packages/foldkit/src/http/http.ts` (at 95fed7f) and `devTools/{webSocketBridge,store}.ts`.

Caller-count grep, used for every count below (dist, node_modules and *.md excluded):
`rg -n -g '!**/dist/**' -g '!**/node_modules/**' -g '!*.md' "<pattern>" packages apps tooling | awk -F: '{print $1}' | sort | uniq -c`

## Answers to the five questions

1. **HTTP surface.** No allow-all is hidden: `principal` is required (`server.ts:55`, `form-post.ts:48`), `HttpServer.anonymous` is the named opt-out (`server.ts:63`), and `login` is a required `Option` (`form-post.ts:57`). The hidden defaults are `commitWithin` (10 s, `form-post.ts:67,71`), an unbounded request body on every production route (E3), and `Fetch` falling back to `globalThis.fetch` (`client.ts:40-42`, E9). `HttpServer.form` does **not** check `Form.Codable`. It takes `contracts: ReadonlyArray<AnyContract>` (`form-post.ts:42`) and decodes with `Schema.decodeUnknownEffect(contract.raw.message)` (`form-post.ts:359`), not with `Form.codec` (`actor/form.ts:406`). See E1.
2. **Testing helpers.** They form a parallel API. `QueryTest.layer` → `QueryCache.layerTest` → `ActorTransport.layerLocal` → `Layer.effect` is three stacked pass-throughs, and together they build what production writes as `Layer.merge(QueryCache.layer, ActorHost.layer(...))`. They also flip which of `queries` and `implementations` is optional. See E4.
3. **host-durable-object.** `defineFrameHost` does reuse the shared seam (`ActorHost.layer` + `HttpServer.make`, `frame-host.ts:177,195`). But the package also ships a second, non-generic host with its own wire as public API (E5). The host needs one client transport per address, which is a per-host branch leaking into client config (E6). A body address that differs from the object is never refused (E6). The host also reads the store's tables past the store module (E7).
4. **inspection + packages/inspect.** Placement shows as data (`kind: "local"|"durable"` on actors, `"durable"|"remote"` on commands, `frame.ts:61,122`), and never as a branch. Duplicated concepts: the protocol constants have several owners (E10), the CLI has two argv parsers (E11), and the internal record types are copied field by field into the snapshot (E12, next door to scope). The attach status is a callback (E8).
5. **Magic and inconsistency.** The option conventions disagree with each other (E13). `HttpServer` routes by path suffix while every app strips a prefix it did not need to (E2). `sessionBuffer` is a public constant whose only test is a tautology (E14).

## Candidates

### E1: `HttpServer.form` accepts a contract whose message has no form encoding
- **Files:** `packages/effect-frame/src/actor/http/form-post.ts:40-42, 355-366`. `packages/effect-frame/src/actor/form.ts:378-407` has `Codable` and `codec`.
- **Problem:** This is a guard gap, plus one concept (fields → message) with two owners. A contract with `amount: Schema.Finite` compiles into `HttpServer.form` and then refuses every post at run time (trial friction 7). `Form.codec` already refuses such a schema at compile time. The route instead rebuilds the same decode by hand (`tree(strip(fields))` + `decodeUnknownEffect(raw.message)`).
- **Callers:** `rg "HttpServer.form\("` gives apps/blog/src/server.ts, apps/notes/src/server.ts, and 4 tests (plain-retry, auth-fixture, plain-form, plain-commit). `rg "Form.codec|codec\("` gives only tests/actor/form-types.test.ts and form-codec.test.ts, so production never uses the codec. App contracts are already codable. In blog (`apps/blog/src/contract.ts:24`), `hearts: Finite` is in the snapshot, not the message. In notes (`apps/notes/src/contract.ts:13`), `done: Boolean` is also in the snapshot, and `NotesMessage` (`:27-35`) is strings only.
- **North star:** Expressive (a mistake the types can catch no longer reaches run time), and explicit.
- **Change:** Make `form` generic in `Cs extends ReadonlyArray<AnyContract>` and type the field as `contracts: { [I in keyof Cs]: Cs[I] & Form.Codable<Cs[I]["raw"]["message"]> }`. Decode through `Form.codec(contract.raw.message)`. Apply the same fix to `View.form` (`view/form.ts:35` checks only `Covered`); that is in the view sweep's scope.
- **Lines removed:** about 3 net here. The value is a compile error in place of a runtime refusal.
- **Risk:** Low to medium: inferring over a mapped tuple needs a `form-types` type test. **Public API:** yes (types only). **Wire/stored:** no.

### E2: Every app hand-writes the same actor-route glue; the server routes by suffix
- **Files:**
  - `server.ts:199-332`: `make` routes with `path.endsWith(paths.send)` and the like (256, 270, 290, 301, 307, 324).
  - `server.ts:340-351`: `toWebHandler`.
  - `form-post.ts:396-450`: its own POST check and its own principal derivation.
- **Problem:** A pass-through in the apps, and one concept (who is asking, per mount) with two owners.
  - blog (`apps/blog/src/server.ts:130-160`) and notes (`apps/notes/src/server.ts:163-188`) build two handlers and pass `principal: HttpServer.anonymous` to each. Both then route `/actors/form` first and strip `/actors` by hand before calling `actors`. dashboard (`apps/dashboard/src/server.ts:196-211`) strips the prefix the same way.
  - The strip is not needed: `make` matches any path that ends in a verb, so `/anything/send` is served. That is a hidden rule, and the doc says "Mount it under one prefix" (`server.ts:35`).
  - `toWebHandler` has test callers only. `rg "toWebHandler"` gives http.test.ts, http-impairment.test.ts, revocation.test.ts and 0 apps. Every app calls `runtime.runPromise(HttpServer.make(...))` itself.
- **North star:** Declarative (the framework owns routing), and explicit (the mount prefix is written once and matched exactly).
- **Change:** Build one handler: `HttpServer.make({ prefix: "/actors", principal, form: Option<{ contracts, login, render, commitWithin }> })`. It derives the principal once and matches `prefix + paths.*` exactly, so `form.ts` becomes internal. Then either delete `toWebHandler` or make it the one boundary the apps use; pick one.
- **Lines removed:** about 12 per app for blog and notes, about 6 for dashboard, and about 15 in `form-post.ts` (the duplicate POST check and derivation). About 45 in total.
- **Risk:** Medium. The plain-form and http acceptance rows (167-178) use real servers, so their tests must move with the change. **Public API:** yes. **Wire/stored:** no. The paths stay the same; only suffix matching becomes exact matching.

### E3: A production request body has no size limit; the dev gateway has one
- **Files:**
  - `server.ts:69` (`request.text()`, no limit).
  - `form-post.ts:152` (`request.text()`, no limit).
  - `host-durable-object/src/frame-host.ts:220-223` (`request.clone().json()`, no limit).
  - Compare `packages/inspect/src/gateway.ts:241-270` and `limits.ts:12` (`MAX_REQUEST_BYTES`, enforced while the body streams in).
- **Problem:** A guard gap and a hidden default ("unbounded"). The loopback dev tool guards its body and the internet-facing actor server does not. No option names a limit.
- **Callers:** `rg "request.text\(\)|\.json\(\)" packages/*/src` gives the three production sites above.
- **North star:** Explicit (a limit that matters is written at the call site). Effect-native (read the body as a `Stream` with a byte cap instead of a Promise).
- **Change:** Add a required `maxBodyBytes` (or a required `Option`, per E13) to the `HttpServer` options and to `FrameHostOptions`. Use one bounded reader, `Stream.fromReadableStream` plus a cap, that answers 413. The gateway keeps its own reader, because `inspect` must not depend on server code.
- **Lines removed:** 0; about 25 are added.
- **Risk:** Low. **Public API:** yes. **Wire/stored:** no. 413 is a new status, but the client already maps a 4xx it cannot decode to a defect, as `BadRequest` does today (`server.ts:95`). The owner should confirm that a new refusal status is not a wire change.

### E4: The test layers are a parallel API made of three stacked pass-throughs
- **Files:**
  - `actor/testing/query.ts:9-29`: `QueryTest.layer({ queries, implementations? })`.
  - `actor/query-client.ts:1311-1314`: `QueryCache.layerTest(host)` is `Layer.merge(layer, ActorTransport.layerLocal(host))`.
  - `actor/transport.ts:102-104`: `layerLocal` is `Layer.effect(ActorTransport, host)`.
  - Production: `actor/host.ts:275-291` has `ActorHost.layer({ implementations, queries? })` and `ActorHost.layerMemory(implementations, queries?)`.
- **Problem:** A pass-through chain and a second spelling of the production layer.
  - The test helper makes `implementations` optional and `queries` required. Production does the opposite.
  - The test helper drops `Recovery`, which production provides.
  - Production itself has two spellings: `layer` takes an object and `layerMemory` takes positional arguments, and the memory store is the hidden default of `layer` (`host.ts:120`).
  - An agent learns the same wiring three ways.
- **Callers:**
  - `rg "QueryTest"`: 25 test files and the inspect fixture; 0 apps.
  - `rg "QueryCache.layerTest"`: query.ts, tests/actor/admission-refresh.test.ts, and the built `fixture-conformance/worker.js`.
  - `rg "layerLocal"`: query-client.ts, command-cache.test.ts, command-event.test.tsx.
  - `rg "ActorHost.layerMemory"`: 3 apps and 13 tests.
  - `rg "ActorHost.layer\("`: revocation.test.ts and frame-host.ts.
- **North star:** Explicit (one name per concept, and the store written out), plus the deletion test: the three wrappers only rename `Layer.merge` and `Layer.effect`.
- **Change:**
  - Delete `ActorTransport.layerLocal` and `QueryCache.layerTest`.
  - Make `QueryTest.layer(options: HostOptions<R>)` exactly `Layer.merge(QueryCache.layer, ActorHost.layer(options))`, or delete it and have tests write that line.
  - Keep one host constructor, `ActorHost.layer({ implementations, queries, store })`, with `store` required and `MailboxStore.layerMemory` written out, and delete `layerMemory`. The `host.ts` half belongs to the actor sweep; coordinate with it.
- **Lines removed:** about 20 in src. It touches about 45 test and app files mechanically.
- **Risk:** Low. It is mechanical; delegate it with the rules. **Public API:** yes. **Wire/stored:** no.

### E5: A proof fixture ships as the host package's public API
- **Files:** `host-durable-object/src/frame-actor.ts` (1-268) and `src/durable-object.ts` (1-112). They are exported from `src/index.ts:11-23` as `Add, CounterState, counter, handle, host, readBody, toCommand, Command, HostedActor, Reply, FrameActor`.
- **Problem:** This is a second host with its own wire (`/send /call /state /pending`, `frame-actor.ts:244-268`). It has magic defaults: amount `1` (229), timeout `5000` (238), and command id `"anonymous"` (241). It sets its own `pollInterval` of 20 ms (`durable-object.ts:16-19`). Its own fixture says "This is a proof fixture, not a library entry point" (`fixture/index.ts:6-10`).
- **Callers:**
  - `rg "FrameActor\b"`: only `fixture/index.ts` and `fixture/wrangler.jsonc` outside the module.
  - `rg "toCommand"`, restricted to this package: only `durable-object.ts`.
  - `CounterState` hits in effect-frame tests are unrelated local names.
- **North star:** Actor-model (one host seam), explicit (no magic defaults in a library), and the deletion test.
- **Change:** Move both files under `fixture/` and drop the 13 names from `index.ts`. That also removes a lint override (`.oxlintrc.json:156`).
- **Lines removed:** 380 from `src` (moved) and 13 from the index.
- **Risk:** Low. The crash-harness scripts import the fixture build and not the index. **Public API:** yes, but the package is private (`package.json` `"private": true`). **Wire/stored:** no.

### E6: The Durable Object host needs a transport per address and trusts the body address
- **Files:**
  - `host-durable-object/src/route.ts:31, 42-62` (object chosen from the path `/actors/:contract/:version/:key/:verb`; verb set hard-coded).
  - `frame-host.ts:83-105, 218-229` (address read from the body or query and written with no check).
  - `frame-host.ts:177-180` (the store ignores the address).
  - `scripts/contract-proof.ts:72-78` (one `HttpTransport.layer` per address).
- **Problem:** Four issues:
  - **Per-host branch leaking into the client.** A Bun host takes one `baseUrl: "/actors"` for every actor. A DO host needs one transport per (contract, version, key), with the address written twice: once in the path and once in the body.
  - **Guard gap.** A request whose body names address B, sent to the object for A, is served by A. `ActorHost` then opens B over A's storage, because `store: () => StorageStore.layer(context.storage)` ignores the address. Two actors then share one mailbox, and `hosted_address` is overwritten, so the alarm wakes the wrong actor. No test covers it: the frame-host tests are named at `tests/frame-host.test.ts:165-298`, and none sends a mismatched body.
  - **One concept with two owners.** The `verbs` set duplicates `Wire.paths` and omits `query`, `query/batch` and `form`.
  - `defineFrameHost` takes no `queries`, while `ActorHost.layer` does.
- **North star:** Actor-model (placement must not show in consumer code, and a message applies to its own actor only) and declarative.
- **Change:**
  - (a) Cheap, with no format change: after the first request, `frame-host` refuses a request whose address differs from the recorded `hosted_address`. Add a red test first.
  - (b) Structural: `route` derives the object from the same `Envelope`/query address that `frame-host` already decodes. Clients then use the ordinary single `baseUrl` and the verb set comes from `Wire.paths`.
- **Lines removed:** (a) about 0, with about 8 added. (b) about 25: the path parser in `route.ts` and the per-address transport helper.
- **Risk:** (a) low. (b) medium: acceptance row 53 ("routes one actor address to one Durable Object") and its test move with it. **Public API:** (b) yes. **Wire/stored:** (b) changes the DO router's URL layout. That is an **owner question**, rejected by default, although the package is private. (a) changes no format.

### E7: `frame-host` reads the mailbox store's tables past the store module
- **Files:** `frame-host.ts:238-250` (`due`: `SELECT 1 FROM commands WHERE revision IS NULL`, `SELECT wake_at FROM committed`) and `frame-host.ts:272-276` (`committedRevision`). They duplicate `storage-store.ts:160` (`alarmAfterCommit` runs the same pending query) and `storage-store.ts:113` (the committed read).
- **Problem:** One concept (the store layout) has two owners. A schema change in `storage-store.ts:22-49` must be copied by hand into `frame-host`. The `MailboxStore` service already exposes `pending` and `latest` with `wake` (`actor/mailbox-store.ts:28, 78-79`).
- **North star:** Effect-native (read through the service, not raw SQL) and locality.
- **Change:** Have `wakeAndDrain` read `pending` and `latest` from the `MailboxStore` built for the address, or export `due` and `committedRevision` from `storage-store.ts`. Either way, `frame-host` stops naming store tables. `hosted_address` stays in `frame-host`, since it is the host's own row.
- **Lines removed:** about 20.
- **Risk:** Low. **Public API:** no. **Wire/stored:** no (reads only).

### E8: The attach status is a callback, and the retry loop is written by hand
- **Files:** `inspection/attach.ts:40` (`onStatus?: (status) => void`), `:174-180` (the throw-swallowing `notify`), `:41-46, 84-113` (three optional millisecond numbers with defaults), `:234-250` (`while (true)` with manual doubling and reset).
- **Problem:** A callback stands where a `Stream` or `SubscriptionRef` belongs, and a hand-written backoff stands where a `Schedule` belongs. The defaults 250, 5000 and 2000 are hidden in code (the doc comments do state them). Foldkit exposes its devtools state as `SubscriptionRef` (`devTools/webSocketBridge.ts:12, 404ff`).
- **Callers:** `rg "onStatus"`: attach.ts, tests/inspection/attach.test.ts (3), and `packages/inspect/tests/fixture/main.dev.tsx:19`. `rg "initialRetryMillis"`: the same test and the fixture.
- **North star:** Effect-native.
- **Change:** `attachGateway` returns `{ status: Stream<AttachStatus> }` (a `SubscriptionRef` changes stream) and takes `retry: Schedule.Schedule<unknown>` and `openTimeout: Duration.Input`. That matches `HttpTransport.layer({ reconnect })` (`client.ts:51`), including its exported `defaultReconnect`.
- **Lines removed:** about 30 (the `millis` and `timing` validation and the manual loop).
- **Risk:** Low. It is a dev-only entry. **Public API:** yes. **Wire/stored:** no (the protocol is untouched).

### E9: The HTTP client's I/O seam is a Promise `FetchLike` with an ambient default
- **Files:** `actor/http/client.ts:37-42` (`FetchLike` returns a `Promise`; the `Fetch` reference defaults to `globalThis.fetch`), `:112-121` (`tryPromise` and `.then` chains), `:188-206`.
- **Problem:** A Promise stands where an Effect belongs, and an ambient global is the hidden default. Prior art: Foldkit's `http/http.ts` wraps `effect/unstable/http` `FetchHttpClient.layer`. `effect/unstable/http` ships in the installed `effect`, but `rg "effect/unstable/http"` finds 0 uses.
- **Callers:** `rg "HttpTransport\.Fetch|FetchLike"`: apps/notes/tests/fixture.ts and 5 effect-frame test files, all injecting a handler.
- **North star:** Effect-native.
- **Change:** `HttpTransport.layer` requires `HttpClient.HttpClient`. Apps provide `FetchHttpClient.layer`, and tests provide a client over the web handler. SSE reads through `HttpClientResponse.stream`.
- **Lines removed:** about 20.
- **Risk:** Medium to high. Abort and retry semantics and the streaming body must keep the rows at acceptance 26 and 143-144 green. **Public API:** yes. **Wire/stored:** no.

### E10: The inspection protocol constants have several owners
- **Files:**
  - Deadline bound: `inspection/protocol.ts:99` (`DeadlineMillis` 1..30000), `packages/inspect/src/limits.ts:9` (`MAX_DEADLINE_MILLIS = 30_000`, kept equal by the `tests/reader.test.ts:101` test), and `gateway.ts:299` (hard-coded text `"deadlineMillis: 1..30000"`).
  - Loopback hosts: `attach.ts:62` and `reader.ts:112`.
- **Problem:** One concept with two or three owners, held in step by a test instead of by construction.
- **North star:** Explicit.
- **Change:** `Protocol` exports `maxDeadlineMillis` and `loopbackHosts`, and `DeadlineMillis` is built from `maxDeadlineMillis`. `inspect` imports both and deletes its copies. The gateway builds its text from the constant.
- **Lines removed:** about 5. This is at the "not worth a pass" line; bundle it with E11.
- **Risk:** Low. **Public API:** additive. **Wire/stored:** no, because the values stay the same.

### E11: `inspect` hand-rolls two argv parsers and two error envelopes
- **Files:** `packages/inspect/src/reader.ts:110-137` (`readFlags`), `cli.ts:92-110` (`readGatewayFlags`, near-identical), `reader.ts:407-415` (`failure`) and `cli.ts:282-292` (`misuse`). Both build the `Error` document with `JSON.stringify` instead of encoding `Document` (`reader.ts:55`). Also `CliEnvironment.readFile` returns a `Promise` (`reader.ts:29`), and `Io.interrupt` is an `AbortSignal` (`cli.ts:33`, adapted back at `signals.ts:29`).
- **Problem:** Duplicate code and a hand-written decoder where Effect has the tool: `effect/unstable/cli` ships in the installed `effect`.
- **North star:** Effect-native.
- **Change:** First, merge the two flag readers and encode through `Document` once. Then evaluate `effect/unstable/cli`. The CLI's contract (exit code 2, a `--json` error document on misuse) must survive, so that is an owner check before adopting it. Pass the interrupt as `Effect<InterruptSignal>` built in `bin.ts`.
- **Lines removed:** about 35 (merge only).
- **Risk:** Low for the merge; medium for the CLI library. **Public API:** no (private bin). **Wire/stored:** no.

### E12 (next door to scope, `packages/effect-frame/src/{inspection,frame}.ts`): the internal records copy the snapshot schema
- **Files:** `src/inspection.ts:23-28` (`QueryValue`) and `:78-86` (`CommandLifecycle`), mapped field by field back into identical shapes by `src/frame.ts:417-440` (`toQueryValue`, `toCommandLifecycle`). The rest of `toSnapshot` (`frame.ts:443-523`) does real work (`toDiagnostic`, `identity` branding) and stays.
- **Problem:** One concept with two owners: a hand-written interface and a `Schema` for the same value.
- **North star:** Effect-native (the Schema is the source of the type).
- **Change:** The internal `QueryValue` and `CommandLifecycle` become `Schema.Type` of the snapshot members, and the Uncertain `admitted` becomes an `Option` with `OptionFromNullOr` in the schema, which keeps the same encoded JSON. Delete both mappers.
- **Lines removed:** about 30.
- **Risk:** Low. **Public API:** yes (the `Frame.Snapshot` Type changes from `null` to `Option` in that field). **Wire/stored:** no in the encoded form, but the inspection protocol version counts, so the owner should confirm that a Type-only change is acceptable. The inspection sweep owns this candidate.

### E13: Tunable options follow three conventions
- **Receipts:**
  - Optional with a hidden default: `FormPostOptions.commitWithin?` (`form-post.ts:67`), `AttachOptions.*Millis?` (`attach.ts:41-46`), `GatewayOptions.port?/maxSnapshotBytes?/maxRoots?` (`gateway.ts:31-36`, defaults at 319-320), and `HostOptions.store?` (`host.ts:25, 120`).
  - Required `Option`: `FormPostOptions.login` (`form-post.ts:57`) and `FrameHostOptions.pollInterval/alarmHold` (`frame-host.ts:125, 133`).
  - Required value: `HttpClientOptions.reconnect`, with a named `defaultReconnect` (`client.ts:51, 251`).
  - `FormPostOptions` alone mixes two of the three.
- **North star:** Explicit, and consistency for agent DX.
- **Change:** One rule. Suggested: a behaviour that matters (timeouts, limits, the store) is a required value, and the library exports a named default (`HttpTransport.defaultReconnect` is the model). Apply it in these five option types.
- **Lines removed:** about 15 of `?? default` and `Option.getOrElse` code, plus a line at each call site that names the default.
- **Risk:** Low. It is mechanical. **Public API:** yes. **Wire/stored:** no.

### E14: `sessionBuffer`/`SessionBuffer` is a public export tested only by a tautology
- **Files:** `server.ts:166-172`. The only use outside the module is `tests/actor/revocation.test.ts:512`, which asserts the constant equals its own literal.
- **Callers:** `rg "sessionBuffer|SessionBuffer"` finds server.ts (3) and that test (1).
- **North star:** The deletion test.
- **Change:** Make it module-private and delete the assertion. Keep the doc on the `Stream.share` call.
- **Lines removed:** about 10.
- **Risk:** None. **Public API:** yes. **Wire/stored:** no.

### E15: The durable store's `factory` is dead, and it is why `src` imports the testing subpath
- **Files:** `host-durable-object/src/storage-store.ts:10` (`import type { StoreFactory } from "effect-frame/actor/testing"`) and `:309` (`factory`), exported at `index.ts:10`.
- **Callers:** `rg "StorageStore\.factory|\bfactory\("` over the package, apps and tooling: 0 callers.
- **North star:** The deletion test. Production code does not depend on a testing entry.
- **Change:** Delete `factory` and its import.
- **Lines removed:** 3.
- **Risk:** None. **Public API:** yes (private package). **Wire/stored:** no.

## Owner questions

- **E6(b):** Route the Durable Object by the body address, which changes the private DO router's URL layout, or keep the per-address transports? The guard in E6(a) is needed either way.
- **E3:** Is a new 413 refusal status a wire change under the protocol rule?
- **E12:** Is a Type-only change to `Frame.Snapshot`, with the encoded form unchanged, allowed under the inspection protocol version?

## Not worth a pass (under about 5 lines of style)

- `wire.ts:32-40, 104-108`: comments that tell history ("A client built before the Query primitive keeps working", "the old behavior exactly").
- `WireQueryError` carries `StreamEnded`, which "a host never sends" (`wire.ts:84-85`). It is harmless, and it is on the wire.
- `effect-frame/actor/testing` resolves to `conformance.ts`, which re-exports `QueryTest` (`package.json` exports, `conformance.ts:444`). The file name does not match the subpath.
- `defineFrameHost` is the only `define*` constructor in `packages/*/src` (`rg "export const define\w+"`). Every other package uses `make` or `layer`.
- `factoryFromLayer` has one caller (`tests/actor/mailbox-store.conformance.ts`).
- `holdOf` is exported only for `tests/frame-host.test.ts:300-304`.
- The gateway registry and counters are mutable `Map`s and `let`s written from Bun callbacks (`gateway.ts:343-423, 592-602`). It is a dev tool at the platform boundary; it could become a `Ref` if E11 ever touches the file.

## Prior-art verdicts

| Idea | Source | North star | Verdict |
| --- | --- | --- | --- |
| Transport I/O over `effect/unstable/http` `HttpClient` | foldkit `packages/foldkit/src/http/http.ts` | Effect-native | adopt (E9) |
| Devtools state as `SubscriptionRef`, not a callback | foldkit `devTools/webSocketBridge.ts` | Effect-native | adopt (E8) |
| Devtools message history and time travel | foldkit `devTools/store.ts`, `runtime/devToolsConfig.ts` | Actor-model | rejected: it assumes one model and one message queue (the Elm architecture), while effect-frame has one mailbox per actor |
| Agent dispatch of messages from devtools (the `Message` schema on the config) | foldkit `runtime/devToolsConfig.ts:66-76` | Actor-model | not adopted in this pass: it would write actor state from outside a client reference. It needs an owner decision and would go through `send`. |
