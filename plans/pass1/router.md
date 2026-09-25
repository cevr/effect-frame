# Architecture pass 1: `packages/effect-frame/src/router`

Tree: `/home/exedev/Developer/personal/effect-frame` (branch `hydrate-order`, head `bacd899`). This was a read-only pass. No repo file was edited and no server was started.

Every caller count below comes from a grep over `apps/`, `packages/` and `tooling/`, with `node_modules` and `dist` excluded. Short forms used in the receipts:

- `G` means `grep -rnE <pattern> apps packages tooling --include='*.ts' --include='*.tsx' | grep -v node_modules | grep -v /dist/`
- "src" means `packages/effect-frame/src`

The ledger has no pass-1 rows yet, so this report re-proposes nothing that was done or rejected. The report builds on trial friction 4, 9 and 10 in `pass1-agent-trial.md`.

## Answers to the six questions

1. **Unwrapping route data.** The one generic primitive is `Source.switchMap` in `actor/source.ts` (R1). It is not router-specific. On top of it, the router gives the actor binding a `.state` field, the same shape the query binding already has (R2). The notes page's keyed `View.list` is a different need. `View.form` prints the address into the HTML and chooses the command identity at render time, so the form has to render again for each address. No state helper can replace that. The explicit primitive for it is a keyed region with one row (O2).
2. **Flat route vs segment.** The two forms disagree in 7 ways (R4). The owner question is whether to delete the flat form (O1).
3. **Typing view props.** `leaf` and `layout` already infer props when the view is written inline (`branch.ts:1081`, `branch.ts:1178-1180`). The apps keep views apart from segments on purpose (header of `apps/*/src/segments.ts`), so `Route.PropsOf` is the bridge they need. It is used 8 times in `apps/*/src` and 31 times in total. The pitfall is that `SegmentProps` and `LayoutProps` are public, have 0 external callers, and let an author type props by hand with `any` (R12). A `Route.view(seg, fn)` helper would add nothing for a leaf. For a layout it cannot keep `ChildR`, so it would lose the proof that `LoadingScope` was provided (O3).
4. **Double owners.** `mount` (R7). The page-load `hydrate`, which the apps write themselves (R6). The plain-click policy, owned by both `Link` and `followLinks` (R8). The option name `behavior`, which means two things (R9).
5. **Hidden defaults.**
   - `traversalReadLimit` defaults to 3 s.
   - The mount-level `behavior` defaults to `Restore`.
   - A route with no recorded mode renders as `"SSR"` (R10, R11).
   - `UrlState` replaces the history entry by default, while `updateSearch` pushes one (R14).
   - A redirect always replaces the entry. It is documented and standard, so it is not a candidate.
6. **Other magic.**
   - Routes are identified by their name string, through a global side table (R11).
   - The `data-frame-replace` attribute is undocumented (R8).
   - The redirect target is a one-use wrapper (R13).
   - A child segment repeats its ancestors' params, and a template param is never checked against the params schema (R5).

## Candidates

### R1 — Add `Source.switchMap`; delete the app's `snapshotOf`

- **Files:** `src/actor/source.ts:235`, `apps/dashboard/src/commands.ts:117-121`, `apps/dashboard/src/overview.tsx:125`.
- **Problem:** The only way to follow a source of sources is to write it by hand. `snapshotOf` does this with `{ get: flatMap, changes: Stream.switchMap }`, and it has 1 caller: `G "snapshotOf"` finds `overview.tsx:125` and its definition. The trial agent wrote the same helper again (trial friction 4). `Source` offers `all/debounce/mapEffect/on/select/throttle/zip` and nothing that switches (`source.ts:235`).
- **North star:** effect-native, expressive.
- **Change:** Add `Source.switchMap(source, f: A => Source<B>): Source<B>`, where `get = flatMap(get, a => f(a).get)` and `changes = Stream.switchMap(changes, a => f(a).changes)`. The name says it switches, so a reader cannot take it for a merge. Delete `snapshotOf`. Add a test with `switchMap` as its subject.
- **Lines removed:** 5 in the app (the library gains about 8).
- **Risk:** low.
- **Public API change:** yes (added).
- **Wire or stored format change:** no.

### R2 — Give the actor binding the query binding's shape: `{ ref, state }`

