# Pass 2: guards, gate, CI, lint

Scope: `tooling/checks`, `.oxlintrc.json`, `tooling/checks/src/lint-plugin.ts`, the root `package.json` gate, `lefthook.yml`, `.github/workflows/`, `.changeset/config.json`.
Tree: `~/Developer/personal/.worktrees/effect-frame-arch-pass2`, HEAD `d272bd7`. Read only. I ran no gate and no build (`packages/effect-frame/dist` is absent), and I edited no file other than this one.
The probes are in `/tmp/claude-1000/-home-exedev-Developer-personal/cacfac5c-ac95-4967-a839-81db3553734d/scratchpad/pass2-guards/`:
- `surface.ts`, `cite.ts`, `heads.ts`: the citation resolver probe. Each loads every `exports[*].source` under `--conditions=source`.
- `settle.py`: the settle-then-expect probe.
- `module-maps.txt`: the module-level maps and sets.
- `acc-paths.txt`: the paths the acceptance matrix cites.
- `cs-before-fix/` and `cs-after-fix/`: the changesets at `ab6b660^` and at `86e35d9^`.

## Receipts: what the guards see today

- **The gate** (`package.json:25`) runs three concurrent lanes, then `bun run test`:
  - types: `typecheck`
  - style: `lint && fmt:check && paths && docs`
  - build: `build && boundary && declarations`
- **`bun run docs`** (`tooling/checks/src/docs-cli.ts:29-94`) has two rules:
  - The glossary rule.
  - The examples rule. It reads a ts or tsx fence (`examples.ts:25`) only in a *reference doc* (`examples.ts:173-181`: README, AGENTS, CONTEXT, `docs/toolchain.md`, package and app READMEs, skills). `examples.ts:178` states that it does not read changesets or `plans/`.
  - It never reads JSDoc in `src`.
  - Inline backticked citations are unchecked (ledger `plans/architecture-loop-2026-09-24.md:112`).
- **`bun run declarations`** (`declarations-cli.ts:25-86`) runs three rules against the built `dist`:
  - Every `exports` file exists.
  - Value-name collisions and duplicate paths. `collisions.ts:181` loads each subpath by its package name, and `collisions.ts:18` says it "sees values. A type-only export is outside it."
  - `any` or `unknown` leaks in `dist/**/*.d.ts`.
  - It also writes `tooling/checks/consumer/generated/<pkg>.ts`, one `export * as S<n>` per subpath (`subpaths.ts:82-89`, `:113-114`), and `tsc -p consumer` compiles that file against `dist` (`tooling/checks/package.json` `declarations`).
- **Lint**: the `frame` plugin has three rules: `no-switch`, `disable-reason`, and `span-name` (`lint-plugin.ts:63-128`). oxlint 1.83 has no `no-restricted-syntax`: `node_modules/oxlint/configuration_schema.json` has no entry for it. So a structural rule must be a `frame` rule. `no-restricted-imports` does support `importNames` (`configuration_schema.json:18887`).
- **Hooks**:
  - `lefthook.yml`: pre-commit runs `lint:fix && fmt` and then `gate`; pre-push runs `fmt:check`.
  - There is no `commit-msg` hook.
- **CI**:
  - `ci.yml:16-30`: setup-bun with `bun-version-file: package.json`, then `--frozen-lockfile`, `gate`, and `test:deploy`. The checkout is shallow, with no `fetch-depth`.
  - `release.yml:26-33`: `bun run release`, which is `gate && changeset publish` (`package.json:28`).
- **Changesets**:
  - `.changeset/config.json` has no rule about bump size.
  - The CLI warns about a first major only in the interactive `changeset add` (`node_modules/@changesets/cli/dist/add.mjs:42-47`: "will be its first major release (1.0.0)"). A changeset written by hand, which is how an agent writes one, never sees that warning.
  - `effect-frame` is `0.27.0`, and it is the only published package (`packages/effect-frame/package.json:3`; `host-durable-object` and `inspect` are private).
