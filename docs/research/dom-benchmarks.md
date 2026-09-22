# DOM and reactivity benchmarks Solid publishes against

Date: 2026-09-21.
Ticket: [Verify which DOM benchmarks Solid publishes against and how to run them locally](https://github.com/cevr/effect-frame/issues/60).
Harness: [Set up the DOM benchmark harness and record the frame against Solid 2 and Octane](https://github.com/cevr/effect-frame/issues/61).
Method: primary source review of benchmark repositories, their READMEs, and their manifests.
Status: research complete. The local harness now has bounded first measurements and
control receipts. The full matrix remains open because one Bun.WebView Chrome
cell exceeded its child-process deadline.

The first receipts are in [dom-bench-results.json](./dom-bench-results.json).
They record Bun.WebView Chrome and WebKit `create-1k` cells for Effect Frame,
Solid 2, and Octane, a standard Chrome same-bundle control, plain DOM and Solid
signals controls, and one successful run through the pinned krausest Playwright
runner. The
`effect-frame/chrome/update-10th-10k` cell has no timing. The harness records
that failure at `/tmp/effect-frame-dom-bench-update-timeout.jsonl` and exits
non-zero for the requested cell.

## Local harness

Run one framework through both required Bun.WebView engines with:

```sh
bun run bench --framework effect-frame --count 1
```

Use `--engine chrome` or `--engine webkit` to select one backend. Use
`--only create-1k` to bound a first check to one workload. Each cell runs in a
child Bun process. `DOM_BENCH_CELL_TIMEOUT_MS` sets the deadline and is capped
at 60 seconds. A timed-out cell writes a JSONL receipt and makes the command
fail.

The `--official` option runs the pinned krausest Playwright runner. Set
`KRAUSEST_DIR` to the checkout and `KRAUSEST_PORT` to its server port. The
option reports the official runner result as a separate measurement.

### Timing boundary and comparability

The local `data:` page intentionally has no Bootstrap stylesheet. The
official staged page links krausest's `/css/currentStyle.css`. This changes
layout and paint work, so local Bun.WebView timings and official runner
timings are separate receipts. They are not a direct comparison.

Chrome tracing starts immediately before the requested click. The page
completion promise checks the expected row ids, order, labels, selection, and
row count after the operation. The harness calls `Tracing.end` only after
that DOM contract completes. The reducer then selects the same-process
click-to-Commit window and drops later host work. Raw Chrome events are kept
under `/tmp/effect-frame-dom-bench-traces/` by default.

| Acceptance cell                                                            | Result                                             |
| -------------------------------------------------------------------------- | -------------------------------------------------- |
| Effect Frame through Bun.WebView Chrome, `create-1k`                       | Passed; 5.468 ms in the recorded sample.           |
| Effect Frame through Bun.WebView WebKit, `create-1k`                       | Passed; 354 ms in the recorded sample.             |
| Solid 2 through Bun.WebView Chrome, `create-1k`                            | Passed; 1,140.851 ms in the recorded sample.       |
| Solid 2 through Bun.WebView WebKit, `create-1k`                            | Passed; 53 ms in the recorded sample.              |
| Octane through Bun.WebView Chrome, `create-1k`                             | Passed; 921.420 ms in the recorded sample.         |
| Octane through Bun.WebView WebKit, `create-1k`                             | Passed; 19 ms in the recorded sample.              |
| Effect Frame bundle through standard Chrome, `create-1k`                   | Passed; six buttons and 1,000 rows.                |
| Plain DOM control, 10,000-row partial update                               | Passed; 1,000 labels changed.                      |
| Solid signals control, 10,000-row partial update                           | Passed; 1,000 labels changed.                      |
| Effect Frame through Bun.WebView Chrome, `update-10th-10k`                 | Failed at the bounded deadline; no timing claimed. |
| Pinned krausest Playwright runner, Effect Frame staged fixture, `01_run1k` | Passed; official runner reported 59.550 ms total.  |
| Pinned krausest Playwright runner, Solid 2 staged fixture, `01_run1k`      | Passed; official runner reported 58.993 ms total.  |
| Pinned krausest Playwright runner, Octane staged fixture, `01_run1k`       | Passed; official runner reported 28.722 ms total.  |
| Full three-framework, two-engine matrix                                    | Open.                                              |

## Result

Solid cites **one** public DOM benchmark for its speed claims: the krausest
`js-framework-benchmark`, linked from the Solid repository README as the
"fast" evidence. Solid does not publish a benchmark of its own. See K0 and S1.

The krausest repository is the only one of the three sources here that
publishes a cross-framework DOM results table under a fixed Chrome version.
Its latest tagged run is `chrome152`. See K5.

**Octane's published table is not the krausest benchmark.** Octane runs its own
20-suite harness inside its own repository, driven by Playwright, and only one
of those 20 suites (`js-framework`) mirrors the krausest operations. Octane's
own README states its numbers "should not be compared directly with the official
benchmark's Chrome timeline measurements". Treat the Octane table as a
self-published in-repo measurement, not as a krausest result. See O2, O4, and O6.

Two premises in the ticket are wrong, and the correction matters for any plan
built on them:

1. **There is no Solid 2 implementation in the krausest repository.** Both
   `frameworks/keyed/solid` and `frameworks/keyed/solid-store` declare
   `solid-js: ^1.9.3`. The `s2` directory is unrelated (it is `s2-engine` by
   `gr0uch`). A Solid 2 column in a krausest table does not exist today and
   would have to be contributed. See K6.
2. **The krausest `clear` operation starts from 10,000 rows, not 1,000.** The
   1,000-row clear is a separate diagnostic that only Octane's harness runs,
   under `CLEAR_1K=1`. See K1 and O5.

For signal-graph work the relevant source is milomg's `js-reactivity-benchmark`.
Its README command `pnpm bench` **no longer resolves**: the repository was
restructured into a pnpm workspace whose root manifest declares only `format`.
The runnable path is the `packages/node` build-then-run pair. See R1 and R3.

**Solid 2 is already measured there**, as the adapter named `x-reactivity`,
which imports `@solidjs/signals`. The row labelled `SolidJS` is Solid 1. Do not
add a second Solid 2 adapter without checking this. See R7.

**Trust the krausest code over its README.** The README is wrong about the
warmup counts, wrong about the driver being chromedriver, and stale about the
memory metrics and the `npm run index` script. Each is corrected in place below,
against `webdriver-ts/src/`. See K8 and K9.

## Source versions

| Source                           | Pinned revision or tag                                    | Meaning                                                                |
| -------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------- |
| krausest js-framework-benchmark  | `f2df01a8679de05225c32714ca8cecbea3d78c5d` (master)       | 191 keyed and 67 non-keyed directories. Latest tagged run `chrome152`. |
| Octane                           | `octane@0.2.7` in the krausest entry; `main` for the repo | Octane's own repo holds the 20-suite table.                            |
| milomg js-reactivity-benchmark   | `main`                                                    | pnpm workspace: `packages/core`, `packages/node`, `packages/web`.      |
| Solid in krausest                | `solid-js: ^1.9.3`                                        | Solid 1, not Solid 2.                                                  |
| Solid in Octane's fixtures       | `solid-js: 2.0.0-beta.20`, `@solidjs/web: 2.0.0-beta.20`  | Solid 2 beta, pinned through the pnpm catalog.                         |
| Solid in js-reactivity-benchmark | `solid-js: ^1.9.11`; also `@solidjs/signals: ^0.10.2`     | The active Solid adapter imports `solid-js`.                           |

Commands used: `curl` against `raw.githubusercontent.com` and the GitHub
contents API. See K0, O0, R0.

## 1. The krausest js-framework-benchmark

Repository: <https://github.com/krausest/js-framework-benchmark>.
Official results: <https://krausest.github.io/js-framework-benchmark/index.html>.
See K0 and K2.

Size, with a discrepancy left open: the contents API returns **191 directories
under `frameworks/keyed` and 67 under `frameworks/non-keyed`** — 258 in total,
every entry a directory, neither listing truncated. The README states "186
implementations" twice. Those two figures do not reconcile, and 186 is not a
stale directory count, since 191 keyed directories alone exceed it. Either the
README counts something narrower than a directory, or it is out of date. This
review did not determine which, and no conclusion here depends on it. See K0
and K1.

### Measured operations

The README lists nine duration benchmarks. **The README's warmup column is
wrong**: it claims "no warmup" for create, create many, append and clear, but
`webdriver-ts/src/benchmarksCommon.ts` sets `warmupCount: 5` on every CPU
benchmark and `warmupCount: 3` on partial update. Trust the code. The table
below gives both. See K1 and K8.

| Operation                  | What it measures                                         | README says  | Code says |
| -------------------------- | -------------------------------------------------------- | ------------ | --------- |
| create rows                | Create 1,000 rows after page load.                       | no warmup    | 5         |
| replace all rows           | Replace all 1,000 rows of the table.                     | 5 iterations | 5         |
| partial update             | Update the text of every 10th row, table of 10,000 rows. | 5 iterations | **3**     |
| select row                 | Highlight a row in response to a click.                  | 5 iterations | 5         |
| swap rows                  | Swap 2 rows on a table of 1,000 rows.                    | 5 iterations | 5         |
| remove row                 | Remove a row from a table of 1,000 rows.                 | 5 iterations | 5         |
| create many rows           | Create 10,000 rows.                                      | no warmup    | 5         |
| append rows to large table | Add 1,000 rows to a table of 10,000 rows.                | no warmup    | 5         |
| clear rows                 | Clear the table **filled with 10,000 rows**.             | no warmup    | 5         |

The README also lists five memory metrics, but **three of them are commented out
in the code**: `_23` (update 1k, 5 cycles), `_24` (replace 1k, 5 cycles) and
`_26` (run memory 10k). Only `_21 ready memory`, `_22 run memory` and `_25`
(creating and clearing 1k rows, 5 cycles) are active. The five startup metrics
are startup time plus the Lighthouse metrics consistently interactive, script
bootup time, main thread work cost, and total byte weight. Duration is measured
including rendering time, from Chrome timeline entries. Since Chrome 118 the
overall score is a **weighted geometric mean**. See K1 and K8.

Default iteration counts, from `webdriver-ts/src/common.ts`: **15** CPU
iterations per benchmark, and 1 each for memory, startup and size. `--count N`
overrides CPU, memory and startup together. See K8.

### Keyed versus non-keyed

The repository's own definition: a framework is keyed when it creates a 1:1
relationship between a data item and a DOM node by assigning a `key` attribute
(or Angular's `trackBy`). Any update to the data updates the associated DOM
node, and reordering the list reorders the DOM nodes. Implementations live under
`frameworks/keyed/<name>` and `frameworks/non-keyed/<name>`. The repository
ships a checker: `npm run isKeyed keyed/<name>` reports an ERROR on
misclassification. See K1 and K3.

### Adding an implementation under `frameworks/keyed/<name>`

The minimum contract is: a directory that supports `npm install` and
`npm run build-prod`, and that can then be opened in the browser. Everything
else is optional. See K4.

Required `package.json` metadata block:

```json
"js-framework-benchmark": {
  "frameworkVersionFromPackage": "react",
  "frameworkHomeURL": "https://www.reactjs.org",
  "language": "JavaScript"
}
```

`frameworkVersionFromPackage` names the npm package whose installed version is
read from `package-lock.json` to build the version string. Several packages are
joined with a colon, as in `"react:redux"`. A framework not pulled from npm
hardcodes `"frameworkVersion": "0.0.1"` instead. Optional fields are
`"customURL": "/target/web/stage"`, `"useShadowRoot": true`, and
`"includeInBuild"` — a colon-separated list of output paths relative to the
framework directory, used when the build does not emit to `dist/`. See K4.

Build output: `npm run zip` includes `dist/` and `package-lock.json` per
framework by default; declare anything else with `includeInBuild`. See K4.

The README documents only `frameworkVersion`, `frameworkVersionFromPackage`,
`frameworkHomeURL`, `language`, `customURL`, `useShadowRoot` and
`includeInBuild`. Further fields are real but undocumented: `FrameworkData` in
`webdriver-ts/src/common.ts` declares `useRowShadowRoot`, `shadowRootName`,
`buttonsInShadowRoot`, `startLogicEventName` and `issues: number[]`, and
`repoURL` is used by the shipped `solid` and `octane` manifests. A `type` field
appears in neither the README nor any manifest inspected here — treat it as
non-existent until shown otherwise. See K4, K6 and K8.

The `index.html` must link the shared stylesheet
`<link href="/css/currentStyle.css" rel="stylesheet" />`, must not use shadow
DOM (it blocks the global Bootstrap CSS and is "a real pain for webdriver"), and
must carry six buttons whose ids the driver depends on: `run` (Create 1,000
rows), `runlots` (Create 10,000 rows), `add` (Append 1,000 rows), `update`
(Update every 10th row), `clear` (Clear), `swaprows` (Swap Rows). Rows render
into `<table class="table table-hover table-striped test-data">`, inside
`<div id="main">`. Row `id` must start at `1` and increment continuously,
resetting only on page reload. Do not change the ids — the automated
benchmarking relies on them. See K4.

Two further `index.html` requirements are easy to miss and both cost you:

- **Preload the glyphicon**, or "you will get terrible performance":
  `<span class="preloadicon glyphicon glyphicon-remove" aria-hidden="true"></span>`.
- **The rendered HTML must be byte-identical to vanillajs**, including every
  `aria-hidden` attribute. Otherwise the implementation "is considered erroneous
  and will be marked with issue #634".

See K4.

Contribution rules also require fixed version numbers (no ranges), locally
listed npm dependencies, use of the root `css` Bootstrap, and no committed
result files. Validate with `npm run rebuild-ci keyed/<name>` from the root.
Note the existing `keyed/solid` entry violates the fixed-version rule with caret
ranges throughout, so it is not a clean template. See K4 and K6.

Style choices that attach a "note" to your published results: over-optimization,
`requestAnimationFrame` in client code (#796), manual DOM manipulation (#772),
per-row selection flags rather than one selection reference (#800), and explicit
event delegation in client code (#801). See K4.

### Running one framework locally

Node.js `>=v20.9.0` is required; the benchmark was tested with `v20.9.0`.
See K3.

```sh
# 0. Optional: check out a tagged release matching a Chrome version.
git checkout chrome152 -b release

# 1. Root dependencies and the local web server.
npm ci
npm run install-server

# 2. Start the server in the root directory, and leave it running.
npm start
# verify http://localhost:8080/index.html

# 3. In a second terminal, build the framework.
cd frameworks/keyed/vanillajs
npm ci
npm run build-prod
# verify http://localhost:8080/frameworks/keyed/vanillajs/

# 4. Build and run the driver.
cd ../../../webdriver-ts
npm ci
npm run compile
npm run bench keyed/vanillajs

# 5. Optional: confirm the keyed/non-keyed classification.
npm run isKeyed keyed/vanillajs

# 6. Build the results table.
cd ../webdriver-ts-results
npm ci
cd ../webdriver-ts
npm run results
# open http://localhost:8080/webdriver-ts-results/dist/index.html
```

**The default driver is Puppeteer, not chromedriver.** The README's section 2.4
says "using chromedriver", but the code contradicts it: `common.ts` declares
`enum BenchmarkRunner { PUPPETEER, PLAYWRIGHT, WEBDRIVER_CDP,
WEBDRIVER_AFTERFRAME }` and sets `BENCHMARK_RUNNER: BenchmarkRunner.PUPPETEER`,
and `benchmarkRunner.ts` declares `.default("runner", "puppeteer")`. All four
drivers are selectable with `--runner`; `chromedriver`, `playwright`,
`puppeteer-core` and `selenium-webdriver` are all installed dependencies. The
directory is still named `webdriver-ts` for historical reasons, and there is no
`puppeteer-ts` directory. `webdriver-ts-results` is the React app that renders
the table. Trust the code over the README prose here. See K8 and K9.

Keep the Chrome window visible: otherwise paint events can be skipped, producing
wrong results. Per-run JSON lands in `webdriver-ts/results/`, one file per
framework and benchmark, for example `results/vanillajs-keyed_01_run1k.json`.
See K3.

Useful selectors, run from `webdriver-ts`. See K3.

```sh
npm run bench keyed/angular keyed/react
npm run bench -- --benchmark 01_ 02_ --framework keyed/vanillajs keyed/react-hooks
npm run bench -- --framework keyed/<name>
npm run bench -- --chromeBinary /usr/bin/google-chrome
```

### Chrome version and run cost

The repository tags a release per Chrome version. Tags present include
`chrome152`, `chrome150`, `chrome148`, `chrome146`, `chrome145`, `chrome144`,
`chrome143`, `chrome142`; `chrome152` is the newest, so the current official
run drives **Chrome 152**. Contributions may target "the latest stable chrome"
for web features and language level. See K5 and K4.

Run cost, as the README states it: **one framework takes "a couple of minutes"**
— "The benchmark runner will open and close Chrome multiple times. The whole
thing will take a couple of minutes." Running **every** framework takes
"currently about 12 hours on my machine". Those are the only two wall-clock
figures published; no per-benchmark breakdown exists, and none is derived here.
See K3.

The pinned `chromedriver` dependency on master is `150.0.1`, which suggests
master currently drives Chrome 150 even though the newest published run is
Chrome 152. That is an inference from a dependency pin, not a stated fact. See
K9.

## 2. js-reactivity-benchmark (milomg)

Repository: <https://github.com/milomg/js-reactivity-benchmark>. See R0.

### What it measures

Signal-graph propagation, not DOM. The README states the benchmark exists
because the prior art (S.js `bench.js`, CellX `perf.html`) focuses on creation
time and update time for a _static_ graph and is not configurable. This one adds
a configurable dependency graph — graph shape, density, and read rate are all
adjustable — and supports dynamic reactive nodes. It uses v8 intrinsics to warm
up and clean up, tracks garbage-collection overhead per test, and outputs CSV.
See R1.

The published chart rows enumerate the suites: `avoidablePropagation`,
`broadPropagation`, `deepPropagation`, `diamond`, `mux`, `repeatedObservers`,
`triangle`, `unstable`, `molBench`, `createSignals`, `createComputations`,
`updateSignals`, `cellx1000`, and the configurable graph cases
`2-10x5 - lazy80%`, `6-10x10 - dyn25% - lazy80%`, `4-1000x12 - dyn5%`,
`25-1000x5`, `3-5x500`, `6-100x15 - dyn50%`. The first eight are the kairo
suite; `cellx1000` and `molBench` are the ported CellX and mol benchmarks.
Source files confirm the grouping: `packages/core/src/benches/` holds
`cellxBench.ts`, `kairoBench.ts`, `sBench.ts`, and the `kairo` and `reactively`
directories. See R1 and R2.

### Adding a reactive library adapter

Implement `ReactiveFramework` from
`packages/core/src/util/reactiveFramework.ts`. The interface is small. See R4.

```ts
export interface ReactiveFramework {
  name: string;
  signal<T>(initialValue: T): Signal<T>;
  computed<T>(fn: () => T): Computed<T>;
  effect(fn: () => void): void;
  withBatch<T>(fn: () => T): void;
  withBuild<T>(fn: () => T): T;
  cleanup(): void;
}

export interface Signal<T> {
  read(): T;
  write(v: T): void;
}

export interface Computed<T> {
  read(): T;
}
```

Place the adapter in `packages/core/src/frameworks/<name>.ts`, then register it
in `packages/core/src/frameworksList.ts` by importing the exported object and
appending an entry to both `frameworkInfo` and `allFrameworks`:

```ts
{ framework: myFramework, testPullCounts: true }
```

`testPullCounts` is omitted when the library cannot support it. The Solid entry
carries the in-repo comment "solid can't testPullCounts because batch executes
all leaf nodes even if unread". Add the library to `devDependencies` of
`packages/core/package.json`. See R5 and R2.

**Solid 2's reactivity is already in this benchmark, under a misleading name.**
The adapter called `x-reactivity` imports from `@solidjs/signals` — that is
Solid 2's signal core, not a third-party library — and `packages/core` declares
`"@solidjs/signals": "^0.10.2"`. Its `effect` uses the two-function Solid 2
signature, `createEffect(fn, () => {})`, and its `withBatch` is `fn(); flush();`.
So the `SolidJS` row in the published charts is Solid 1, and the `x-reactivity`
row is Solid 2. Check this before adding any Solid 2 adapter: a duplicate would
measure what is already measured. See R7.

The shipped Solid adapter shows the expected shape, including how `withBuild`
installs the disposer:

```ts
withBuild: (fn) =>
  createRoot((dispose) => {
    solidFramework.cleanup = dispose;
    return fn();
  }),
```

See R4.

### Running it

The README's single documented command is `pnpm bench`. **That command does not
resolve against the current source**: the root `package.json` declares only a
`format` script, and none of `packages/core`, `packages/node`, or `packages/web`
declares a `bench` script. Treat the README command as stale. See R1 and R3.

From the manifests, the runnable Node path is:

```sh
pnpm install
pnpm --filter js-reactivity-benchmark build        # packages/core, esbuild + tsc
pnpm --filter js-reactivity-benchmark-node build   # packages/node, esbuild bundle
pnpm --filter js-reactivity-benchmark-node run     # node dist/index.js
```

`packages/node/src/index.ts` runs `runTests(frameworkInfo, logPerfResult)` and
prints a header row plus one formatted line per framework and test, with times
to two decimals. The browser path is `packages/web` (`vite dev` / `build` /
`preview`), plus a `chrome` script that launches Chrome with profiling flags
(`--prof`, `--expose-gc`, `--enable-precise-memory-info`) against
`http://localhost:3000`. See R3 and R6.

**Not verified:** that this four-command sequence completes, and the per-run
duration. The commands are read off the manifests, not from documentation that
states them as the run procedure, and they were not executed.

## 3. What Solid and Octane cite

### Solid

The Solid repository README links the krausest results page twice: once as the
word "fast" in its feature list, and once in its performance paragraph — "Solid's
performance is almost indistinguishable from optimized vanilla JavaScript (See
Solid on the [JS Framework Benchmark](https://krausest.github.io/js-framework-benchmark/current.html))".
Both point at `https://krausest.github.io/js-framework-benchmark/current.html`.
See S1.

**Not verified:** what `https://www.solidjs.com/` displays. The fetched document
is a 3,584-byte client-rendered shell containing no occurrence of the string
"benchmark", so its live claims cannot be read without executing its JavaScript.
The repository README above is the citable first-party source. See S2.

### Octane's published table

Octane's benchmarks page states the method directly: "Every chart is the
checked-in baseline from the repo's own suites: same apps, same hardware, same
run. … Reproduce them with `pnpm bench:all`, and see `benchmarks/` for what each
suite measures." So the published table is produced **inside the Octane
repository**, not from the krausest repository. See O2.

The root manifest confirms the script: `"bench:all": "node benchmarks/bench.mjs"`.
See O3.

The 20 suites in the "Every suite at a glance" table are, in the order the table
prints them:

`js-framework`, `uibench`, `todomvc`, `weather-app`, `weather-app-lighthouse`,
`chat-stream`, `svg-dashboard`, `js-framework-reorder`, `dbmon`,
`effectful-list`, `memo-wall`, `recursive-context`, `spa-navigation`,
`signal-favoring`, `portal-swarm`, `async-waterfall`, `news`, `streaming-ssr`,
`bundle-size`, `ssr-throughput`.

That is exactly 20 rows, followed by a `geomean` row. The page defines each
cell as "that framework's score relative to Octane (1×), geometric mean across
the suite's operations", so the headline figure is a geometric mean **of
per-suite geometric means**. The framework columns are Octane (.tsrx), React 19

- Compiler, Preact 10, Solid 2.0 beta, Svelte 5, Ripple 0.3, Vue Vapor 3.6 RC,
  and Inferno 9. Several cells are `—`, so not every suite covers every framework.
  See O4.

The `js-framework` suite is described on the same page as "krausest-style table
operations over 1,000 rows — create, replace, partial update, select, swap,
remove, clear", with per-operation columns `run`, `replace`, `add`, `update`,
`select`, `swap`, `remove`, `runlots`, `select_lots`, `clear`. Note `select_lots`
— a 10,000-row selection operation alternating rows 5,000 and 5,001 — has no
counterpart in the krausest suite. See O4 and O5.

The suite's own README confirms the relationship and the driver: it "mirrors the
canonical js-framework-benchmark suite, plus a keyed-reorder matrix extension
(`run-reorder.mjs`)", and "times each operation via Playwright". Its Solid
fixture is described as "Solid 2.0 (keyed `<For>`, production build)" on port 5179. See O5 and O6.

Octane's own caveat, stated in that README: the in-page click timer "excludes
paint and browser automation latency; its numbers should not be compared
directly with the official benchmark's Chrome timeline measurements." See O5.

Octane's runner details, from `benchmarks/README.md`: `bench.mjs` boots the
servers, drives every harness, collects machine-readable results, and enforces
regressions. Suites run **sequentially** so ports and CPU never contend. Results
land in `benchmarks/results/<suite>.json` (gitignored). Regression flags are
`--record`, `--compare`, `--ratios`, `--quick`, `--baseline-dir=`, and
`--results-dir=`. CI enforces `--ratios` only, via
`node benchmarks/bench.mjs --quick --ratios` on manual dispatch plus a weekly
cron. See O2.

```sh
node benchmarks/bench.mjs                          # every suite, normal iterations
node benchmarks/bench.mjs js-framework memo-wall   # only these suites
node benchmarks/bench.mjs --quick js-framework     # reduced-iteration smoke pass
node benchmarks/bench.mjs --list                   # list suite names
pnpm bench:all -- --quick                          # same via the root script
```

See O2.

For the `js-framework` suite specifically, the 1,000-row clear diagnostic and
its sample counts are documented: `CLEAR_1K=1` with `run.mjs` "defaults to 5
warmups and 15 measured samples", and `CPU_THROTTLE=4` applies Chromium's 4×
CPU throttle. See O5.

**Not verified:** which Chrome or Node version Octane's published table was
produced on. Neither the benchmarks page nor `benchmarks/README.md` names one,
and no `Chrome` or `Node` version string appears in the fetched benchmarks page.
Octane's own install note says its published packages need Node.js 22.22.2 or
newer, which is a package requirement, not a statement about the benchmark
machine. See O7.

## 4. Existing Solid 2 and Octane implementations in krausest

Listing `frameworks/keyed` via the GitHub contents API returns 186 entries. The
ones relevant here are `octane`, `solid`, `solid-store`, and `s2`. Listing
`frameworks/non-keyed` returns no `solid` or `octane` entry at all. See K6.

| Directory                      | Declared framework version | Verdict                                        |
| ------------------------------ | -------------------------- | ---------------------------------------------- |
| `frameworks/keyed/octane`      | `octane: 0.2.7`            | Octane is present and keyed.                   |
| `frameworks/keyed/solid`       | `solid-js: ^1.9.3`         | **Solid 1.** Not Solid 2.                      |
| `frameworks/keyed/solid-store` | `solid-js: ^1.9.3`         | **Solid 1**, store variant. Not Solid 2.       |
| `frameworks/keyed/s2`          | `s2-engine: ^1.0.17`       | Unrelated. `s2-engine` by `gr0uch`, not Solid. |

So: **Octane yes, Solid 2 no.** Adding a Solid 2 column to the krausest table
requires contributing a new implementation.

The Octane entry's metadata block, verbatim:

```json
"js-framework-benchmark": {
  "frameworkVersionFromPackage": "octane",
  "frameworkHomeURL": "https://octanejs.dev/",
  "language": "TypeScript",
  "repoURL": "https://github.com/octanejs/octane"
}
```

It builds with Vite (`"build-prod": "vite build"`, `vite 8.1.5`,
`@octanejs/vite-plugin 0.1.54`, `terser 5.49.0`). Its `index.html` is minimal —
a `<link href="/css/currentStyle.css">`, a `<div id="main">`, and
`<script src="dist/main.js">` — so the buttons and table are rendered by the
framework rather than written as static markup. That is the pattern to copy for
a Solid 2 entry. See K6 and K7.

The Solid entry's metadata block, verbatim:

```json
"js-framework-benchmark": {
  "frameworkVersionFromPackage": "solid-js",
  "frameworkHomeURL": "https://www.solidjs.com/",
  "language": "JavaScript",
  "repoURL": "https://github.com/solidjs/solid"
}
```

It builds with Rollup (`"build-prod": "rollup -c --environment production"`) and
`babel-preset-solid ^1.9.3`. A Solid 2 entry could not reuse this toolchain
unchanged: Solid 2 moves the web renderer to `@solidjs/web` and needs the Solid 2
compiler line. Octane's own fixture for Solid 2 pins
`solid-js: 2.0.0-beta.20`, `@solidjs/web: 2.0.0-beta.20`,
`babel-preset-solid: 2.0.0-beta.20`, and
`vite-plugin-solid: 3.0.0-next.5` — a usable reference for what a Solid 2
krausest entry would have to declare. See K6 and O8.

## Limits of this review

Performed: reads of repository READMEs, contribution docs, package manifests,
the Octane benchmarks page, the Octane benchmarks README and its `js-framework`
suite README, the reactivity benchmark's adapter interface and registration
list, and GitHub contents-API directory listings.

The bounded harness ran selected Bun.WebView and control cells. It did not
complete the full three-framework, two-engine matrix. Every local duration is
specific to the machine, browser build, driver, page markup, and workload
receipt recorded above.

Not established: the Chrome and Node versions behind Octane's published table;
whether the four-command `js-reactivity-benchmark` sequence completes; what
`solidjs.com` renders at runtime; the exact geomean implementation in Octane's
`benchmarks/bench.mjs` and `benchmarks/lib/`, which were not read; and whether
the krausest metadata field `type` exists at all — it appears in no README text
and in no manifest inspected here. The fields `issues` and `useRowShadowRoot`
are undocumented in the README but real: both are declared on `FrameworkData` in
`webdriver-ts/src/common.ts`, as is `repoURL` usage in practice.

The krausest README's own wall-clock figures ("a couple of minutes" for one
framework, "about 12 hours" for all) are quoted, not measured here.

## Primary source inventory

- **K0 — Repository, revision, directory counts.** master `f2df01a8679de05225c32714ca8cecbea3d78c5d`, via `https://api.github.com/repos/krausest/js-framework-benchmark/commits/master`. [Repository](https://github.com/krausest/js-framework-benchmark). Counts checked 2026-09-21 against `https://api.github.com/repos/krausest/js-framework-benchmark/contents/frameworks/keyed` and `.../non-keyed`: 191 and 67 entries, all of `"type": "dir"`.
- **K1 — Operations, memory and startup metrics, weighted geometric mean.** [README, "About the benchmarks"](https://github.com/krausest/js-framework-benchmark/blob/master/README.md). Linked method notes: [how the duration is measured](https://github.com/krausest/js-framework-benchmark/wiki/How-the-duration-is-measured), [weighted geometric mean](https://github.com/krausest/js-framework-benchmark/wiki/Computation-of-the-weighted-geometric-mean).
- **K2 — Official results page.** <https://krausest.github.io/js-framework-benchmark/index.html>, named in the README's "Official results" section.
- **K3 — Keyed definition, node version, local run sequence, driver, result JSON, selector flags.** README sections 2.2 through 2.6 and section 3, [README](https://github.com/krausest/js-framework-benchmark/blob/master/README.md).
- **K4 — Contribution contract: build scripts, metadata block, `includeInBuild`, `index.html` ids and table markup, row-id rule, submission rules.** README sections 4.1 through 4.4, [README](https://github.com/krausest/js-framework-benchmark/blob/master/README.md). `customURL` example: [ember package.json](https://github.com/krausest/js-framework-benchmark/blob/master/frameworks/keyed/ember/package.json#L10).
- **K5 — Chrome version tags.** `https://api.github.com/repos/krausest/js-framework-benchmark/tags` returned `chrome152`, `chrome150`, `chrome148`, `chrome146`, `chrome145`, `chrome144`, `chrome143`, `chrome142`. Archive notes in the README reference [chrome 152 results](https://krausest.github.io/js-framework-benchmark/2026/chrome152.html).
- **K6 — Directory listings and manifests.** `https://api.github.com/repos/krausest/js-framework-benchmark/contents/frameworks/keyed` and `.../non-keyed`. [octane package.json](https://github.com/krausest/js-framework-benchmark/blob/master/frameworks/keyed/octane/package.json), [solid package.json](https://github.com/krausest/js-framework-benchmark/blob/master/frameworks/keyed/solid/package.json), [solid-store package.json](https://github.com/krausest/js-framework-benchmark/blob/master/frameworks/keyed/solid-store/package.json), [s2 package.json](https://github.com/krausest/js-framework-benchmark/blob/master/frameworks/keyed/s2/package.json).
- **K7 — Octane entry contents.** `https://api.github.com/repos/krausest/js-framework-benchmark/contents/frameworks/keyed/octane` returned `index.html`, `package-lock.json`, `package.json`, `src`, `vite.config.js`. [index.html](https://github.com/krausest/js-framework-benchmark/blob/master/frameworks/keyed/octane/index.html).
- **K8 — Runner defaults, iteration counts, warmup counts, disabled memory benchmarks.** [webdriver-ts/src/common.ts](https://github.com/krausest/js-framework-benchmark/blob/master/webdriver-ts/src/common.ts): `enum BenchmarkRunner`, `BENCHMARK_RUNNER: BenchmarkRunner.PUPPETEER`, `NUM_ITERATIONS_FOR_BENCHMARK_CPU: 15`, and the mem/startup/size counts of 1. [webdriver-ts/src/benchmarksCommon.ts](https://github.com/krausest/js-framework-benchmark/blob/master/webdriver-ts/src/benchmarksCommon.ts): `warmupCount: 5` on every CPU benchmark, `warmupCount: 3` on partial update, and the commented-out `_23`, `_24`, `_26` memory benchmarks.
- **K9 — CLI defaults and installed drivers.** [webdriver-ts/src/benchmarkRunner.ts](https://github.com/krausest/js-framework-benchmark/blob/master/webdriver-ts/src/benchmarkRunner.ts): `.string("runner").default("runner", "puppeteer")` and the `args.count` override. [webdriver-ts/package.json](https://github.com/krausest/js-framework-benchmark/blob/master/webdriver-ts/package.json): `chromedriver 150.0.1`, `playwright 1.61.1`, `puppeteer-core 25.3.0`, `selenium-webdriver 4.45.0`, `lighthouse 13.4.0`.
- **S1 — Solid's cited benchmark.** [solidjs/solid README](https://github.com/solidjs/solid/blob/main/README.md), lines linking `https://krausest.github.io/js-framework-benchmark/current.html` in the feature list and the performance paragraph.
- **S2 — solidjs.com shell.** `https://www.solidjs.com/` returned 3,584 bytes with zero occurrences of "benchmark"; client-rendered, so unverifiable by fetch.
- **O0 — Octane repository.** <https://github.com/octanejs/octane>. [README](https://github.com/octanejs/octane/blob/main/README.md) — describes Octane as the successor to Inferno, status beta; contains no performance-benchmark section.
- **O2 — Benchmarks page method, runner, flags, CI policy.** <https://octanejs.dev/benchmarks>; [benchmarks/README.md](https://github.com/octanejs/octane/blob/main/benchmarks/README.md) for the runner contract, sequential execution, results paths, regression flags, and `.github/workflows/bench.yml` policy.
- **O3 — `bench:all` script.** [root package.json](https://github.com/octanejs/octane/blob/main/package.json): `"bench:all": "node benchmarks/bench.mjs"`.
- **O4 — The 20 suites, the geomean row, the framework columns, the `js-framework` operation columns.** <https://octanejs.dev/benchmarks>, "Every suite at a glance" table.
- **O5 — `js-framework` suite README.** [benchmarks/js-framework/README.md](https://github.com/octanejs/octane/blob/main/benchmarks/js-framework/README.md): mirrors krausest, Playwright driver, port map, quick start, `CLEAR_1K=1` with 5 warmups and 15 samples, `CPU_THROTTLE=4`, the non-comparability caveat, and the `select_lots` definition.
- **O6 — Solid fixture.** [benchmarks/js-framework/solid/package.json](https://github.com/octanejs/octane/blob/main/benchmarks/js-framework/solid/package.json): "js-framework-benchmark fixture for Solid 2.0 (keyed `<For>` over a createSignal row array)", depends on `solid-js` and `@solidjs/web` via `catalog:default`.
- **O7 — Node requirement.** [README](https://github.com/octanejs/octane/blob/main/README.md): "Octane's published packages need Node.js 22.22.2 or newer." No Chrome version is stated anywhere fetched.
- **O8 — Solid 2 pins.** [pnpm-workspace.yaml](https://github.com/octanejs/octane/blob/main/pnpm-workspace.yaml): `solid-js: '2.0.0-beta.20'`, `'@solidjs/web': '2.0.0-beta.20'`, `babel-preset-solid: '2.0.0-beta.20'`, `babel-plugin-jsx-dom-expressions: '0.50.0-next.14'`, `vite-plugin-solid: '3.0.0-next.5'`.
- **R0 — Repository.** <https://github.com/milomg/js-reactivity-benchmark>.
- **R1 — Purpose, features, suite names.** [README](https://github.com/milomg/js-reactivity-benchmark/blob/main/README.md): configurable graph, dynamic nodes, v8 intrinsics, GC tracking, CSV output, `pnpm bench`, and the chart's suite rows.
- **R2 — Suite files.** `https://api.github.com/repos/milomg/js-reactivity-benchmark/contents/packages/core/src/benches` returned `cellxBench.ts`, `kairo`, `kairoBench.ts`, `reactively`, `sBench.ts`.
- **R3 — Workspace manifests.** [root package.json](https://github.com/milomg/js-reactivity-benchmark/blob/main/package.json) (only `format`), [packages/core/package.json](https://github.com/milomg/js-reactivity-benchmark/blob/main/packages/core/package.json), [packages/node/package.json](https://github.com/milomg/js-reactivity-benchmark/blob/main/packages/node/package.json), [packages/web/package.json](https://github.com/milomg/js-reactivity-benchmark/blob/main/packages/web/package.json).
- **R4 — Adapter interface and Solid adapter.** [util/reactiveFramework.ts](https://github.com/milomg/js-reactivity-benchmark/blob/main/packages/core/src/util/reactiveFramework.ts), [frameworks/solid.ts](https://github.com/milomg/js-reactivity-benchmark/blob/main/packages/core/src/frameworks/solid.ts).
- **R5 — Registration point.** [frameworksList.ts](https://github.com/milomg/js-reactivity-benchmark/blob/main/packages/core/src/frameworksList.ts): `frameworkInfo` and `allFrameworks`, plus the `testPullCounts` comment on the Solid entry.
- **R7 — `x-reactivity` is Solid 2.** [frameworks/xReactivity.ts](https://github.com/milomg/js-reactivity-benchmark/blob/main/packages/core/src/frameworks/xReactivity.ts) imports `flush, createEffect, createMemo, createRoot, createSignal` from `@solidjs/signals`, with `createEffect(fn, () => {})` and `withBatch: (fn) => { fn(); flush(); }`. The dependency `"@solidjs/signals": "^0.10.2"` is declared in [packages/core/package.json](https://github.com/milomg/js-reactivity-benchmark/blob/main/packages/core/package.json).
- **R6 — Node entry output.** [packages/node/src/index.ts](https://github.com/milomg/js-reactivity-benchmark/blob/main/packages/node/src/index.ts): `runTests(frameworkInfo, logPerfResult)` with a header row and two-decimal times.