- **Files:** `src/router/branch.ts:278-283` (`BindingOf`), `branch.ts:1566-1587` (`actorBinding`).
- **Problem:** A query binding is a stable `FollowedQuery` with `.state` (`branch.ts:280`). An actor binding is a bare `Source<RemoteActorRef<C>>` (`branch.ts:282`). So `props.data.counts.state` works, while `props.data.notes.state` does not compile.
  - The trial's first guess failed on exactly this (friction 4).
  - The apps work around it with `snapshotOf` and with the keyed list in `apps/notes/src/page.tsx:146-166`.
  - The design keeps the reference explicit on purpose (`docs/design/nested-transition.md:48`: "One ref is never mutated").
- **North star:** declarative (one binding shape) and actor-model (the reference stays visible: sends still go through `ref`).
- **Change:** Make the binding `FollowedActor<C> = { ref: Source<RemoteActorRef<C>>; state: Source<SnapshotOf<C>> }`. `state` is `Source.switchMap(ref, r => r.state)`, built in `actorBinding`. There is no `send` on the binding, so a send always names its reference. Callers of `.get` on an actor binding become `.ref.get`:
  - `apps/dashboard/src/commands.ts:106`
  - `apps/notes/src/page.tsx:158-159`
  - `G "Route\.actor\("` finds 3 declarations in apps and 13 in tests.
- **Lines removed:** about 8 (with R1).
- **Risk:** medium. The binding type changes in `docs/design/route-public.md:116` and in the exact-type fixture behind `nested-transition.md:116`.
- **Public API change:** yes.
- **Wire or stored format change:** no.

### R3 — Add a `Route.commandRef` declaration; delete the dashboard's hand-written `sender`

- **Files:** `branch.ts:233-275` (declarations), `apps/dashboard/src/commands.ts:36-66`.
- **Problem:** Route data can declare a query or a full actor reference, but not a send-only reference. The dashboard wrote a `sender` to fill the gap:
  - It follows `params` itself and holds references in a module `Map` behind a `Semaphore`. That is state kept outside an actor and outside the transition.
  - It never releases an old tenant's reference until the view closes.
  - `G "sender\("` finds 3 callers: `overview.tsx:178`, `orders-page.tsx:37`, `views.tsx:102`.
- **North star:** actor-model (the transition owns and moves every address), declarative.
- **Change:** Add `Route.commandRef(contract, key)`, which binds `Source<RemoteCommandRef<C>>`. It is acquired and moved like `Route.actor`, but opens no stream. Delete `Sender`, `sender`, `fulfil`, `cancel` and `writeMemo` in favour of `yield* binding.get` followed by `.send`.
- **Lines removed:** about 45 in the app.
- **Risk:** medium. This is a new declaration kind in the transition (`branch.ts:1262` `Resource`).
- **Public API change:** yes (added).
- **Wire or stored format change:** no.

### R4 — Make the flat route and the segment form agree

- **Files:** `src/router/codec.ts:493-505`, `branch.ts:450-467`, `branch.ts:863-868`, `branch.ts:2900-2939`.
- **Problem:** The flat form is documented as "exactly `mode(name, leaf(segment(name, definition), definition.view))`" (`branch.ts:2881-2882`), but it differs in 7 ways:
  1. `search` is required on the flat form (`codec.ts:497`) and optional on a segment, which defaults to `NoSearch` (`branch.ts:455`, `:475`, `:520`).
  2. `behavior` is a field on the flat definition (`codec.ts:504`) but a leaf option on a segment (`branch.ts:768-770`), which `flatOptions` translates (`branch.ts:863`).
  3. The flat view is `View.View<RouteProps, never, R>`, so it has no `E` and no `data` (`codec.ts:502`). A leaf view is `(SegmentProps) => Effect<Node, E, R>` (`branch.ts:1081`).
  4. The props differ: flat views get `RouteProps`, leaf views get `SegmentProps` with `data`.
  5. `currentAt` means different things. On a flat route it compares names (`branch.ts:2929-2934`). On a segment it parses the URL into page or ancestor (`branch.ts:545-557`).
  6. The flat result carries `params`, `search` and `href` (`codec.ts:555-567`). A `Tree` carries none of them (`branch.ts:2842`).
  7. The flat form has no `data`, `before`, `errored` or `pending`.