- **Acceptance matrix** (pass 1 G8): covered. `paths.ts:8-11` refuses a cited test path or test name that is missing, except in Open or Superseded rows. `acc-paths.txt` cites 104 paths, and 16 are missing (`apps/chat`, `apps/auth`, `apps/jobs`). Those appear to be Open rows, since the gate passes.

## Q1. Counsel C1: JSDoc `@example` blocks and changeset code

**What C1 actually was** (`git show ab6b660`), in three kinds:

1. A `Namespace.member` that no longer exists: `Query.batched` and `QueryCache.layerTest` in `.changeset/actor-dead-exports.md`, `query-explicit-version.md` and `query-one-read-path.md`.
2. A flat name that no longer exists or never did: `spawn(...)` in `delete-cell.md`, `updateSearch` in `router/branch.ts:941`, and `QueryTest` in `view-one-path.md`.
3. A fence that no longer compiles: `params: NoParams` and `params: Schema.Struct({})` in the **`@example` blocks** at `router/branch.ts:3123` and `:3179`, and a `hydrate({ routes, notFound, root })` call with arguments missing.

A citation check catches kind 1. Only compiling the fence catches kind 3. Kind 2 is prose.

**Measurements** (`cite.ts`, `heads.ts`):

- JSDoc in `packages/*/src` has 59 ts fences totalling 223 lines, mostly 1 to 7 lines each. 15 of them sit under an `@example` tag (`git grep -n "@example" packages/*/src`).
- JSDoc has **275** citations whose head is an effect-frame export. **21** do not resolve:
  - **11 are stale today:**
    - `Actor.spawn` at `actor/local-engine.ts:49`. `spawn` was deleted in `85e3518`.
    - `Behavior.refuse` at `actor/behavior.ts:78, 113, 148` and `actor/vocabulary.ts:21`.
    - `Behavior.wakeAt` at `actor/behavior.ts:150`, `actor/durable-engine.ts:116`, `actor/mailbox-store.ts:23`, `host-durable-object/src/frame-host.ts:30, 275` and `storage-store.ts:19`.
    - `git log -S"export const wakeAt"` and `-S"export const refuse ="` return nothing. These are option fields (`behavior.ts:79`, `:151`) cited as if they were namespace members, so they have never resolved.
  - **The other 10 are gaps in the probe, not stale citations:**
    - Inherited statics: `Anonymous.make` at `router/document.ts:270, 288`, and `MailboxStore.of` at `actor/testing/conformance.ts:16`. A resolver that uses `name in value` resolves these.
    - Interface fields: `QueryEntry.override` at `query-client.ts:1426`, `RefOptions.behavior` at `router/branch.ts:225`, and `Router.current` at `router/router.ts:153, 160`.
    - `Match.tagsExhaustive`, three times: effect's `Match`, which `view/control.ts:176` also exports as a component.
- JSDoc citations whose head is not an effect-frame name (13, `heads.ts`) are mostly legitimate:
  - Span names that share the `Area.op` form: `Prerender.build`, `Leave.onLeave` (`router/leave.ts:83`), `Branch.route`, `Driven.session` (`view/driven.server.ts:75`).
  - Namespace-import aliases: `Frame.*`.
  - Globals: `Bun.*`.
  - Effect platform modules: `FetchHttpClient`, `Socket`.
- Changesets at `ab6b660^`, before the fix:
  - `cite.ts` flags `QueryCache.layerTest` at `query-one-read-path.md:8`.
  - `heads.ts` flags `Query.batched` in `actor-dead-exports.md` and `server-half-options.md`.
  - **Most unresolved changeset citations are correct.** Of 211 citations, 34 do not resolve even after the fix. Nearly all are removal notices, such as `delete-query-test.md:5` "Delete `QueryTest`, `QueryCache.layerTest`…" and `route-one-form.md:12` "`Route.Route`… are gone". 20 of 52 changesets are removal notes. 2 of 52 contain a ts fence (`route-one-form.md`, `route-redirect.md`).

