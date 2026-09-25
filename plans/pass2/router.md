# Architecture pass 2: `packages/effect-frame/src/router`

Tree: `~/Developer/personal/.worktrees/effect-frame-arch-pass2`, branch `arch-pass2`. This pass was read only. No repo file was edited and no server was started. Probes are in the scratchpad under `pass2-router/` (`probe.ts`, `race.ts`, `race-fixed.ts`). They ran with Bun 1.4.2 and `--conditions=source`.

Short forms:

- `G <re>` means `grep -rnE <re> packages apps tooling --include='*.ts' --include='*.tsx' | grep -v node_modules | grep -v /dist/`.
- "src" means `packages/effect-frame/src`, and "br" means `src/router/branch.ts`.
- EGW means `/home/exedev/Developer/personal/bible-tools/apps/egw-search` at `4008b04a`.

Checked against the ledger. Pass 1 R11 (the route brand holds the mode) and V10 (LazyView and DrivenView carry their data) are done, and this report uses both as precedent. R11 also said "longer term, Match carries the route value". That was never applied and returns here as batch F. No item below is on `rejected.md`. The private shadow constructors in `leave-branch.ts` (issue #56) are left alone.

---

## Q1: the module-level side-channel maps

### Re-grep

Pattern: `grep -rnE "^(export )?const \w+ *(:[^=]*)?= *new (Weak)?(Map|Set)" packages/*/src`

Module-level WeakMaps in `packages/*/src`:

- the 16 on the carry-over list, all in `src/router`;
- `actor/command-id.ts:35` `minted`, which is A18 and kept.

There are no others. The remaining module-level `Map` and `Set` values hold fixed tables, not state:

- `router/leaf-root.ts:78,84`
- `view/form.ts:297-298`
- `view/hosts/html.ts:66`
- `actor/form.ts:152`
- `inspect/src/gateway.ts:189`
- `host-durable-object/src/route.ts:31`

`grep -rnE "^(export )?let |globalThis" packages/effect-frame/src` finds nothing. `view/lazy.ts:71` `Tickets` is a `Context.Reference`, which is already the Effect form. The list is complete.

Every map is keyed by a value that the writer returns to the caller and that the caller holds: a route, an `Entered`, a `LocationService`, a `RouterService`, a segment, a branch, an `Inputs`, or a Schema. So each one passes the deletion test in the same way. The data can ride on the key value itself, as pass 1 did for `LazyView.definition` (`view/lazy.ts:90-93`), `DrivenView.driven` (`router/driven.tsx:68-73`), `Entered.inspection` (`codec.ts:513-514`) and the mode under `RouteBrand` (`codec.ts:529-537`).

### Two reproduced defects

These give the carry-over a receipt beyond style (`pass2-router/probe.ts`).

1. **A spread route loses its checks.** For a route whose segment has `before`, the probe prints `checks on base: true checks on spread: false`.
   - Object spread copies the `RouteBrand` symbol (`codec.ts:529`), so the copy is still a branded route.
   - The `checkers` entry (`check.ts:90-94`) is keyed by the old object, so the copy has no checks. A guarded route silently becomes an unguarded one.
   - The repo already spreads a route: `packages/effect-frame/tests/router/inspection.test.tsx:390` does `{ ...base, enter }`.
   - A `LocationService` spread has the same hazard. `browser-commit.ts:463` spreads `browserLocation` and has to call `registerSurface` again (`:479`), because the spread drops the surface that `navigation.ts:177` registered.
2. **An annotated `Route.search` loses its keys.** `Route.search(S).annotate({ title })` makes a new Schema object, so the three codec maps miss it. The probe prints `plain keys: {"known":true,...} annotated keys: {"known":false,"keys":[]}`. Three things follow:
   - `UrlState.make` on that route dies with "an opaque route search codec must declare searchKeys" (`url-state-runtime.ts:109-114`);
   - `retain` loses its field table (`codec.ts:701`);
   - print order falls back to the AST (`codec.ts:763`).

### Per map

Caller lines come from one grep over every writer and reader name (`registerChecks|readChecks|registerLeave|readLeave|registerShell|readShell|registerSurface|readSurface|registerTraversals|readTraversals|Traversal.(register|read)|registerReceipts|Receipt.of|registerPrerender|planOf|enumerations.|drivenTrees.|treesOf.|segmentRuntimes.|runtimes.(get|set)|segmentRuntimeOf|runtimeOf|partsOf|searchKey*`). It finds nothing in `apps/` or `tooling/`.

| Map | Writer (src) | Reader (src) | Tests | Key held by caller | Carry it on |
| --- | --- | --- | --- | --- | --- |
| `check.ts:90` `checkers` | br:3084 (`mountTree`), br:3217 (`redirecting` overwrites the entry mountTree just wrote) | `router.ts:538`, `:1168` | none | route value (yes) | A field on `AnyRoute` (`codec.ts:535`) under a non-exported symbol, set in `mountTree`. `redirecting` passes its checker in, so there is no second write. `notFoundRoute` (`router.ts:195`) sets none. |
| `leave-registry.ts:51` `askers` | br:3050 | `router.ts:829` | none | `Entered` (yes) | `Entered.questions`, next to `inspection`. Only br:2968-3080 and `router.ts:196-236` build an `Entered`. `G "\bEntered\b"` outside src finds 0. |
| `landing.ts:78` `shells` | br:3064, `router.ts:222` | `router.ts:1269` (`shellOf`, used at `:601` and `:687`) | the bundle marker `navigation-behavior.test.tsx:164` (`"registerShell"`) | `Entered` (yes) | `Entered.shell`. The fallback for "a route the framework did not build" (`router.ts:1267-1277`) becomes dead, because both producers set the field. |
| `landing.ts:89` `surfaces` | `navigation.ts:177`, `browser-commit.ts:479` | `router.ts:340` | `navigation-landing.test.tsx:92`, `browser-commit.test.ts:237,287` | `LocationService` (yes) | A field on `LocationService` (`router.ts:99-105`) under a non-exported symbol, which survives a spread. |
| `traversal.ts:127` `sources` | `browser-commit.ts:478` | `router.ts:1085` | `route-leave.test.tsx:433`, `browser-commit.test.ts:98` | `LocationService` (yes) | The same capability field as `surfaces`: one record `{ surface, traversals }`. |
| `receipt.ts:42` `registered` | `router.ts:504` | **none in src** | `route-pending:603`, `route-leave:509`, `route-checks:620`, `route-check-edges:139,173,174`, `browser/leave-app.tsx:148`, `browser/navigation-app.tsx:373` | `RouterService` (yes) | This map is a test seam that lives in src. See O1. |
| `prerender.ts:190` `plans` | br:3380 | `prerender.server.ts:364`, `:404` | none | route value (yes) | The `extra` that `mountTree` already copies onto the route (br:3374-3379 passes `prerendered()`). Put the plan beside the `~prerender` phantom. |
| `prerender.ts:115` `enumerations` | `prerender.ts:147` | `prerender.ts:319` (its die at `:320` becomes dead) | none | `Inputs` (yes) | Under `InputsBrand` (`prerender.ts:48`) on the `Inputs` value. |
| br:3232 `drivenTrees` | br:3301 | br:3316 (`drivenAt`) | through `Route.drivenAt` in `driven.test.tsx:264,640,696` | route value (yes) | The `extra` in `mountTree` (br:3300 passes `{}` today), read back with an `isDrivenRoute` guard, as `isDrivenView` does (`driven.tsx:86`). |
| br:540 `segmentRuntimes` | br:802 | br:548, 561 (`partsOf`), 724; `segmentRuntimeOf` callers br:1391, 3196 | none | segment (yes) | The `[SegmentBrand]` field (br:385-391) holds the `SegmentRuntime` instead of the literal `"Segment"`. The symbol is not exported, so no caller can reach `check` outside the router, and the reason for hiding it (br:447-451) still holds. |
| br:1230 `runtimes` | br:2831 | br:1240 (`runtimeOf`), callers 2269, 2953, 3195, 3247, 3373 | none | branch (yes) | `[BranchBrand]` (br:1194-1203) holds the `BranchRuntime`. |
| br:570 `treesOf` | br:2953-2961 (mutates a Set shared across every tree ever built) | br:756 (`currentAt`) | none | segment (yes), but the fact is a relation between a segment and the matched route | `RouteMatch` (`router.ts:63-66`) carries the matched route's segments, as R11 already planned. See batch F. |
| `codec.ts:252` `searchKeyOrders` | `codec.ts:302` | `:763` | none | Schema (yes) | Delete it: it equals `fields.map(name)`. |
| `codec.ts:253` `searchFieldDefinitions` | `:306` | `:701` | none | Schema (yes) | One Schema annotation holding `SearchField[]`. It survives `.annotate()`, which the probe showed the map does not. |
| `codec.ts:260` `searchKeyDefinitions` | `:307` | `:751` | none | Schema (yes) | Delete it: it equals `{ known: true, keys: fields.map(name) }`. |

### Apply batches

Each batch compiles and passes the gate alone. The order is from least to most risk.

#### Batch A: `Entered` carries its shell and its leave questions (`shells`, `askers`)

- **Files:** `landing.ts`, `leave-registry.ts`, `codec.ts` (`Entered`), br:3050-3072, `router.ts:196-236`, `:829`, `:1267-1277`, `navigation-behavior.test.tsx:164`.
- **Candidate kind:** pass-through. `register` and `read` are a WeakMap with nothing added.
- **North star:** explicit. The data is found from the value, the same way `inspection` is.
- **Change:** add `readonly shell: Effect<Shell>` and `readonly questions: Asker` to `Entered`. Delete `registerShell`, `readShell`, `register`, `read`, and the "did not build" fallback. Change the bundle marker test to a name the routed tree still holds.
- **Lines removed:** about 30, with about 6 added.
- **Risk:** low.
- **Public API change:** yes, type only. `Route.Entered` gains two fields, and nothing outside src builds one. It needs a changeset.
- **Wire or stored format change:** no.

#### Batch B: a route carries its checks, its prerender plan and its driven resolver (`checkers`, `plans`, `drivenTrees`, `enumerations`)

- **Files:** `check.ts:88-110`, `prerender.ts:115,147,190-194,318-322`, br:2940-3085, 3183-3218, 3232-3325, 3360-3381, `router.ts:538`, `:1168`, `prerender.server.ts:364,404`.
- **Candidate kind:** pass-through. It also fixes reproduced defect 1.
- **North star:** explicit. A guard stays with the route it guards.
- **Change:**
  - `AnyRoute` gains `[RouteChecks]: Option<Checker<R>>`.
  - `mountTree` takes the checker as a parameter, so `redirecting` passes its own and there is no overwrite.
  - The plan and the driven resolver go into `extra`. `planOf` and `drivenAt` read them with a guard.
  - `Inputs` holds its erased enumeration under `InputsBrand`.
  - Add a test: a spread of a guarded route still redirects.
- **Lines removed:** about 40.
- **Risk:** low to medium. `MountServices<R>` keeps its one cast (`check.ts:108`).
- **Public API change:** yes, type only. `AnyRoute` and `Inputs` gain symbol-keyed fields. It needs a changeset.
- **Wire or stored format change:** no.

#### Batch C: a `Location` carries its capabilities (`surfaces`, `sources`)

- **Files:** `landing.ts:89-99`, `traversal.ts:125-136`, `navigation.ts:177-195`, `browser-commit.ts:462-479`, `router.ts:340`, `:1085`, and 4 test sites.
- **Candidate kind:** pass-through, plus the spread hazard at `browser-commit.ts:463`.
- **North star:** explicit.
- **Change:** `LocationService` gains an optional `[LocationCapabilities]: { surface?, traversals? }`. The symbol is not exported, so the traversal protocol stays PRIVATE, as `traversal.ts:7-10` wants.
- **Lines removed:** about 20.
- **Risk:** medium. It changes a public interface that apps implement in their test fixtures: `apps/notes/tests/fixture.ts:109`, `apps/dashboard/tests/fixture.ts:304`, and 14 test files (`G ": LocationService\b|LocationService = "`). The field is optional, so none of them has to change.
- **Public API change:** yes, type only.
- **Wire or stored format change:** no.

#### Batch D: definition runtimes ride on their brands (`segmentRuntimes`, `runtimes`)

- **Files:** br:385-391, 540-567, 802, 1194-1250, 2831.
- **Candidate kind:** pass-through.
- **North star:** explicit. It also removes two die paths that a branded value can never reach: `BranchRejected` "not a segment built by…" at br:552-557 and "…not a branch built by…" at br:1244-1249.
- **Change:** the brand field holds the runtime.
- **Lines removed:** about 45.
- **Risk:** medium. `SegmentRuntime` and `BranchRuntime` appear in the emitted `.d.ts`, and `bun run declarations` refuses a leaked `unknown`. `runtimes` is stored at `BranchRuntime<unknown>` today, so the brand's type must stay generic in `R`. Run `bun run declarations` first.
- **Public API change:** type only. The brand's value type changes, and no caller can name the symbol.
- **Wire or stored format change:** no.

#### Batch E: one search annotation instead of three maps

- **Files:** `codec.ts:246-311`, `:701`, `:751`, `:763`.
- **Candidate kind:** one concept with three owners. Keys and order are both derived from the field list. It also fixes reproduced defect 2.
- **North star:** effect-native, because Schema metadata belongs in an annotation.
- **Change:** `Route.search` annotates its result with its `SearchField[]`, and the three readers derive from that one annotation. Add a test: an annotated `Route.search` still has known keys and works with `UrlState`.
- **Lines removed:** about 12.
- **Risk:** low.
- **Public API change:** no.
- **Wire or stored format change:** no. URLs print the same, and the probe's `href` output is the same with and without the annotation.

#### Batch F: `currentAt` reads the match, not a global relation (`treesOf`)

- **Files:** br:566-570, 752-771, 2951-2961; `router.ts:63-66`, `:490-495`; `link.tsx`.
- **Candidate kind:** state written outside its owner. The `Set` is mutated at every `Route.client(...)` call and is never cleared. A tree named `a` in one router marks the segments of another router's tree `a`, because the key is a name string.
- **North star:** explicit (R11's own "longer term").
- **Change:** `RouteMatch` carries the matched route's segment set, or an identity from which `currentAt` reads it. Delete `treesOf`.
- **Lines removed:** about 12.
- **Risk:** medium, because `RouteMatch` is public and `router.current` publishes it.
- **Public API change:** yes. It needs a changeset.
- **Wire or stored format change:** no. Inspection records the name only (`router.ts:634-638`).

#### O1 (owner question): `receipt.ts` `registered`, a test-only seam in src

`Receipt.of` has 0 readers in src, 6 test files, and 2 browser fixtures. `router.ts:504` registers receipts on every router it mounts, only so that tests can read them. `receipt.ts:9-11` still says "the public surface changes once, when the route surface is chosen". R14 chose that surface, so the comment is stale.

The trade: make `RouterService.push/replace` return `NavigationResult`, which is expressive (a caller learns Committed, Unchanged or Stayed) and deletes the map, or keep `void` and the seam, which keeps the public command minimal. Either way, rewrite the comment.

---

## Q2: segment, leaf and route for a one-page app

**Answer: three concepts is the right number.** In EGW each of the three carries a fact the app uses:

- **The segment** is the address `/`. It prints the typed link in the not-found view (`EGW/src/routes.tsx:54`, `link(search, {}, {})`), and the server matches it (`EGW/server/document.ts:31,86`).
- **The leaf** is the view plus `landing: Preserve` (`routes.tsx:44-47`).
- **The route** is the name plus `Streamed`.

Deleting any one of them hides a name or a mode. A route name that defaulted to the segment's name (both are `'search'`) would be a hidden default, which north star 5 rejects.

**`segments.ts` is a split of a dependency graph, not an extra concept.** The view types its props from the segment, and the leaf needs the view, so the order is segment, then view, then leaf. If the segment lived in `routes.tsx`, `app.tsx` would import from `routes.tsx` while `routes.tsx` imports `app.tsx`: a cycle. The apps choose this split on purpose (`apps/notes/src/segments.ts:7-10`). Remix v3 does the same: `createRoutes` builds the addresses (`remix/packages/fetch-router/src/lib/route-map.ts:73`), apart from the handlers that `router.map` takes.

**In EGW, though, the split pays for nothing.** `SearchPage` ignores its props (`EGW/src/app.tsx:174-176`, `_props`, "It reads nothing from the router's props"). The only reason for the type is ledger seed F4: `lazyEffect` is set to error at `bible-tools/tsconfig.json:68`, so a zero-argument view is refused. The smaller explicit form therefore belongs to the view area (F4), not to the router. Two ways out:

- (a) Resolve F4, then put the segment inline in `routes.tsx` and delete `segments.ts` (16 lines).
- (b) Take Q3's option, so that the page really does read `props.search` and `pushSearch`. Then `segments.ts` earns its place.

No router change is proposed.

---

## Q3: `UrlState` against the segment's empty search codec

**Answer: the framework does not have two owners. EGW uses the view-level tool for a route-level fact.**

**The segment owns nothing.**

- `search: Route.search(Schema.Struct({}))` (`EGW/src/segments.ts:13-16`) is byte for byte the default. br:677 defines `const NoSearch = searchCodec(Schema.Struct({}))`, and `searchCodec` is `search` (br:97). So the line is dead: delete it in EGW, 1 line.
- The route's keys are `{ known: true, keys: [] }`.
- `UrlState` alone claims `WORKSPACE_KEYS` (`EGW/src/app.tsx:178`). The disjointness guard is `url-state-runtime.ts:127-133` (`UrlStateConflict`), which acceptance row 125 proves.

**But the query string is the page's identity, and the design says that belongs on the segment.**

- The design note (`docs/design/dx-review-2.md:85-87`) says: "Route search belongs to route identity. A view can own *another* URL slice." EGW's own header (`url-state.ts:9-16`) says "The URL *is* the search state", and each pane is reachable from a pasted link.
- The segment already accepts an opaque codec with explicit keys: `SegmentOptions.searchKeys` (br:602-603), checked by `declaredSearchKeys` (`codec.ts:729-748`).
- So EGW can write `search: Workspace, searchKeys: WORKSPACE_KEYS` on the segment, and the page can read `props.search`, `props.pushSearch` and `props.replaceSearch`.
  - What it gains: one owner, at the address; typed `link(search, {}, panes)`; and a server that decodes the workspace for the streamed shell.
  - What to check first: a search that fails to decode is a non-match on a segment (br:790-795), whereas `UrlState` falls back (`url-state-runtime.ts:246-261`). `parseWorkspace` is total (`EGW/src/url-state.ts` "Total: a hand-edited or truncated link degrades"), so nothing changes for EGW.

This is an EGW change (pass 2 group 8), not a framework change.

Framework usage, for scale:

- `G "UrlState\.make\("` finds 0 uses in `apps/`, 17 in tests, and EGW is the only app.
- `G "\.(pushSearch|replaceSearch)\("` finds 1 use in `apps/notes/src/views.tsx`.

**A stale claim was found on the way (candidate R-doc1).**

- **Files:** `docs/design/acceptance.md:122` and `packages/effect-frame/tests/router/url-state.test.tsx:439`.
- **Problem:** both still say "set/update replace by default" and "replaces by default". R14 removed both the default and `set/update`: `url-state-runtime.ts:23-28` reads "neither is a default", and the test calls `state.replace(...)` explicitly (`:444`).
- **Change:** rename the test to "derives from the URL, and replace rewrites the entry", and move the row text with it. That keeps the rule that a row moves only with its test.
- **Lines removed:** 0.
- **Risk:** none.
- **Public API change:** no.
- **Wire or stored format change:** no.

---

## Q4: the flaky `prerender-build.test.tsx` "a crashed build leaves the previous tree serving, and leaves no staging behind"

### Root cause (read, then reproduced)

`stage` removes its directory in a finalizer when the build's scope fails (`src/router/prerender-output.server.ts:118-131`). An interrupted page write can land after that removal and re-create the directory. Four steps:

1. **The page writes are interruptible, and the build interrupts them.** Each page writes with `fs.makeDirectory(dirname, { recursive: true })`, then `fs.writeFileString`, then `fs.readFile` (`src/router/prerender.server.ts:484-487`). The pages render at `concurrency: 8` (`:511`), and none of these writes is uninterruptible. Both halves of the test interrupt pages in flight:
   - the first half calls `Fiber.interrupt(building)` (test `:288`);
   - in the second half, the `Broken` page dies (test `:302`), and `Effect.forEach` interrupts its siblings.
2. **Interruption does not wait for the file operation.** In `@effect/platform-node-shared`, which Bun uses, `makeDirectory`, `remove` and `mkdtemp` are `Effect.effectify` wrappers (`NodeFileSystem.js:99-124`). `effectify` is `callback(resume => fn(..., cb))` with no finalizer (`effect/dist/Effect.js:8146-8158`). An interrupted fiber resumes at once, and the Node `mkdir` keeps running. `writeFile` passes an `AbortSignal` (`NodeFileSystem.js:413-429`), but the file may already be open and created.
3. **The finalizer then races the orphaned operation.** After the interrupted children return, the scope closes and `stage`'s finalizer runs `fs.remove(staging/<id>, { recursive: true })` (`prerender-output.server.ts:125-128`). If the orphaned `mkdir -p staging/<id>/posts/…`, or the orphaned write, completes after the `rm`, it creates `staging/<id>` again.
4. **So the outcome depends on timing.** The test's `namesIn(`${out}/staging`)` (test `:290`, `:310`) sees the new directory only when the orphaned operation wins the race. That explains why six runs alone passed and the loaded gate failed once.

**Reproduction** (`pass2-router/race.ts`). The probe forks `mkdir -p` and a 100 KB write into `staging-i`, yields, interrupts, runs the same `remove`, waits 5 ms, and checks the directory. Across three runs it left 4, 1 and 6 staging directories out of 200. `race-fixed.ts`, the same code wrapped in `Effect.uninterruptible`, left 0 of 200 in both runs.

### Candidate R-Q4: a page's files are written uninterruptibly

- **Files:** `src/router/prerender.server.ts:484-487` and `:514-520`. Optionally, a doc line on `stage` at `prerender-output.server.ts:113-117` saying that nothing may write into the directory after the scope ends.
- **Candidate kind:** a Scope lifetime that the code does not hold. A write outlives the scope that owns its directory.
- **North star:** effect-native. The Scope owns the directory, so every write into it must end before the Scope's finalizer runs.
- **Change:**
  - Wrap each page's `makeDirectory`, `writeFileString` and `readFile` in `Effect.uninterruptible`. Rendering stays interruptible; only the short write is protected.
  - Do the same for the client and manifest writes, or move them inside `publish`'s `uninterruptibleMask`.
  - Add a deterministic red test: provide a `FileSystem` whose `makeDirectory` finishes on a daemon fiber some milliseconds after the caller is interrupted. That fails today on every run, not one run in 50.
- **Lines removed:** 0, with about 4 added.
- **Risk:** low. An interrupt now waits for at most one file write per page in flight.
- **Public API change:** no.
- **Wire or stored format change:** no. The output layout is unchanged.

---

## Q5: other candidates in scope

The candidate list was checked across the directory. Findings beyond Q1–Q4:

- **Batch E** (above) is also the answer to "a hidden default": when a codec is not registered, it falls back to the AST without saying so (`codec.ts:750-758` and `:762-771`). The annotated Schema in the probe takes that silent path.
- **Batch B** also removes a second write to one key: `redirecting` lets `mountTree` register checks and then overwrites them (br:3196 and :3217). The code comments this, but the order carries the meaning.
- **Public exports with no in-repo subject.** Counted by `grep -rnE "Route\.<name>\b"` outside src:
  - `Route.printSearch` has 0 uses in the repo and 0 tests. EGW uses it (`EGW/src/url-state.ts` `fromRecord`), so it has one consumer and no test that has it as its subject. Add one assertion to `tests/router/route.test.tsx` (`printSearch(readSearch(x))` round-trips). That is under 5 lines, so it is listed under "not worth a pass".
  - `Entered`, `EnteredValues`, `RouteNavigation`, `RouteInstance`, `SearchKeyInfo`, `Part` and `Linkable` have 0 uses each. Every one is named by a public signature (`AnyRoute.enter`, `AnyRoute.searchKeys`, `parseTemplate`, `link`), so it is part of that type's closure, and exporting it is correct. Not a finding.

Checked, no findings:

- `rendering-mode.ts`: the not-found mode is the named constant `notFoundMode`.
- `hydrate.ts`, `leaf-root.ts`, `navigation-behavior.ts`, `path.ts`, `url-state.ts`.
- `grep -nE "slice|previously|used to|no longer|for now|TODO"` over `src/router` finds only code uses and present-tense text, apart from `receipt.ts:9-11` (O1).

## Not worth a pass

- EGW `src/segments.ts:15`: `search: Route.search(Schema.Struct({}))` is the default (br:677). Delete it in group 8.
- `receipt.ts:9-11`: a comment that tells a plan. Rewrite it with O1.
- `Route.printSearch`: add a round-trip assertion as its test subject.
- `navigation-behavior.test.tsx:164` asserts that the internal name `registerShell` is in the bundle. Batch A must change it; it is a test that depends on a magic name.

## Summary table

| ID | Candidate | North star | Lines removed | Risk | Public API | Wire |
| -- | --------- | ---------- | ------------- | ---- | ---------- | ---- |
| A | `Entered` carries its shell and leave questions | explicit | ~30 | low | type-only, yes | no |
| B | the route carries its checks, plan and driven resolver; `Inputs` its enumeration (fixes the spread defect) | explicit | ~40 | low-med | type-only, yes | no |
| C | the `Location` carries its surface and traversals | explicit | ~20 | med | type-only, yes | no |
| D | segment and branch runtimes ride on their brands | explicit | ~45 | med | type-only | no |
| E | one search-fields annotation (fixes the annotate defect) | effect-native | ~12 | low | no | no |
| F | `RouteMatch` carries its segments; delete `treesOf` | explicit | ~12 | med | yes | no |
| O1 | receipts: a public result, or keep the test seam (owner question) | expressive vs minimal | ~12 or 0 | low | maybe | no |
| R-Q4 | a page's files are written uninterruptibly (the flaky test) | effect-native | 0 (+4) | low | no | no |
| R-doc1 | acceptance row 122 and its test title stop claiming a default | explicit | 0 | none | no | no |
| EGW | the query moves onto the segment (Q3 option, group 8) | explicit | ~3 | low | n/a | no |