- **North star:** explicit (one model, one set of option names).
- **Change, if O1 keeps the flat form:** Make `search` optional with the same `NoSearch` default, and use the leaf's option name for `behavior` (see R9).
- **Lines removed:** about 5.
- **Risk:** low.
- **Public API change:** yes.
- **Wire or stored format change:** no.

### R5 — Params follow the template: check names, inherit ancestors, allow no params

- **Files:** `branch.ts:450-455`, `:504-535`, `:613-646`; `codec.ts:118-128`, `:611-650`.
- **Problem:**
  1. **Guard gap.** Nothing checks the template's param names against the params schema's keys. If `path: ":tenant"` meets `params: Struct({ tenantId })`:
     - it compiles;
     - every URL fails to decode, which is a silent not-found (`branch.ts:580-585`);
     - printing dies with `TemplateRejected` (`codec.ts:122-127`).

     The only definition-time check is for a duplicate name (`branch.ts:634-644`).
  2. **Repetition.** Each segment decodes the whole accumulated record, so every child restates its ancestors' params. `DashParams` appears at `apps/dashboard/src/segments.ts:34, 50, 67, 76`, and `OrderParams` restates `tenant` at `:82`. The README example does the same (`README.md:151-153`).
  3. **Empty params.** `params` is required even when the template has none. `G "params: NoParams|NoParams = Schema.Struct|params: Schema.Struct\(\{\}\)"` finds 9 lines in `apps/*/src` and 49 in total. Notes and blog each define their own `NoParams` value, while the public `Route.NoParams` is a type-only name with a different meaning (`branch.ts:374`).
- **Prior art:** remix `route-pattern` types the template string (`packages/route-pattern/src/lib/href.ts:8`, `ParseParams`). Foldkit's biparsers bind the name and the type in one call (`foldkit/src/route/parser.ts:181` `string(name)`).
- **North star:** expressive (a wrong program does not compile), explicit.
- **Change:**
  - Take `const Path extends string` and require the params codec's encoded keys to equal `ParamNames<Path>`.
  - A child declares only its own params, and its `Params` is `ParentParams & Own`. This needs struct params, so the schemas can be merged.
  - `params` becomes optional when the template has no param.
- **Lines removed:** about 15 in apps, plus about 40 in tests.
- **Risk:** medium, from type-level template parsing.
- **Public API change:** yes.
- **Wire or stored format change:** no. URLs print the same.

### R6 — `hydrate` is the one page-load owner; the apps stop writing it themselves

- **Files:** `src/router/hydrate.ts:319-338`, `apps/{notes,dashboard,blog}/src/app.ts`.
- **Problem:** All three apps repeat the body of `hydrate`: `readRecords`, `Streaming.resume`, `Dom.hydrate`, `mount`, `render`, `finish`, `resumed.hydrated`.
  - See `apps/dashboard/src/app.ts:16-27`, `apps/blog/src/app.ts:17-27` and `apps/notes/src/app.ts:25-39`.
  - This makes the author order framework steps, which breaks the declarative north star. The copies have already drifted: they lack the `resumed.closed` handover (`hydrate.ts:336`).
  - The one real difference is that notes reads refused-form issues (`app.ts:17-22`, `:31`).
  - `G "hydrate\(\{"` finds only `tooling/checks/consumer/declarations.ts:41` and 2 tests.
- **North star:** declarative.
- **Change:** `hydrate` reads `Form.issuesScriptId` and applies `Form.provideIssues`. A plain post works under every server mode (`CONTEXT.md:44`), so reading its issues belongs to page load. The apps call `hydrate({ routes, notFound, root })`.
- **Lines removed:** about 40.
- **Risk:** low.
- **Public API change:** no, apart from new behaviour inside `hydrate`.
- **Wire or stored format change:** no. It reads the existing issues script.

### R7 — `mount` has two owners