**Design:** the cheapest structural guard comes in two parts.

- **Part A, citation resolver** (serves Q1 and Q2; candidate P2-G1). It checks each `Head.member` against the surfaces that `readSurfaces` already loads.
- **Part B, `@example` fences as regions** (candidate P2-G2). It reuses `examples.ts` so the 15 tagged fences compile. This is the only part that catches C1 kind 3, and both kind-3 receipts were `@example` blocks.
- The other 44 untagged fences get Part A only. Compiling them would need a prelude for each fragment, which costs more than the drift it would catch.

## Q2. Inline citations in reference docs

Across 17 reference docs, `cite.ts` finds 263 citations with a known head. 6 do not resolve, and **none is confirmed stale**. This agrees with the one-off run recorded in the ledger (`plans/architecture-loop-2026-09-24.md:112`).

- The 3 fence hits are all inherited statics or effect's `Match`: `packages/effect-frame/README.md:86, 128, 364`.
- The 2 inline hits are interface fields. `HostEvent.form` (`README.md:927`) is `view/host.ts:114`, and `Prepared.post` (`README.md:928`) is `view/view.ts:41`.
- The unknown heads `Driven.session`, `Driven.defaultLimit` (`view/driven.server.ts:29`) and `Frame.*` are namespace aliases. The repository uses exactly one alias for each such subpath: `import * as Driven|Frame|Prerender` from `view/driven`, `frame` and `router/prerender` (by `git grep`). So the alias table can be derived from those imports rather than written by hand.

The reference-doc half of P2-G1 therefore protects against future drift and has nothing to fix today. The JSDoc half has 11 citations to fix.

## Q3. Release safety

Before `d82afa8`, five changesets said `"effect-frame": major` on `0.26.x` (`git show d82afa8`: `attach-status-stream.md`, `delete-query-test.md`, `document-root-id.md`, `query-cache-internals.md`, `snapshot-lifecycle-option.md`). Nothing in the gate reads bump sizes.

**Place it in the gate, in the `docs` lane.** The rule is pure text and runs in milliseconds. Pre-commit, CI and `release` all run the gate, so it fires when the changeset is written, not when the Version PR opens.

It needs a second half for the Version PR. `changeset version` runs inside `release.yml:32-33` and consumes the changesets, so the gate on that PR sees only `package.json` at `1.0.0`. See P2-G3.

## Q4. Toolchain fail fast

Today the Bun check is `tooling/checks/tests/toolchain.test.ts:10-20`, and it runs inside `bun run test`, **after** all three lanes (`package.json:25`). Under the wrong Bun, the build lane's `Bun.build` (boundary and bundles) runs first and can fail with a bundle assertion. That is the late, misleading failure that pass 1 reproduced (`plans/pass1/guards.md` G2). CI is pinned (`ci.yml:18`), so the exposure is local only: lefthook and the dangling `~/.cache/bun142/bun` symlink.

**Yes, fail fast.** See P2-G4.

## Q5. Flaky tests and the "one binding" class

- **The f476010 class.** Each app has its own `settle`, and the two are copies of one wall-clock poll: `apps/dashboard/tests/fixture.ts:361-372` and `apps/notes/tests/fixture.ts:150-161`, 25 ms × 80, then `Effect.die`.
  - Neither uses `ViewTest.waitFor`, which is driven by render revisions (`packages/effect-frame/src/view/testing.ts:285-305`).
  - `Condition.until` is `(root) => boolean` (`testing.ts:74-81`). A boolean says nothing about what was expected, so a test waits on one element and then asserts on others.
  - `settle.py` finds 84 `settle` calls, and 20 later `expect`s read a selector the settle did not wait on. Most of the 20 are correct, because they check absence inside the same boundary (e.g. `apps/dashboard/tests/readiness.test.tsx:54-56`). **A lint for this is not worth a pass**: an AST cannot tell which bindings share a turn.
  - The structural fix is an API that makes the expectation *be* the wait. See P2-G9.
  - The root cause is the framework's own open candidate: one subscription per Source within a mount (ledger `:105`, an owner decision).
