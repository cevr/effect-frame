# Pass 1: guards, gate, CI, tooling

Scope: `tooling/checks/src`, `tooling/dom-bench/src`, `.oxlintrc.json`, `lefthook.yml`, `turbo.json`, root `package.json` gate, `.github/workflows/`.
Tree: `/home/exedev/Developer/personal/effect-frame` (hydrate-order, HEAD `bacd899`). Read only. `git status` was clean at the end.
Probes live in the scratchpad: `dupes.ts`/`dupes.out`, `collide.ts`/`collide.out`, `names.ts`/`names.out`, `untested.txt`, `unused-anywhere.txt`, `override-hits.txt`, `acc-paths.txt`, `acc-missing-names.txt`.

Baseline under Bun 1.4.2: `bun run boundary` reports "8 browser entries are clean". `oxlint` exits 0 with no output. All 42 `oxlint-plugin-effect` 0.12.1 rules are enabled (`.oxlintrc.json:26-67`, compared with `node_modules/oxlint-plugin-effect/dist/rules`).

## Q1. Conventions and the guards that enforce them

| # | Convention | Evidence it is the convention | Guard today | Guard that could enforce it, and its cost |
|---|---|---|---|---|
| 1 | Server-only code lives in `*.server.*` files | CONTEXT.md:51; boundary.ts:64-65 | Yes: `no-restricted-imports` (`.oxlintrc.json:68-83`) plus `bun run boundary` | — |
| 2 | A browser file imports `effect-frame/actor/client`, never the full `effect-frame/actor` | boundary.ts:67-68 | Partial. Only the 8 hand-listed entries are checked (browser-entries.ts:13-22). **Leak:** `tooling/dom-bench/src/fixtures/effect-frame.tsx:3-4` imports the full `effect-frame/actor` and is bundled `target: "browser"` (`dom-bench/src/page.ts:21-28`) | Built-in `no-restricted-imports` `paths: [{ name: "effect-frame/actor", allowTypeImports: true }]`, turned off for server modules, tests, and scripts (the same override as `.oxlintrc.json:247-259`). The schema has `allowTypeImports` (`node_modules/oxlint/configuration_schema.json:18884`). Cost: about 10 config lines and 1 fixture fix. See G7 |
| 3 | No ternaries, nullish values, async functions, try/catch, or throw in src | rejected.md | Yes: `effect/*` rules | — |
| 4 | `Match.tagsExhaustive` rather than `switch` | 41 `Match.*` uses in src; 0 `switch` in tests | **Partial.** `effect/preferMatchTagsExhaustive` covers only return-only `_tag` switches, and it still lets through `packages/effect-frame/src/actor/http/form-post.ts:324`, which is return-only with grouped cases. There are 10 `switch` in src: form-post.ts:324, http/wire.ts:192 and 214, frame.ts:452, inspect/src/limits.ts:16, inspect/src/reader.ts:290, and 4 in dom-bench | A local oxlint JS plugin rule `frame/noSwitch` (oxlint loads a local `.ts` plugin, see `configuration_schema.json:59-60`). Cost: a 15-line rule and rewriting 6 src switches. See G9 |
| 5 | `View.bind`/`View.event`, never flat `bind`/`event` | apps: `View.bind`/`View.event` 59 times, flat imports 0 | **None.** `view/index.ts:27-36` exports both forms | Delete the flat exports (see G5). If they are kept, a stopgap is `no-restricted-imports` `importNames: ["bind","event","submit","attach"]` on `effect-frame/view`, which costs 3 lines |
| 6 | `select` from `actor/client`, not `View.select` | apps: 5 flat `select` imports, 0 `View.select` | **None.** `View.select` is the same value (probe) | G5 export-duplicate check |
| 7 | A view is an arrow that returns `Effect.gen` | app `.tsx`: 0 `Effect.fn(`, 28 `Effect.gen(` | **None**, and the JSDoc contradicts it: `view/view.ts:151` says "A named view is `Effect.fn("Name")(…)`" | An AST rule cannot tell a view from other code, so no cheap guard exists. Pick one form and fix either the doc or the apps (G10) |
| 8 | A `For` `keyBy` parameter is type-annotated | 9 of 9 `keyBy={(x: T) =>` in apps (e.g. dashboard/src/overview.tsx:60) | None | A local rule: a JSX attribute `keyBy` whose arrow parameter has no annotation. Cost: 20 lines. Removing the need through the API is better (agent trial #3) |
| 9 | `Effect.fn` span name has the form `Area.op` | 91 of 121 names match `^[A-Z]\w*\.[a-z]\w*$`; 30 do not, mostly dotted `Actor.durable.x`. Unprefixed: `useQuery`, `runQuery`, `followQuery` (actor/query-client.ts:1323, 1338, 1448) | Partial: `effect/requireNamedEffectFn` requires a name, not its form | A local rule with the regex `^[A-Z][A-Za-z]*(\.[a-z][A-Za-z0-9]*)+$`. Cost: 15 lines and renaming 3 spans |
| 10 | Every `oxlint-disable` carries ` -- reason` | 147 of 168 carry one; 21 do not (e.g. actor/http/server.ts:193, 208) | None | A local rule over `sourceCode.getAllComments()`, or a grep in tooling/checks. Cost: 15 lines. See G3 |
| 11 | A disable is removed once it is no longer needed | — | **None.** `--report-unused-disable-directives` finds **75 unused directives**. My override probe finds **27 of 113 `.oxlintrc.json` override exemptions unused** | `oxlint --report-unused-disable-directives-severity=error` in the `lint` script, plus a small script that drops each override in turn. See G3 |
| 12 | Relative imports end in `.js` | src 622 of 622 | None | `import/extensions`. Low value: see "not worth a pass" |
| 13 | Kebab-case file names; no import cycles | uniform | None | `unicorn/filename-case` and `import/no-cycle` each produce 0 hits today, so turning them on is free. See G9 |
| 14 | Internal code reaches a sibling area by a relative path; the package self-name is for public use | **Mixed.** router/branch.ts:57-62 uses relative paths, while router/hydrate.ts:1, view/form.ts:10, view/hosts/dom.ts:1 and view/hosts/html.ts:2 take `Streaming` and `Wire` through `effect-frame/actor/client` | None | package.json `imports` (`#internal/*`) plus a rule that a src file may not self-import a namespace that no app uses. See G6 |
| 15 | Each CONTEXT.md term is defined once | — | None. Server module, Browser entry and Shown branch are each defined twice (CONTEXT.md:51/179, 55/183, 175/199) | A 10-line uniqueness check on `**Term**:`. See G10 |
| 16 | Each acceptance row cites a test that exists | rejected.md ("the matrix is proof") | **None.** 27 of 109 cited test paths are missing (`packages/actor/…`, `packages/view/…`, `packages/router/…`), and 13 of 294 cited test names are not found | G8 |
| 17 | Local Bun and CI Bun are the same | `package.json:48` `bun@1.4.2`; `@types/bun` 1.4.2 | **None.** All 3 workflows use `bun-version: latest`, and the box has 1.4.0 | G2 |
| 18 | The gate that runs locally also runs in CI and before release | lefthook.yml:4-17 and package.json:23 | **None.** See G1 | G1 |

## Candidates

### G1: CI runs a weaker gate than the local one, and a release runs no gate
- **Files:** `.github/workflows/ci.yml`, `build.yml`, `release.yml`, `lefthook.yml`, `package.json`
- **Problem:**
  - `ci.yml:29` runs `bun run fmt`, which writes files, so the Format step can never fail. `build.yml:19` runs the real `fmt:check`, so the two jobs overlap.
  - No workflow runs `bun run declarations`. `tooling/checks/tests/declarations.test.ts:13` only unit-tests the regex. The consumer `tsc -p consumer` runs only inside the `declarations` script. So the check that caught commit 42a40c3 ("emit declarations that resolve the package's own subpaths") never runs in CI.
  - The boundary is covered in CI only through the test loop (`tooling/checks/tests/boundary.test.ts:15-24`).
  - `ci.yml:20` runs `bun install` without `--frozen-lockfile`, while `build.yml:17` uses it.
  - `release.yml:28-33` runs `changeset publish` straight after `bun install`, and `package.json` `release` only builds, so a push to main publishes even when CI is red.
  - lefthook.yml:4-17 repeats the gate as its own serial list, so the two can drift.
- **North star:** explicit over implicit (the proof that gates a publish should be visible in the publish path).
- **Change:**
  - Replace `ci.yml` and `build.yml` with one job: `bun install --frozen-lockfile`, then `bun run gate`, then `bun run test:deploy`.
  - Make `release` run `bun run gate && changeset publish`, or have the release job `needs:` the gate job.
  - Point lefthook pre-commit at `bun run lint:fix && bun run fmt && bun run gate`.
  - Delete `build.yml`.
- **Risk:** Low. CI takes longer because the build and declarations steps are added.

### G2: Pin one Bun for CI and local runs (question 4)
- **Files:** the 3 workflows; `tooling/checks/tests/toolchain.test.ts`
- **Problem:** The test "a server bundle … excludes the browser navigation modules" (`packages/effect-frame/tests/router/navigation-behavior.test.tsx:135`) depends on the bundler. Reproduced: it fails under 1.4.0 (`~/.local/bin/bun`) and passes under 1.4.2. `boundary.ts:166-197` and the 3 app `boundary.test.ts` files read `Bun.build` metafiles, so they have the same exposure. CI takes `latest`, so a Bun release can turn main red with no commit.
- **North star:** explicit (the toolchain version is a declared input, not an ambient one).
- **Change:**
  - In every workflow, replace `bun-version: latest` with `bun-version-file: package.json`. setup-bun v2 reads `packageManager`; check this against the setup-bun README before merging.
  - Add a first test to `toolchain.test.ts`: `expect(Bun.version).toBe(pkg.packageManager.split("@")[1])`, with a message that names the pinned version. A wrong local Bun then fails in one line that names the cause, instead of failing a bundle-marker assertion.
  - `packageManager` becomes the only place that names the version.
- **Risk:** Low. Upgrading Bun becomes a one-line change that the gate checks.

### G3: Stale lint escape hatches
- **Files:** `.oxlintrc.json`, `package.json` `lint`, `docs/toolchain.md:22`, and 75 source sites
- **Problem:**
  - 75 unused `oxlint-disable` directives (e.g. `apps/blog/src/server.ts:173`, `packages/effect-frame/src/router/prerender.server.ts:258`, `tooling/dom-bench/src/options.ts:73`).
  - 27 unused override exemptions. The largest are `packages/host-durable-object/scripts/runtimes.ts`, which has 8 of 8 unused (`.oxlintrc.json:221-236`), and all 3 rules for `fixture-contract/index.ts` (`:104-110`). The full list comes from comparing `override-decl.txt` with `hit-pairs.txt`.
  - 21 directives carry no reason.
  - `docs/toolchain.md:22` claims "No host or application path has a lint escape hatch", but there are 24 override blocks and 168 disables.
- **North star:** explicit (each exemption states a live reason).
- **Change:**
  - Set `lint` to `oxlint --report-unused-disable-directives-severity=error`.
  - Delete the 75 unused directives and the 27 unused exemptions.
  - Add the reason rule (Q1 #10).
  - Correct `toolchain.md:22`.
- **Risk:** Low. The change is mechanical.

### G4: The `plugins` list silently drops the default `unicorn` and `oxc` plugins
- **Files:** `.oxlintrc.json:8`
- **Problem:** Setting `plugins: ["typescript","import","node"]` replaces the default set, so the correctness, suspicious and perf categories never reach unicorn or oxc. With them on, there are 19 real hits: `unicorn/no-array-sort` 8, `no-useless-spread` 7 (e.g. `view/testing.ts:168`, `router/router.ts:1208`), `no-array-reverse` 2, `prefer-array-find` 1, and `oxc/no-accumulating-spread` 1. There are also 59 noisy `consistent-function-scoping` hits.
- **North star:** explicit (a rule set is chosen by name, not dropped by a default).
- **Change:** Add `"unicorn","oxc"`, fix the 19 hits, and turn `unicorn/consistent-function-scoping` off by name.
- **Risk:** Low.

### G5: A public-surface check that forbids duplicate paths and name collisions (question 2)
- **Files:** new `tooling/checks/src/exports.ts`, an `exports-cli.ts` and a test; `view/index.ts`, `router/index.ts`, `actor/client.ts`
- **Problem:** The probe imports each `exports[*].source` under `--conditions=source` and compares values by identity, one namespace level deep. Setting aside the intended superset `actor ⊇ actor/client`, it finds:
  - **The same value on two public paths:**
    - `View.bind`/`bind`, `View.event`/`event`, `View.submit`/`submit`, `View.attach`/`attach` (view/index.ts:1 and 27-36)
    - `View.select` and `select` (actor/client)
    - `QueryState.{isFailed,isLoading,isReady,match}` and the flat actor forms
    - `Behavior.Value` and `Value`
    - `Form.FormContext` and `FormContext`
    - `ViewTest.*` (view/index.ts:56) and the whole `view/testing` subpath
    - `Route.searchKeysOf` and `searchKeysOf`
    - `UrlState.UrlStateConflict` and `UrlStateConflict`, and the same for `UrlStateSchemaRejected`
  - **The same name with a different value across subpaths:** `Loading` (actor vs view), `Query` (actor vs view), `QueryState` (actor vs view), `attach` (view vs view/opentui), `mount` (view vs router), `make` (view/testing vs view/opentui).
- **North star:** explicit (one name means one thing and has one path). This is agent trial #2 and #9.
- **Change (sketch):**
  - `exports.ts` reads `package.json` exports and dynamic-imports each `source`.
  - It builds `Map<value, path[]>` (walking `[object Module]` namespaces one level) and `Map<name, Set<value>>`.
  - It fails on (a) a value reachable from more than one path, unless the path pair is in a declared `supersets: { "actor": ["actor/client"] }` or `aliases: { "view/jsx-dev-runtime": "view/jsx-runtime" }`; and (b) a name bound to more than one value.
  - Type-only exports need a second pass over the export lists in `dist/**/index.d.ts`, the same regex style as `declarations.ts:321`.
  - About 80 lines. The probe ran in about 1 s.
  - Land it together with the deletions or renames that make it green.
- **Risk:** Breaking for consumers, which the owner allows. EGW Search must follow the renames.

### G6: Internal plumbing is exported through the package self-name
- **Files:** `actor/client.ts:68` and `:92` (`export * as Streaming`, `export * as Wire`); `router/hydrate.ts:1`; `view/form.ts:10`; `view/hosts/dom.ts:1`; `view/hosts/html.ts:2`
- **Problem:**
  - `Wire` and `Streaming` are public only because sibling areas import them by the package name. `router/branch.ts:57-62` reaches internals by relative path, so the codebase has two conventions.
  - Of 346 public leaf names, **61 are named nowhere** in tests, apps, other packages, tooling or README (by word grep, see `unused-anywhere.txt`). Examples: `Wire.WireQueryKey`, `Streaming.actorSeeds`, `Generated.mintAll`, `Html.escapeText`, `Route.printPath`, `Prerender.lookup`.
  - Another 18 names appear only in other packages, not in effect-frame's own tests.
- **North star:** explicit. The public surface should be exactly what an app writes, so an agent's auto-import sees only authoring names.
- **Change:**
  - Add a package.json `imports` map (`"#actor/*": { "source": "./src/actor/*.ts", "default": "./dist/actor/*.js" }`) for cross-area internals, and drop `Wire`/`Streaming` from `actor/client`.
  - Add a coverage rule to G5: every public leaf is named by an app, a test, or an explicit allowlist (question 3).
- **Risk:** Medium. It touches the tsdown `unbundle` output, and `dist` must resolve `#` imports. The consumer typecheck (G11) proves it.

### G7: A browser import of the full `effect-frame/actor` outside the hand-written entry list
- **Files:** `tooling/checks/src/browser-entries.ts:13-22`, `tooling/dom-bench/src/fixtures/effect-frame.tsx:3-4`, `.oxlintrc.json`
- **Problem:** The entry list is hand-written ("a list that must be edited to add one records it", browser-entries.ts:6-7). The dom-bench fixture is bundled for the browser but is not in the list, and it imports server code, so the benchmark measures a bundle that carries hosts and stores.
- **North star:** explicit (the boundary covers every browser bundle).
- **Change:**
  - Change the fixture's imports to `effect-frame/actor/client`.
  - Add the file-local `no-restricted-imports` path rule from Q1 #2.
  - Either add the three dom-bench fixtures to `browserEntries`, or have `boundary-cli` fail when a `Bun.build({ target: "browser" })` entry in the repo is not listed.
- **Risk:** Low.

### G8: The acceptance matrix has no guard
- **Files:** new `tooling/checks/src/acceptance.ts`; `docs/design/acceptance.md`
- **Problem:** rejected.md treats the matrix as proof, but no guard checks it. 27 of 109 cited test files do not exist (e.g. `packages/actor/tests/local.test.ts`, `packages/view/tests/ssr.test.tsx`, `packages/router/tests/router.test.tsx`), because the paths predate the package merge. 13 of 294 cited names are not found (`acc-missing-names.txt`). Some of those are `describe > it` composites.
- **North star:** explicit (the proof is checkable).
- **Change:** Add a check that parses each Proof cell as `` `path` — "name", "name" `` and requires the path to exist and each name to be an `it`/`test` title in that file, splitting on ` > ` for describe composites. About 60 lines, run in the gate. Fixing the 27 paths is a docs-only change.
- **Risk:** Low. rejected.md forbids moving a row without its test, but correcting the path to the same test does not move the row.

### G9: A local lint plugin for the conventions that have no rule
- **Files:** new `tooling/lint/plugin.ts`, `.oxlintrc.json` `jsPlugins`
- **Rules:**
  - `noSwitch`: 6 src sites (Q1 #4).
  - `typedKeyBy` (Q1 #8).
  - `spanName` (Q1 #9): 3 renames.
  - `disableReason` (Q1 #10).
- **Built-in rules that cost nothing to turn on:** `import/no-cycle` and `unicorn/filename-case` both produce 0 hits.
- **North star:** explicit ("a convention the build cannot check" is the north-star breaker).
- **Risk:** Low. JS plugins are alpha in oxlint (`configuration_schema.json:60`), so pin the oxlint version, which is already done in package.json.

### G10: The docs contradict the code, and no guard catches it
- **Files:** `packages/effect-frame/src/view/view.ts:151`; CONTEXT.md:175-201; README.md:18-20; README's 12 ts blocks; 43 ts blocks in docs
- **Problem:**
  - The view JSDoc prescribes `Effect.fn`, while every app view uses an arrow with `Effect.gen`.
  - CONTEXT.md has 3 duplicate terms.
  - README's "Current state" says "does not yet contain a framework runtime".
  - No check compiles the README or docs code (question 3).
- **North star:** explicit.
- **Change:**
  - Pick one view form and change the JSDoc or the apps to match.
  - Delete the CONTEXT.md duplicates and add the uniqueness check.
  - Add a `docs` check that extracts every fenced `ts`/`tsx` block in README.md into `tooling/checks/consumer/readme/*.tsx`, with a `// @check-skip` opt-out for fragments, and runs `tsc -p` against `dist`.
- **Risk:** Medium. The README blocks are fragments today, so writing the opt-outs is the cost.

### G11: The declarations build is not checked against the exports map (question 3)
- **Files:** `tooling/checks/consumer/declarations.ts:1-11`, `declarations-cli.ts`
- **Problem:**
  - `declarations.ts` scans `packages/*/dist/**/*.d.ts` for `any` and `unknown` requirements.
  - Nothing checks that each `exports[*].types` or `default` exists. All 12 exist today; I checked by hand.
  - Nothing checks that each subpath resolves for a consumer. `consumer/declarations.ts` imports 4 of the 12 subpaths: `actor/client`, `router`, `view` and `view/driven`.
- **North star:** explicit (the shipped surface is proven, not assumed).
- **Change:** `declarations-cli` generates `consumer/subpaths.ts` from `package.json` with one `import * as S<n> from "effect-frame/<key>"` per key, then runs `tsc -p consumer`. A missing or unresolvable `.d.ts` then fails. `publint` or `attw` could come later, after a health check.
- **Risk:** Low.

### G12: turbo `typecheck` inputs miss directories that the tsconfig compiles
- **Files:** `turbo.json:8-16`; `packages/host-durable-object/tsconfig.json` (`include` has `fixture`, `fixture-contract`, `fixture-conformance` and `scripts`)
- **Problem:** A change under `scripts/` or `fixture*/` hits the typecheck cache and passes without being checked.
- **North star:** explicit (a cache key includes every input).
- **Change:** Add a `packages/host-durable-object/turbo.json` that extends `//` and adds those globs, or use `"$TURBO_DEFAULT$"` in the root inputs.
- **Risk:** Low.

### G13: dom-bench is live code with dead code and drift inside it (question 5)
- **Live:** it has 7 test files in the gate, a root `bench` script, and 3 commits on 2026-09-22 (e.g. `db57395`).
- **Dead:** `isCanonicalLabel` (common.ts:113) has no reference anywhere.
- **Exported but used only inside its own file:** `updateEveryTenth`, `swapRows` (common.ts:135 and 138), `CompletionRequest` (completion.ts:18), `BenchOptions` (options.ts:21), `OwnedProcess` (process.ts:5).
- **Drift:**
  - The fixture imports the full actor entry (G7).
  - 14 of 17 files begin with a file-wide `oxlint-disable` of up to 12 rules (e.g. bench.ts:1).
  - 6 of the 75 unused directives are here.
- **North star:** explicit.
- **Change:** Delete `isCanonicalLabel`, un-export the 5 names, and fold the rest into G3 and G7. The file-wide disables are acceptable for a private imperative CLI, but they should be one `.oxlintrc.json` override for `tooling/dom-bench/**`, not 14 headers.
- **Risk:** Low.

### G14: The boundary is proved three times, and scaffold probes remain
- **Files:**
  - `tooling/checks/src/boundary-cli.ts`, `tests/boundary.test.ts:15-24`, `apps/*/tests/boundary.test.ts:19-23`
  - `tooling/checks/src/codec-probe.ts`, `tests/toolchain.test.ts`, the `tooling/checks` `build` script and its `.` export
- **Problem:**
  - Every browser entry is bundled by the CLI and again by the test loop. The 3 app clients are bundled a third time.
  - `codec-probe` is the 2026-09-18 scaffold probe (docs/toolchain.md:5, "covers the scaffold only"). Its `build` script runs a browser bundle in the gate for nothing.
- **North star:** deletion that keeps every north star (the CLI and the app leak-injection tests already carry the proof).
- **Change:**
  - Delete the per-entry loop in `boundary.test.ts:15-24`. Keep the fixture tests there and the leak-injection tests in the apps.
  - Delete `codec-probe.ts`, the `build` script and the `.` export. Keep the finalizer test in `toolchain.test.ts` beside the G2 Bun-pin test, or drop it.
- **Risk:** Low. After G1, the CLI runs in CI.

## Not worth a pass
- Turning on `import/extensions` for `.js`: src already uses it in 622 of 622 relative imports, and `moduleResolution: bundler` accepts both.
- Tests that use `bun:test` directly: 23 files, which are type tests and real-browser or CLI drivers. `effect-bun-test` is used in 111. The split is deliberate.
- Dotted span names such as `Actor.durable.process`: allow them in the G9 regex rather than rename them.
- `func-style`, `no-namespace`, `no-default-export`: 0 to 7 hits. Nothing to gain.
- The `jsx-dev-runtime` to `jsx-runtime` alias (package.json exports): required by JSX tooling. Allowlist it in G5.