- **Files:** `src/view/runtime.ts:1725`, `src/router/router.ts:266`, `src/router/index.ts:13`.
- **Problem:**
  - Both subpaths export `mount`, and the two have different signatures.
  - `G "mount as mountRouter"` finds 11 test files that rename the router's `mount` to avoid the clash, and `router.ts:3` renames the view's (`mount as mountView`).
  - After R6, the router's `mount` has 0 callers in `apps/*/src`. Today it has 3, all in `app.ts`.
  - The router's `hydrate` and `Dom.hydrate` are the same kind of pair.
- **North star:** explicit (trial friction 9).
- **Change:** Rename the router's `mount` to `mountRoutes`, and give the view pass the `Dom.hydrate` pairing.
- **Lines removed:** 0.
- **Risk:** low.
- **Public API change:** yes.
- **Wire or stored format change:** no.

### R8 — One owner for the plain-click policy; no undocumented attribute

- **Files:** `src/router/link.tsx:101-149`, `src/router/navigation.ts:206-280`.
- **Problem:** Two owners decide "is this a plain click, and should the router take it":
  - `isPlainClick` in `link.tsx:143`, with its own listener that forks through `runForkWith` (`link.tsx:121`);
  - `followable` in `navigation.ts:207`, which queues instead.

  `Link` writes `data-frame-replace` (`link.tsx:137`), but its own handler already does the replace. Only `followLinks` reads the attribute (`navigation.ts:258`), and it never sees a `Link` click, because that click already called `preventDefault`. So the attribute matters only for a hand-written `<a>`. `grep -rn data-frame-replace README.md docs CONTEXT.md` returns nothing: it is a magic name.
- **North star:** explicit.
- **Change:**
  - Share one click predicate, and delete `isPlainClick`.
  - Either document `data-frame-replace` as the way a plain anchor asks for a replace, or stop `Link` writing it.
  - Keep `Link`'s own handler for the updater `href`, which acceptance row 109 depends on.
- **Lines removed:** about 10.
- **Risk:** low. Rows 90 and 110 still hold.
- **Public API change:** no.
- **Wire or stored format change:** no.

### R9 — `behavior` means two things on the route surface

- **Files:** `branch.ts:216-223`, `branch.ts:768-770`, `codec.ts:504`, `router.ts:115`.
- **Problem:** `Route.actor(c, k, { behavior })` takes an actor `Behavior` (a reducer). `Route.leaf(s, v, { behavior })`, the flat `behavior` field and `mount({ behavior })` take a `NavigationBehavior`. That is one word for two concepts that CONTEXT names apart ("Actor behavior", "Navigation behavior").
  - `G "\{ behavior: \w+Behavior \}"` finds 3 app declarations, all actor behaviours.
  - `G "NavigationBehavior\.(Preserve|Restore)"` finds 15 uses in `packages` and 0 in apps.
- **North star:** explicit.
- **Change:** Rename the navigation option to `landing`, matching the internal `Landing` (`landing.ts`). Update the `@ts-expect-error` fixtures for row 439; the row's claim does not change.
- **Lines removed:** 0.
- **Risk:** low.
- **Public API change:** yes.
- **Wire or stored format change:** no.

### R10 — Router defaults the caller cannot see

- **Files:** `router.ts:113-134`, `router.ts:282-286`, `branch.ts:737`.
- **Problem:**
  - `traversalReadLimit` defaults to `"3 seconds"` (`router.ts:134`).
  - `behavior` defaults to `Restore` (`router.ts:282`).
  - `Pending` says "There are no defaults" (`branch.ts:737`), so the router's timing rules are inconsistent.
  - `G "traversalReadLimit"` finds 0 uses in apps. All 3 apps inherit both defaults without seeing them.
- **North star:** explicit. The north stars say "Expressive never beats explicit", so this is not a trade.
- **Change:** Make both options required on `mount` and `hydrate` (2 lines per app), or name one exported `NavigationBehavior.defaults` value that each app passes.
- **Lines removed:** 3.
- **Risk:** low.
- **Public API change:** yes.
- **Wire or stored format change:** no.

### R11 — Routes are identified by a name string and a global side table