- **`tests/view/streaming.test.tsx:173-215`.** The test orders `release(c)` and then `release(b)` with two `Effect.sleep("20 millis")` under `scopedLive` (`:181-184`). It failed as "5 patches seen, 4 expected", which is an *extra* patch. That fits a patch written twice more than a timing miss, so it is a possible defect in apply-once ordering, not a guard gap. It needs a diagnosis run with a latch in place of the sleeps.
  - Linting `Effect.sleep` in tests is **not worth a pass**: 63 sleeps in 30 test files (`git grep -c`).
- **`tests/router/prerender-build.test.tsx:272-291`.** The test interrupts a build and expects `staging` to be empty.
  - The staging release is `Effect.ignore(fs.remove(directory, { recursive: true }))` (`router/prerender-output.server.ts:127`), so a failed removal is silent.
  - A page write (`router/prerender.server.ts:486-487`) that is in flight when the build is interrupted is a plausible cause. This is **a hypothesis, not reproduced**.
  - No guard today would surface it. `effect/noSilentCatchAll` checks only `catchAll` and `catchAllCause` (`node_modules/oxlint-plugin-effect/dist/rules/no-silent-catch-all.js:39`). See P2-G7.

## Q6. North-star rules with no guard

| Rule (north star) | Guard today | Sites today | Rule that would close it |
|---|---|---|---|
| No module-level side channel (explicit, actor-model) | none | 16 module-level `WeakMap`/`WeakSet` in `packages/*/src` (`module-maps.txt`), e.g. `router/branch.ts:540, 570, 1230, 3232`, `router/codec.ts:252-260`, `actor/command-id.ts:35` (A18, kept). 8 more are constant lookup `Set`/`Map`s (`view/form.ts:297-298`, `view/hosts/html.ts:66`) | P2-G5 `frame/no-module-state` |
| An app's state lives in an actor (actor-model) | none | 0 `Ref`/`SubscriptionRef`/`MutableRef` in `apps/*/src` or `packages/effect-frame/examples` (`git grep`) | P2-G6, a `no-restricted-imports` override. It is free today |
| A swallowed failure is a written decision (explicit, effect-native) | only for `catchAll`/`catchAllCause` | 10 `Effect.ignore` in 3 files, 7 of them in `router/prerender-output.server.ts` (109, 127, 174, 180, 181, 186, 219) | P2-G7 `frame/explicit-ignore` |
| JSDoc and changesets name the current API (explicit) | none | 11 stale JSDoc citations (Q1) | P2-G1, P2-G2 |
| A 0.x release never goes major by accident (explicit) | none | 5 in pass 1 | P2-G3 |
| A package change carries a changeset (AGENTS.md "Changes") | none | — | P2-G8 |
| Conventional Commits, with `!` for a breaking change (AGENTS.md) | none (no `commit-msg` in `lefthook.yml`) | — | P2-G8 |
| The gate runs on the pinned Bun (explicit) | late (test lane) | — | P2-G4 |

## Candidates