- **Files:** `branch.ts:434`, `:545-557`, `:2702-2710`; `router.ts:57-60`, `:139`; `link.tsx:71-73`; `document.ts:56`, `:205-208`; `rendering-mode.ts:22-31`.
- **Problem:**
  - `treesOf` is a module-global map that `Route.client(...)` fills at definition time (`branch.ts:2702-2710`), and `currentAt` reads it by tree name.
  - `mount` does not refuse two routes with the same name: nothing in `router.ts` compares names.
  - A user route named `"not-found"` collides with the router's own route (`router.ts:139`), as `document.ts:56` admits.
  - `isActive` compares names only. `G "isActive"` finds 0 callers and 0 tests.
  - A route whose mode was never recorded silently renders as `"SSR"` (`document.ts:205-208`, `rendering-mode.ts:29`).
- **North star:** explicit.
- **Change:**
  - `mount` refuses a duplicate or reserved route name, which closes the guard gap.
  - Delete `isActive`.
  - Brand `AnyRoute`, so that only the mode constructors make one. Only not-found is then left without a mode, and its mode is written as a named constant.
  - Longer term, `Match` carries the route value, and `treesOf` is replaced by each tree's own set of segments.
- **Lines removed:** about 10 now.
- **Risk:** medium.
- **Public API change:** yes.
- **Wire or stored format change:** no.

### R12 — Public exports with no caller or test subject, and two export paths

- **Files:** `src/router/index.ts:3-6`, `:32-50`; `src/router/route.ts:63-146`.
- **Problem:**
  - **Unused:** `Route.printPath`, `printSearch`, `mergeSearchRecord`, `searchKeysOf` (also exported flat at `index.ts:32`), `SearchSchemaRejected` and `isActive`. `grep -rnw <name> packages/*/tests apps tooling` returns 0 for each.
  - **Two export paths:** 18 types are exported both flat (`index.ts:33-50`) and under `Route`. Flat use (`G 'from "effect-frame/router"'`): `AnyRoute` 17, `Entered` 1, `PathRecord` 1, `SearchRecord` 1. `RouteOf`, `RouteLink`, `UrlStateOptions` and `UrlStateState` have 0 uses.
  - **Hand-typing pitfall:** `SegmentProps` and `LayoutProps` have 0 external callers, but being public they invite typing props by hand (the trial wrote `SegmentProps<{}, {}, any>`). `PropsOf` has 31 uses.
- **North star:** explicit (one export path; the same issue as trial friction 2).
- **Change:**
  - Remove the flat type block and the alias exports, and move the 20 flat uses to `Route.*`.
  - Stop exporting the 6 unused names above, plus `SegmentProps` and `LayoutProps`.
  - Add a README line for `Route.PropsOf` and `Route.LayoutPropsOf`.
- **Lines removed:** about 30.
- **Risk:** low.
- **Public API change:** yes.
- **Wire or stored format change:** no.

### R13 — `Route.redirect(Route.target(...))`: a wrapper with one consumer

- **Files:** `src/router/check.ts:24-43`, `:53-63`.
- **Problem:** `Target` exists only so `redirect` can take it, and `grep "\bTarget\b" src` finds no other consumer. `link(to, params, search)` takes the same destination, params and search directly. There are also 2 destination interfaces, `Printable` and `Linkable`, for one idea.
  - `G "Route\.redirect\("` finds 2 in apps and 10 in tests and README.
  - `G "Route\.target\("` finds 18.
- **North star:** expressive, and consistent with `link`.
- **Change:** `Route.redirect(to, params, search)`. Delete `Target`, `target` and `Printable`.
- **Lines removed:** about 12.
- **Risk:** low.
- **Public API change:** yes.
- **Wire or stored format change:** no.

### R14 — One verb set and one default for history writes and search keys

- **Files:** `url-state-runtime.ts:17-33`, `codec.ts:487-490`, `link.tsx:23-24`, `router.ts:68-70`.
- **Problem:**
  - `UrlState.set/update` replace the history entry, and `push.set/push.update` push one. `RouteProps.updateSearch` pushes, and `replaceSearch` replaces. So the same kind of write has opposite defaults.
  - `Link.go` and `Router.navigate` are the same verb spelled two ways.
  - The keys of an opaque codec are `searchKeys` on a segment or route but `keys` on `UrlState.make`.
  - `G "UrlState\.make"` finds 0 in apps, so this change moves only tests.