### P2-G1: Every `Head.member` citation resolves
- **Files:** new `tooling/checks/src/citations.ts` and `tests/citations.test.ts`; `declarations-cli.ts`, which calls it after `collisionRule`; 11 JSDoc sites.
- **Problem:** C1 kind 1. 11 JSDoc citations have never resolved or no longer resolve (Q1). Nothing reads JSDoc or changesets (`examples.ts:178`).
- **North star:** explicit.
- **Change:**
  - Read the citations: backticked `Head.member` tokens and fence bodies in the JSDoc of `packages/*/src`, reference docs (`isReferenceDoc`), and `.changeset/*.md`.
  - Resolve each one against:
    - the loaded surfaces (`collisions.ts:172-190`), using `member in value`, which covers inherited statics;
    - type-only names and interface fields from the `dist` `.d.ts` text, in the regex style of `declarations.ts`;
    - aliases derived from `import * as X from "effect-frame/…"`;
    - span names collected from `Effect.fn("…")` literals. `lint-plugin.ts:57` already defines the form.
  - A head from `effect`, or a name declared in the same file, is skipped.
  - A head that is neither known nor skipped fails, which catches `Query.batched`.
  - A changeset names a removed API only inside an explicit `<!-- removed: A.b, C -->` comment, so removal notices stay possible.
  - It runs in the build lane, because it needs `dist`.
  - Fix the 11 sites: for example `Actor.local` in place of `Actor.spawn`, and "the `refuse` option of `Behavior.value`".
- **Cost:** about 120 lines plus a test. About 20 changeset removal markers are needed for each release's worth of changesets.
- **Test that fails before it exists:**
  - A fixture JSDoc citing `` `Actor.spawn` `` is refused, and `` `Actor.local` `` passes.
  - A fixture changeset citing `` `QueryCache.layerTest` `` without a `removed` marker is refused, and passes with one.
  - Against `cs-before-fix/`, the rule flags `query-one-read-path.md:8`.
- **Risk:** low to medium. The tolerance for false positives depends on how precise the resolver is, and the probe needed three kinds of exemption.
- **Public API change:** no.

### P2-G2: An `@example` fence is a compiled region
- **Files:** `tooling/checks/src/examples.ts`, `docs-cli.ts`; the 15 `@example` sites (e.g. `router/branch.ts:1027, 3123, 3179`, `actor/query.ts:110, 136`, `actor/host.ts:257`); new regions under `packages/effect-frame/examples/`.
- **Problem:** C1 kind 3. Both fences that no longer compiled (`params: NoParams`, `params: Schema.Struct({})`) were `@example` blocks, and no check compiles JSDoc.
- **North star:** explicit. The JSDoc is the reference (`AGENTS.md` "Read first" item 3).
- **Change:**
  - Treat ` * @example path#region` as the marker for the fence that follows it.
  - `blocksOf` reads fences in JSDoc as well, with the ` * ` prefix stripped.
  - `synced` puts the prefix back.
  - `bun run docs --fix` writes each fence from its region, and `bun run docs` refuses a fence that drifts or has no marker.
  - Untagged JSDoc fences are left to P2-G1.
- **Cost:** about 50 lines in `examples.ts`, and 15 regions of roughly 90 lines in total.
- **Test that fails before it exists:** in `tests/examples.test.ts`, a TypeScript source whose `@example` fence differs from its region yields a `Drift`, and `synced` restores the ` * ` prefix.
- **Risk:** low.
- **Public API change:** no.

### P2-G3: No accidental 1.0
- **Files:** new `tooling/checks/src/changesets.ts` and its test; `docs-cli.ts`.
- **Problem:** five hand-written `major` changesets on 0.x (Q3). The CLI's warning exists only in the interactive `add` (`add.mjs:42-47`).
- **North star:** explicit. A first major release is a decision written where it is made.
- **Change:**
  - Rule 1: refuse `"<pkg>": major` in `.changeset/*.md` while that package's version is below `1.0.0`.
  - Rule 2: refuse a published package whose version is `>= 1.0.0`.
  - Both rules hold while an owner-edited constant (`firstMajor: false` in `changesets.ts`) holds. Flipping it is the explicit 1.0 marker.
  - Rule 2 catches the Version PR, where the changesets are already consumed.
- **Cost:** about 40 lines.
- **Test that fails before it exists:** fixture `{ version: "0.27.0" }` with a `major` changeset is refused, and the same with `minor` passes. Against `d82afa8^` the rule flags 5 files.
- **Risk:** none.
- **Public API change:** no.

### P2-G4: The gate checks the Bun version first
- **Files:** `package.json:25`, new `tooling/checks/src/toolchain-cli.ts`, `tests/toolchain.test.ts`.
- **Problem:** the version check runs last (Q4). A wrong Bun fails first somewhere else, with a misleading message.
- **North star:** explicit.
- **Change:**
  - `"gate": "bun run --cwd tooling/checks toolchain && concurrently …"`.
  - The CLI compares `Bun.version` with `packageManager` and prints `process.execPath`, so a dangling symlink shows which binary actually ran.
  - A pure `pinnedMismatch(packageManager, version)` holds the logic, and the existing test calls it.
- **Cost:** about 20 lines.
- **Test that fails before it exists:** `toolchain.test.ts` asserts that `manifest.scripts.gate` starts with the toolchain step, and that `pinnedMismatch("bun@1.4.2", "1.4.0")` names both versions.
- **Risk:** none.
- **Public API change:** no.

### P2-G5: `frame/no-module-state`
- **Files:** `tooling/checks/src/lint-plugin.ts`, `tests/lint-plugin.test.ts`, `.oxlintrc.json`.
- **Problem:** the ledger lists 15 router `WeakMap` side channels as pass 2 work (ledger `:109`), but nothing stops a new one.
- **North star:** explicit, because a reader cannot find the state from the call site; also actor-model.
- **Change:**
  - A `Program` visitor over top-level `VariableDeclaration`s, including exported ones, in `packages/*/src`.
  - It refuses `new WeakMap|WeakSet|Map|Set` unless the argument is an array literal. A literal-initialized set is a constant lookup table, and preferably also a `ReadonlySet`.
  - It also refuses module-level `let`, which has 0 hits today (`git grep`).
  - The escape is a disable with a reason. `command-id.ts:35` (A18) keeps one.
  - It lands after the router side-channel candidate, or with 15 reasoned disables that serve as that candidate's checklist.
- **Cost:** about 25 lines.
- **Test that fails before it exists:** `lint-plugin.test.ts` expects `const m = new WeakMap()` at top level to be reported, while `const s = new Set(["a"])` and a `WeakMap` inside a function are not.
- **Risk:** low.
- **Public API change:** no.

### P2-G6: App and example code holds state only in actors
- **Files:** `.oxlintrc.json`, an override for `apps/*/src/**` and `packages/effect-frame/examples/**`.
- **Problem:** the rule "state lives in an actor" (`north-stars.md` Actor-model) has no guard. Today it holds only by habit: 0 hits.
- **North star:** actor-model.
- **Change:** `no-restricted-imports` with `paths: [{ name: "effect", importNames: ["Ref","SubscriptionRef","SynchronizedRef","MutableRef"], message: "State is an actor: Actor.local(Behavior.value(x))" }]`. The override must repeat the existing server pattern (`.oxlintrc.json:68-83`), because an override replaces the rule's options.
- **Cost:** about 15 config lines and 0 fixes.
- **Test that fails before it exists:** a lint fixture in an `apps/*/src` path importing `Ref` from `effect` is reported. The `lint-plugin.test.ts` harness runs oxlint on a fixture.
- **Risk:** none.
- **Public API change:** no.

### P2-G7: `frame/explicit-ignore`
- **Files:** `lint-plugin.ts`, its test; 10 sites in `router/prerender-output.server.ts`, `view/lazy.ts:146`, and `inspect/src/capabilities.ts:142, 164`.
- **Problem:** `Effect.ignore` swallows a failure with no trace. The prerender staging flake leaves nothing to read (Q5).
- **North star:** explicit, effect-native.
- **Change:**
  - Refuse `Effect.ignore` unless it is called with an options object that names `log`. Effect v4 takes `{ log, message }` (`node_modules/effect/src/Effect.ts:7920-7932`).
  - A cleanup then reads `Effect.ignore(fs.remove(dir), { log: "Warning", message: "staging not removed" })`.