- **North star:** explicit (no hidden default).
- **Change:** Use `push` and `replace` everywhere, and give none of them a default: `pushSearch/replaceSearch`, `UrlState.push/replace` (each taking a value or an updater), `link.push/replace`, `router.push/replace`. Use one name, `searchKeys`.
- **Lines removed:** about 5.
- **Risk:** medium, because many tests change.
- **Public API change:** yes.
- **Wire or stored format change:** no.

### R15 — Comments that tell history, and misplaced doc comments

- **Files and problem:**
  - History comments:
    - `branch.ts:118-171` ("route slice 2 … Route slice 3 adds … slice 4 adds … slice 5 is internal")
    - `branch.ts:721` ("a later slice")
    - `check.ts:9`, `leave.ts:12`, `leave-registry.ts:7`, `traversal.ts:7`, `leave-branch.ts:19` ("route slice 5")
    - `document.ts:90` ("review round 2")
    - `codec.ts:219` ("Effect RC.115")
  - Orphaned doc comments:
    - `branch.ts:781-784` describes `Instance` but sits above `BranchIdentity`.
    - `link.tsx:83-89` is `Link`'s doc but sits above `currentAttribute`.
- **North star:** explicit (a comment says what is, not how it got there).
- **Change:** Rewrite these as present-tense statements of what the code does, and move the two doc comments to their own declarations.
- **Lines removed:** about 20 (comments only).
- **Risk:** none.
- **Public API change:** no.
- **Wire or stored format change:** no.

## Owner questions (a north-star trade)

- **O1 — Delete the flat route form?**
  - `G 'Route\.(client|ssr|streamed|awaitAll|prerender|driven)\("[^"]+", \{'` finds 0 in `apps/*/src` or tooling, about 67 in `packages/effect-frame/tests`, and 1 in `packages/inspect/tests/fixture/app.tsx`.
  - Deleting it removes `RouteDefinition`, `Route`, `flatLeaf`, `isBranch`, `isDrivenBranch`, `flatOptions`, `DrivenDefinition`, `PrerenderDefinition`, 3 overloads, and the rule that `currentAt` compares names. That is about 180 lines in `branch.ts` and `codec.ts`, and all of R4's disagreements go with it.
  - The trade: explicit and one model, against expressive, since a one-page route grows by about 3 lines. Recommendation: delete it.
- **O2 — A route key change that enters a new instance, or a view-level keyed region?**
  - The notes page builds a keyed `View.list` over the actor-reference source (`page.tsx:146-166`) so `View.form` gets a bare reference.
  - Option (a): a segment option makes a change of declaration key enter a new instance, so its actor binding is a bare `RemoteActorRef<C>`. This is expressive, but it breaks the declarative rule that a stayed view is kept.
  - Option (b): a keyed region with one row in the view, `View.keyed(source, keyBy, row)`. This keeps the view model and belongs to the view pass.
  - Recommendation: (b).
- **O3 — The layout's `<ChildR,>` generic.** Six app layouts carry it (for example `apps/notes/src/views.tsx:58`). Hiding it behind a helper loses the proof that `LoadingScope` was provided (`branch.ts:696-699`). Recommendation: keep it and document the `.tsx` trailing comma.
- **O4 — Redirect-only routes.** `apps/notes/src/routes.tsx:46-48` and `apps/dashboard/src/routes.tsx:40-42` each need a leaf view that is never drawn and an arbitrary `Route.ssr` mode. Should there be a redirect constructor with no view? This adds surface in exchange for a declarative redirect.

## Rejected or out of scope

- **`leave-branch.ts`, private shadow constructors used only by tests.** Rejected: issue #56 is open, and re-opening it needs a new receipt.
- **Carrying the rendering mode as a field on the route value.** Rejected: CONTEXT and `rendering-mode.ts:3-9` decide that the constructor is the mode. R11 closes the implicit gap instead.

## Not worth a pass

- `Route.inputs = makeInputs` (`branch.ts:3295`) is a one-line re-export.
- `ActorDeclaration.open` is marked internal but sits on a public interface (`branch.ts:189-198`).
- `Segment.hrefAt/searchAt/currentAt` have 0 callers in `apps/*/src`, but `link` reads them, so they are the seam.
- `branch.ts` has 3,295 lines. That size is a locality cost for agents but not a defect; revisit if a split falls out of R2 or R3.