- **Cost:** about 20 lines and 10 one-line edits.
- **Test that fails before it exists:** the fixture `Effect.ignore(x)` is reported, while `Effect.ignore(x, { log: true })` is not.
- **Risk:** low.
- **Public API change:** no.

### P2-G8: A package change carries a changeset, and a commit carries its type
- **Files:** `.github/workflows/ci.yml`, `lefthook.yml`.
- **Problem:** the two rules in `AGENTS.md` under "Changes" (Conventional Commits with `!`; a changeset for each published change) have no guard.
- **North star:** explicit.
- **Change:**
  - In `ci.yml`, set `fetch-depth: 0` on checkout (today it is the default shallow clone, `ci.yml:14`) and add `bunx changeset status --since=origin/main` on `pull_request`.
  - In `lefthook.yml`, add a `commit-msg` job that checks `^(feat|fix|docs|refactor|test|chore|perf|build|ci)(\([^)]+\))?!?: ` against `{1}`.
- **Cost:** about 8 lines.
- **Test that fails before it exists:**
  - A PR that touches `packages/effect-frame/src` with no changeset turns CI red. This is proved by a CI run; unit tests do not reach it.
  - A commit named "wip" is refused locally.
- **Risk:** low. Docs-only and test-only PRs need `changeset --empty`. Check `changeset status` on a docs-only PR before merging.
- **Public API change:** no.

### P2-G9: The wait is the expectation
- **Files:** `packages/effect-frame/src/view/testing.ts:74-81` (`Condition`), `apps/dashboard/tests/fixture.ts:361`, `apps/notes/tests/fixture.ts:150`.
- **Problem:**
  - A boolean `until` invites waiting on one binding and then asserting on the rest. That is the f476010 class, 9 tests.
  - The apps copy a wall-clock poll in place of the revision-driven `waitFor`.
- **North star:** declarative (the test states the state it expects) and explicit (a timeout shows the last value read against the value expected).
- **Change:**
  - `Condition` gains `{ read: (root) => A, equals: A }`, using `Equal.equals`, beside `until`, or in place of it.
  - `ConditionNotObserved` carries the last value read.
  - The apps drop both `settle` copies for `ViewTest.waitFor`, or for a shared fixture over it.
  - This does not remove the cause. The candidate "one subscription per Source" (ledger `:105`) does, and it needs an owner decision.
- **Cost:** about 40 lines in `testing.ts`, plus the edits to the app tests.
- **Test that fails before it exists:** a harness test whose view paints two bindings of one Source on separate turns passes with `{ read: both, equals }`. On a timeout, the error's `lastRead` equals the partial state.
- **Risk:** medium, because every app test's settle changes.
- **Public API change:** **yes**, `ViewTest.Condition`.

## Carry-over from pass 1 that is still open
- **Pass 1 G6** (internal plumbing is public) is not in the ledger table (`plans/architecture-loop-2026-09-24.md:117-199`). `Streaming` and `Wire` are still exported from `actor/client.ts:55` and `:77`. It is not a guard, but its "every public leaf is named by an app, a test, or an allowlist" rule would be one. I list it for the actor sweep.
- **Pass 1 G8** is closed by `paths.ts` (D14). No action.

## Not worth a pass
- A lint on `until` or `settle` predicates that read one element: 20 probe hits, most of them correct (Q5).
- A lint on `Effect.sleep` in tests: 63 sites in 30 files. Fix the one flaky test with a latch instead.
- A rule for `Effect.runFork` and `runPromise` in `src`: 12 sites. Each is a host-callback or entry edge, and `view/lazy.ts:143-146` already writes its reason. P2-G7 covers the `ignore` inside it.
- Compiling the 44 untagged JSDoc fences: each needs a prelude, and P2-G1 checks their citations.
- `release.yml` not running `test:deploy` before publish: CI runs it on the same commit (`ci.yml:29-30`).
