# Architecture pass 1: actor area and `src/*.ts`

Scope: `packages/effect-frame/src/actor/*.ts` (not `http/`, `testing/`), `src/frame.ts`, `src/inspection.ts`. Read-only. No repo file was edited.

Grep convention for caller counts (run from the repo root, over `packages apps tooling`):

```
rg --glob '!**/node_modules/**' --glob '!**/dist/**' --glob '!**/*.md' --glob '!**/worker.js' <pattern> packages apps tooling
```

`worker.js` is the bundled Durable Object fixture. `*.md` excludes the CHANGELOG. The export-count table was built with `scratchpad/arch/count.sh <names…>` (word match, files outside `src/actor/`, split into tests/apps/other). Its output is in `scratchpad/arch/exports-count.txt`.

Ledger and rejected list: no row is done or rejected yet. No candidate below changes a wire or stored format.

---

## Answers to the six questions

### Q1. The `Source` toolkit

- **No `switchMap`, `flatten` or `flatMap`.** `source.ts:235` holds `Source = { all, debounce, mapEffect, on, select, throttle, zip }`. There is no public constant source (`constant` at `source.ts:33` is private) and no public `fromSubscriptionRef` (`source.ts:19` exists, but `client.ts:93-104` does not export it).
- **`Source.mapEffect` is a name trap.** `source.ts:190-229` returns `Effect<Source<QueryState<B,E>>, never, Scope>` and uses switch semantics. `Stream.mapEffect` returns a stream of `B`. An agent who wants the Stream meaning writes it by hand (see below).
- **`select` has three spellings and two owners:**
  - `select` in `actor/source.ts:24`, exported from `actor/client.ts:99`, imported flat in 21 files.
  - `Source.select` in `source.ts:235`: 0 callers (`rg 'Source\.select\('`).
  - `View.select` in `view/view.ts:101` (`export const select = selectSource`): a pass-through with 1 caller, `tooling/checks/consumer/declarations.ts:65`.
- **The other combinators split between flat and namespaced spellings.** Flat `zip` has 3 importers and `Source.zip` has 0. `Source.all/on/debounce/throttle/mapEffect` have 5/2/6/3/5 references, and their flat forms have 0 importers. (A perl scan of the `import {…} from "effect-frame/actor…"` lists: `select` 21, `zip` 3, `all/on/debounce/throttle/mapEffect/match/batched` 0.)
- **Hand-rolled Sources that a combinator would cover:**

| Shape | Sites | Combinator that covers it |
|---|---|---|
| `{get: flatMap(b.get, r => r.state.get), changes: Stream.switchMap(...)}` | `apps/dashboard/src/commands.ts:118-121` `snapshotOf` (1 caller, `overview.tsx:125`); trial `counter-view.tsx` `stateOf` | `Source.switchMap(b, r => r.state)` / `Source.flatten` |
| `{get: flatMap(s.get, f), changes: Stream.mapEffect(s.changes, f)}` | `apps/blog/src/page.tsx:99-102`, `apps/notes/src/page.tsx:159-162`, `src/router/branch.ts:1572-1575`, `src/actor/read-ahead.ts:78-79` | `Source.mapEffect` with Stream semantics (today's name is taken) |
| `{get: SubscriptionRef.get(r), changes: SubscriptionRef.changes(r)}` | `view/query-state.ts:100`, `view/readiness.tsx:107`, `router/router.ts:156`, `router/branch.ts:1661`, `:1888`, `:2115` | `fromSubscriptionRef`, which exists but is not exported |
| `{get: Effect.succeed(x), changes: Stream.succeed(x)}` | `actor/actor.ts:37`, `actor/principal.ts:100-101` | `Source.succeed` (private `constant`) |
| zip by hand with `Stream.zipLatest` and a separate `get` | `apps/notes/src/page.tsx:43-52` `filtered` (1 caller, `:114`) | `Source.zip(notes, filter, (all, only) => all.filter(shows(only)))`. The hand version brings back the read-before-subscribe race that CHANGELOG line 89 records as fixed in `zip`. |

### Q2. Concepts needed to write one actor, one query and one command

The trial files (`trial/counter.ts`, `counter.server.ts`, `counter-view.tsx`) touch 14 concepts through about 24 names:

1. key schema, snapshot schema, and a message union of `TaggedStruct`s
2. `contract(name, {version, policy, key, snapshot, message})`
3. a policy name, a `Policies` table, `Policy.allowAll`
4. a behavior kind: `Behavior.value` (+ `Value.Set`), `Behavior.reducer`, or `Behavior.machine`
5. `implement` or `implementTransparent` (a state codec and a snapshot projection)
6. `query(name, {args, result, policy, depends?, version?})` or `query.batched`
7. `implementQuery(contract, handler)` or `Query.batched(contract, {resolve})`
8. `ActorHost.layer` or `layerMemory` (+ `store`)
9. `ref`, `commandRef`, `Route.actor` (with the behavior given again for prediction), `Route.query`
10. `send(message, options)` → `CommandHandle`, or `call(message, {timeout})`
11. `View.form({ref, contract, key, message, typed, endpoint, returnTo})` or `Generated.send(ref, contract, input)`
12. `ActorTransport` + `HttpTransport.layer` + `queryCacheLayer`
13. `HttpServer` handlers
14. `useQuery`, `followQuery` or `runQuery`

Places where one declaration can replace several, with no ID, scope or placement hidden:

- **The address is given twice.** `View.form` takes `ref` plus `contract` plus `key`, and `Generated.send` takes `ref` plus `contract`. See A6.
- **Four spellings for "the server half".** See A8.
- **Two constructors for the same thing.** `ActorHost.layer` with no `store` is the same as `ActorHost.layerMemory`. See A19.
- **Declaration fields with hidden defaults.** `query` has `version?` and `depends?`. See A9.
- **Not changed:** the behavior is passed to both `implementTransparent` and `Route.actor`. A machine behavior cannot ship to a client, so the client opt-in has to be explicit. This stays.

### Q3. Naming inconsistencies

| Family | Today | Inconsistency |
|---|---|---|
| Declaration | `contract(name, opts)`; `query(name, opts)`; `query.batched` (TS namespace merge, `query.ts:120`) | `contract.version` is required (`contract.ts:43`); `query.version` is optional and defaults to 1 (`query.ts:53`, `:93`) |
| Server half | `implement(c, {behavior,state,snapshot})`, `implementTransparent(c, behavior)`, `implementQuery(c, handler)`, `Query.batched(c, {resolve})` + flat `batched` | Mixed options objects and positional arguments. Three use the `implement*` prefix and one uses `Query.batched`. `Query = { batched }` (`query-host.ts:203`) is a one-member namespace, and its name collides with the view `Query` tag. |
| Placement | `spawn(behavior)`, `durable({behavior,state,message})`, `ref(c,key,opts)`, `commandRef(c,key)` | A verb, an adjective and two nouns. The span names already say `Actor.spawn`, `Actor.durable`, `Actor.ref`, `Actor.commandRef` (`actor.ts:115`, `durable.ts:39`, `ref.ts:311`, `ref.ts:283`), yet no `Actor` namespace exists. `ActorKind` is `"local" \| "durable" \| "remote"` (`vocabulary.ts:125`). `durable` takes no contract; hosted durable does. |
| Layers | `ActorHost.layer`/`layerMemory`, `Frame.layer`, `layer as queryCacheLayer` (flat alias, `client.ts:74`), `QueryCache.layerTest` (class namespace merge, `query-client.ts:1306`), `ActorTransport.layerLocal` (`transport.ts:100`) | The live QueryCache layer is flat and its test layer is namespaced |
| `make` | `Cell.make`, `ActorHost.make`, internal `makeRegistry`/`makeOwner` | Consistent enough |
| `of` | `DurableHostConfig.of`, `Recovery.of` | Effect standard; fine |
| Query read | `useQuery`, `runQuery`, `followQuery` | `useQuery` is the React hook name. Its own doc says so (`query-client.ts:1317-1319`). The service method it wraps is `open`. |
| Type-named objects | `Source`, `QueryState`, `Principal`, `Policy` | `Source` and `QueryState` also export every member flat; `Principal` and `Policy` do not |
| Casing collision | `KeyOf<C>` (the actor key type) and `keyOf(QueryKey)` (the cache-key string) | Two concepts share one word |

### Q4. Duplicate exports, exports with no test subject, single-caller exports

`actor/index.ts:1` does `export * from "./client.js"`, so the two entries do not duplicate each other. Every duplicate is inside `client.ts` or across subpaths. See A2, A3 and A4. Public value exports with no subject outside `src/actor/`:

- `isQueryFailure` (`client.ts:47`): 0 references
- `markStale` (`client.ts:50`): only `src/actor/query-client.ts`
- `queryServerOnly` (`index.ts:32`): 0 importers; `tests/actor/boundary.test.ts:40` checks the string literal
- `MissingPolicy` (`index.ts:43`): only `policy.ts`
- `QueryHostOptions` and `QueryServing` (`index.ts:37`, `:39`): their producer `query-host.make` is not public
- `UnknownQuery` and `PolicyMissing`: no test asserts either (`rg '"(UnknownQuery|PolicyMissing)"'` → only `http/wire.ts:216,218`)
- `Behavior.wakeOf` and `Behavior.refusalOf`: they leak through `export * as Behavior` (`client.ts:7`); callers are in `src/actor` only
- Flat `FormContext`, `FormFields`, `FormIssue`, `FormIssues` (`client.ts:109`): 0 flat uses; `Form.FormContext` has 8
- `Form.Tree/flatten/Fields/Structure/IssuesJson/FormMalformed`: 0 uses outside `src/actor`

Single-caller exports: `View.select` (1 caller, tooling), `snapshotOf` (1), `filtered` (1). Types with no external subject (`ActorContract`, `ContractOptions`, `QueryContract`, `QueryOptions`, …) are authoring vocabulary and fine.

### Q5. Promises, callbacks, manual cleanup, state outside a message

- There is no Promise or `.then` in scope (`rg 'Promise|\.then\(' src/actor/*.ts src/*.ts` → none).
- **State outside a message:**
  - The QueryCache slot's seven closure `let`s are mutated inside `SubscriptionRef.update` callbacks (A12).
  - `followQuery` has `let current` (A12).
  - `inspection.ts:168-178`: `makeOwner` is a synchronous function that increments `let ownerSequence` (A17).
  - `ref.ts:195` `admissions` Map: local bookkeeping; not worth a pass.
- **Module-global singletons:** the `internals` and `documents` WeakMaps (`query-client.ts:363`, `:862`, A11) and the `minted` WeakSet (`command-id.ts:35`, A18).
- **Sync callback where an Effect belongs:** `readAhead(source, ahead: () => boolean)` (`read-ahead.ts:60-62`, A16).

### Q6. `View.form` and `HttpServer.form` accept a message the plain post cannot decode

Confirmed, with receipts:

- **`View.form` checks coverage but not codability.** `view/form.ts:35` is `readonly message: M & Form.Covered<M, Typed>`, so `Form.Codable` is not applied. `M extends Member<C>` (`view/form.ts:65`) only compares `Type` against `MessageOf<C>`. A parallel schema whose `Type` matches but whose `Encoded` does not (`Finite` vs `FiniteFromString`) therefore compiles.
- **`HttpServer.form` is erased.** `http/form-post.ts:42` is `readonly contracts: ReadonlyArray<AnyContract>`.
- **The form decode has three owners:**
  1. `http/form-post.ts:357-360`: `tree(strip(fields))` then `Schema.decodeUnknownEffect(posted.contract.raw.message)`
  2. `view/form.ts:211`: `decodeTree = Schema.decodeUnknownEffect(options.contract.raw.message)`
  3. `Form.codec`: `form.ts:406`, whose only callers are `tests/actor/form-codec.test.ts` and `form-types.test.ts`
- **Runtime probe:** `trial/probe-form.ts.txt` shows `Finite` refuses `amount="5"` and `FiniteFromString` accepts it.

The fix is in A5.

---

## Candidates

### A1. Complete the `Source` toolkit: `switchMap`/`flatten`, a Stream-style `mapEffect`, `succeed`, `fromSubscriptionRef`

- **Files:** `src/actor/source.ts`, `src/actor/client.ts`; callers `apps/dashboard/src/commands.ts:118`, `apps/blog/src/page.tsx:99`, `apps/notes/src/page.tsx:43,159`, `src/router/branch.ts:1572`, `src/actor/read-ahead.ts:78`, `src/view/query-state.ts:100`, `src/view/readiness.tsx:107`, `src/router/router.ts:156`, `src/router/branch.ts:1661,1888,2115`, `src/actor/actor.ts:37`, `src/actor/principal.ts:100`.
- **Problem:** 15 hand-rolled Sources (receipts in Q1). The notes `filtered` reintroduces a race `zip` already fixed. `Source.mapEffect` has switch-and-QueryState semantics under a Stream name.
- **North star:** effect-native, expressive.
- **Change:**
  - Add `Source.switchMap(source, f: A => Source<B>)`, `Source.flatten`, `Source.succeed` and `Source.fromSubscriptionRef`.
  - Rename today's `Source.mapEffect` to a name that says it loads (for example `Source.load`), then add `Source.mapEffect` with Stream semantics (`get: flatMap`, `changes: Stream.mapEffect`).
  - Migrate the sites listed above.
- **Lines removed:** about 45 at call sites; about 25 added in `source.ts`.
- **Risk:** low. `switchMap` needs the "first element is the current value" rule documented at `source.ts:10-12`. The notes and blog `opened` sites read `params.get` inside the map on purpose (`notes/page.tsx:152-153` comment): keep that as `mapEffect`, not `zip`.
- **Public API change:** yes (additions, plus the `mapEffect` rename; `Source.mapEffect` has 5 test references and 0 app references).
- **Wire or stored format change:** no.

### A2. One spelling per Source combinator

- **Files:** `src/actor/client.ts:93-104`, `src/view/view.ts:101`, 24 importing files.
- **Problem:** `select`, `Source.select` and `View.select` are one concept with three owners. Some combinators are used flat and some namespaced (Q1 counts). The trial's reviewer note says "`View.select` should be `select` from `actor/client`".
- **North star:** explicit.
- **Change:** export `Source` only (the `Stream.map` style). Delete the flat `select`, `zip`, `all`, `on`, `debounce`, `throttle` and `mapEffect` exports and `View.select`. Rewrite 21 flat `select` importers, 3 `zip` importers and `tooling/checks/consumer/declarations.ts:65`.
- **Lines removed:** about 12 export lines. The caller rewrite is mechanical.
- **Risk:** low.
- **Public API change:** yes.
- **Wire or stored format change:** no.
- **Delegate:** yes (mechanical).

### A3. `QueryState` has two owners, and the same name means a schema in one and a value in the other

- **Files:** `src/actor/query.ts:164-246`, `src/view/query-state.ts:4-60`, `src/actor/client.ts:32-66`, `src/view/index.ts:59`; flat importers `src/router/branch.ts:26`, `src/view/readiness.tsx:1`, `tests/view/streaming-hydrate-order.test.tsx`, `tests/view/stateful-sources.test.tsx`.
- **Problem:**
  - `QueryState.Ready(value, stale)` from `effect-frame/actor` builds a value.
  - `QueryState.Ready(schema)` from `effect-frame/view` builds a Schema (`view/query-state.ts:35`).
  - `QueryState.Loading` is a function in actor and a Schema in view.
  - View also has `ready(value, stale = false)`, which carries a hidden default (`view/query-state.ts:51`).
  - The flat actor `Loading` collides with the view `Loading` boundary (trial friction #9).
- **North star:** explicit.
- **Change:**
  - `actor/query.ts` owns one `QueryState` object: constructors, guards, `match`, and `QueryState.schema(value, error)`, which moves from view.
  - Delete the flat `Loading`, `Ready`, `Failed`, `isLoading`, `isReady`, `isFailed`, `match` and `markStale` exports. Flat importers today: `Ready` 3, `Loading` 1, `Failed` 1, `isReady` 1, `isFailed` 1.
  - The view module keeps only readiness-specific items (`hasValue`, `fakeQuery`, `held`) and re-exports nothing from actor.
  - Drop the `stale = false` default.
- **Lines removed:** about 40.
- **Risk:** low to medium. `View.QueryState` has 3 importers.
- **Public API change:** yes.
- **Wire or stored format change:** no. The encoded TaggedStructs are identical.

### A4. Delete dead and duplicate public exports

- **Files:** `src/actor/client.ts:7,47,50,109`, `src/actor/index.ts:30,32,37,39,43`, `src/actor/behavior.ts:199-213`.
- **Problem:** the Q4 list. Each export either has no caller or duplicates an export that is used.
- **North star:** explicit (one path per name).
- **Change:**
  - Remove the flat `FormContext`, `FormFields`, `FormIssue`, `FormIssues`, plus `isQueryFailure`, `markStale`, flat `batched`, `queryServerOnly`, `MissingPolicy`, `QueryHostOptions` and `QueryServing` from the entries.
  - Move `wakeOf` and `refusalOf` to an internal module so `Behavior.*` holds only `value`, `reducer`, `machine`, `Value` and the types.
  - The deletion test passes for each: no caller outside `src/actor`.
- **Lines removed:** about 15.
- **Risk:** low.
- **Public API change:** yes.
- **Wire or stored format change:** no.

### A5. One form decode, proved at the type level

- **Files:** `src/view/form.ts:26-65,211`, `src/actor/http/form-post.ts:42,357-360`, `src/actor/form.ts:378-407`.
- **Problem:** Q6. `Codable` is proved only by a function that no runtime path calls. Three decode owners.
- **North star:** expressive (a wrong program does not compile), actor-model (one wire).
- **Change:**
  ```ts
  type MemberOf<C extends AnyContract> =
    C["raw"]["message"] extends { readonly members: ReadonlyArray<infer M> } ? M
    : C["raw"]["message"] extends MachineEventSchema<infer _D> & { readonly variants: infer V } ? V[keyof V]
    : C["raw"]["message"];
  export interface CommandForm<C extends AnyContract, M extends MemberOf<C>, Typed extends string> {
    readonly message: M & Form.Covered<M, Typed> & Form.Codable<M>;
    // …
  }
  ```
  - `MemberOf` is schema identity, not `Type` equality, so a parallel `IncrementForm` schema is refused (trial friction #7).
  - At run time, `View.form` and `form-post.ts` both decode through `Form.codec(contract.raw.message)`. That deletes the hand-written `tree` + `decodeUnknownEffect` pair in each.
  - `HttpServer.form`'s `contracts` stays erased. It cannot know which members a page posts, and `Codable` over a whole contract would wrongly refuse a contract with a non-form member. A hand-built HTML form posting a non-codable member still gets a refusal page, which is the correct runtime answer.
- **Lines removed:** about 10.
- **Risk:** low. It only rejects programs that cannot work.
- **Public API change:** yes (type-level only).
- **Wire or stored format change:** no. The field names are unchanged.

### A6. A remote reference carries its address

- **Files:** `src/actor/vocabulary.ts:286-308`, `src/actor/ref.ts:30-37,283-296,359-366`, `src/view/form.ts:27-29,122,159-160`, `src/actor/generated.ts:193-212`.
- **Problem:** `View.form({ref, contract, key})` and `Generated.send(ref, contract, input)` take the address twice, and nothing checks that they agree. The plain post uses `options.contract.name`/`options.key` (`view/form.ts:122,159-160`) while the scripted send goes to `ref`. A mismatch sends the plain post to one actor and the script to another. The trial also had to snapshot `yield* props.data.counter.get`, which goes stale when the key moves (friction #4).
- **North star:** explicit and actor-model: the address and placement are visible in the reference.
- **Change:**
  - Add `readonly contract: C` and `readonly key: KeyOf<C>` to `RemoteActorRef` and `RemoteCommandRef`. Both values are already in scope at `ref.ts:311-319` and `:283-288`.
  - Drop `contract` and `key` from `CommandForm`, and `contract` from `Generated.send`.
  - Optionally let `View.form` take `Source<RemoteActorRef<C>>`.
- **Callers:**
  - `View.form`: `apps/notes/src/page.tsx`, `apps/blog/src/page.tsx` and 5 test files (`rg -l 'View\.form\('`).
  - `Generated.send`: `apps/notes/src/commands.ts` and 3 test files.
- **Lines removed:** about 15.
- **Risk:** low.
- **Public API change:** yes.
- **Wire or stored format change:** no.

### A7. Name placement constructors after `ActorKind`, under an `Actor` namespace (owner question on the names)

- **Files:** `src/actor/actor.ts:115`, `src/actor/durable.ts:39`, `src/actor/ref.ts:283,311`, `src/actor/client.ts`; `spawn` has 41 files outside `src/actor`, and `ref` and `commandRef` add more.
- **Problem:** Q3 placement row. The span names already promise an `Actor` namespace.
- **North star:** explicit (placement shows in the call), consistency.
- **Change:** `Actor.local(behavior)`, `Actor.durable(...)`, `Actor.remote(contract, key, opts)` and `Actor.remoteCommands(contract, key)`, matching `ActorKind` and each reference's `kind`. The alternative is to keep the verbs and only add the namespace.
- **Lines removed:** 0 (a rename).
- **Risk:** low. The rename is mechanical but wide.
- **Public API change:** yes.
- **Wire or stored format change:** no.
- **Owner decides the names.**

### A8. One shape for the server half

- **Files:** `src/actor/implement.ts:289-307`, `src/actor/query-host.ts:72-203`, `src/actor/query.ts:102-132`.
- **Problem:** four spellings (Q3). `Query = { batched }` duplicates the flat `batched` (0 importers) and collides with the view `Query` tag. `query.batched` depends on TypeScript declaration merging.
- **North star:** expressive, explicit.
- **Change:**
  - Use options objects throughout: `implement(c, {behavior, state, snapshot})`, `implementTransparent(c, {behavior})`, `implementQuery(c, {run})`, `implementBatchedQuery(c, {resolve})`.
  - Delete `Query` and the flat `batched`.
  - Optionally make `query.batched` a plain `batchedQuery(name, opts)`.
- **Callers:** `implementQuery` in about 35 files, `Query.batched` in 5, `query.batched` in 4.
- **Lines removed:** about 8.
- **Risk:** low (mechanical).
- **Public API change:** yes.
- **Wire or stored format change:** no.

### A9. Remove the hidden defaults on `query`: `version` and `depends` become required

- **Files:** `src/actor/query.ts:52-70,93,98`.
- **Problem:**
  - `version` defaults to 1 while `contract` requires it (`contract.ts:43`). 42 of 52 `query(` declarations omit it, 11 of them in apps (dashboard 6, blog 3, notes 2). Counted with `scratchpad/arch/qv.py`.
  - `depends` defaults to `[]`. 26 of 52 omit it, all in tests. A forgotten `depends` compiles and means commands never make the query stale.
- **North star:** explicit. `depends: []` is written on purpose, like allow-all.
- **Change:** make both required and delete the `?? 1` / `?? []` defaults.
- **Lines removed:** 2 in source, plus about 70 call-site additions.
- **Risk:** low.
- **Public API change:** yes.
- **Wire or stored format change:** no. The version value stays 1.

### A10. Consistent QueryCache names: `QueryCache.layer`, and `openQuery` instead of `useQuery`

- **Files:** `src/actor/client.ts:73-74`, `src/actor/query-client.ts:1304-1333`.
- **Problem:** Q3 layer and query-read rows. `queryCacheLayer` has 18 importers; `useQuery` has 24.
- **North star:** explicit (no hook naming convention).
- **Change:** move `layer` into the existing `QueryCache` namespace next to `layerTest`. Rename `useQuery` to `openQuery`, matching `QueryCacheService.open`.
- **Lines removed:** 2.
- **Risk:** low (mechanical).
- **Public API change:** yes.
- **Wire or stored format change:** no.

### A11. Replace the QueryCache WeakMap side channel with a Context service

- **Files:** `src/actor/query-client.ts:310-367,862-866,1299-1300,1426-1440`, `src/actor/ref.ts:169-188`, `src/actor/streaming.ts:182`, `src/router/branch.ts:1341`, `tests/actor/command-cache.test.ts:340-3xx`.
- **Problem:**
  - Two module-global WeakMaps (`internals`, `documents`) attach hidden capabilities to one service value.
  - `ref.ts` and `openStamped` branch on whether this module built the cache.
  - The only other adapter is one test's wrapper (`command-cache.test.ts:349`). `rg 'QueryCache\.of\(|succeed\(QueryCache|satisfies QueryCacheService'` finds nothing else.
  - The result is a one-adapter seam kept alive by a test, plus a global singleton.
- **North star:** effect-native (services come from Context) and explicit.
- **Change:** have the same layer provide a second, non-exported service (`QueryCacheInternals { claim, openStamped, document }`). Read it with `Effect.serviceOption` where `internalsOf` and `documentOf` are read today. Delete the WeakMaps, the fallback branches and the custom-cache test. Alternatively make `QueryCacheService` opaque.
- **Lines removed:** about 45.
- **Risk:** medium.
- **Public API change:** yes, if the service becomes opaque; otherwise no.
- **Wire or stored format change:** no.

### A12. QueryCache slot state and `followQuery` state move into one ref

- **Files:** `src/actor/query-client.ts:410-600` (slot), `:1448-1551` (`followQuery`).
- **Problem:**
  - The slot keeps its state in two places: a `SubscriptionRef` and seven closure `let`s (`own`, `pending`, `readStarted`, `freshAfter`, `inflight`, `generation`, `granted`, at `:422-464`).
  - The `let`s are written inside `SubscriptionRef.update` callbacks (`:426-431`, `:436-441`) and inside `Effect.suspend`.
  - `followQuery`'s `let current` (`:1459`) is written by the args follower fiber and read by `refresh` and `override`.
  - These are writes outside any message.
- **North star:** actor-model, effect-native.
- **Change:** one `SlotState` record in a `SynchronizedRef`, updated by pure transitions (land, fail, refresh, recount, forget), and `current` in a `SynchronizedRef`. Run this as its own pass, with `revocation`, `command-cache`, `streaming-*` and `query` tests as the gate.
- **Lines removed:** about 0 net.
- **Risk:** high (subtle ordering).
- **Public API change:** no.
- **Wire or stored format change:** no.

### A13. One resolved policy table; delete the unreachable branches

- **Files:** `src/actor/policy.ts:164-182`, `src/actor/host.ts:111,167-176`, `src/actor/query-host.ts:229-233,293-305`.
- **Problem:** the case "the name is not in the table" is impossible after `validate` (`host.ts:111`), but it is handled twice and differently:
  - `host.ts:170-173` returns `Unauthorized`, with the comment "Unreachable".
  - `query-host.ts:299-302` returns `PolicyMissing`.
  - `query-host.make` is called only from `host.ts` (`QueryHostOptions` doc at `:232`: "already validated").
  - This is one concept with two owners, and a guard expressed as a comment.
- **North star:** explicit, expressive.
- **Change:** `validate` returns a `Resolved` table whose lookup is total for declared names. Delete both `Option.isNone` branches. `PolicyMissing` stays in the wire decode union (`http/wire.ts:216`), so the wire does not change.
- **Lines removed:** about 12.
- **Risk:** low.
- **Public API change:** no.
- **Wire or stored format change:** no.

### A14. One way to hold view-local state: delete `Cell` (owner may prefer the reverse)

- **Files:** `src/actor/cell.ts` (35 lines), `src/actor/client.ts:105`; tests `local.test.ts`, `source.test.ts`, `types.test.ts`, `inspection.test.ts`, `view/dom.test.tsx`, `view/testing.test.tsx` (12 calls).
- **Problem:** `Cell.make` has 0 callers in apps or tooling. The apps use `spawn(Behavior.value(x))` 6 times (`apps/dashboard/src/views.tsx:50`, `overview.tsx:164`, `apps/notes/src/views.tsx:136`, `page.tsx:60,63`, `terminal-view.tsx:32`) and tooling twice. `Cell` also swallows `ActorStopped` without saying so (`cell.ts:25-26`).
- **North star:** actor-model (view state is visibly an actor) and explicit (no swallowed failure).
- **Change:** delete `Cell` and migrate the 12 test calls. The alternative is to move the apps to `Cell` and document the swallow.
- **Lines removed:** about 35.
- **Risk:** low.
- **Public API change:** yes.
- **Wire or stored format change:** no.

### A15. Comments that tell history

- **Files:** 20 actor files, 44 hits (`rg -c '\(#[0-9]+|#[0-9]+ §' src/actor/*.ts`). The largest counts are `query-client.ts` 9, `client.ts` 4, `query.ts`, `form.ts`, `host.ts` and `streaming.ts` 3 each.
  - Section comments: `client.ts:31,67,106,110`, `index.ts:27,41`.
  - `query.ts:161`: "Ticket #16 builds readiness over this same union" (the work is done).
- **North star:** explicit (the comment states what holds now).
- **Change:** delete the ticket markers or restate them as present-tense rules.
- **Lines removed:** about 44 edits.
- **Risk:** none.
- **Public API change:** no.
- **Wire or stored format change:** no.

### A16. Read-ahead capability on a Source (owner question)

- **Files:** `src/actor/read-ahead.ts:14-84`, `src/view/readiness.tsx:201,224`.
- **Problem:** a symbol property carries the held patch on the entry's Source. `select` or `zip` over that Source silently drops it (doc at `:14-16`), so `ready(select(entry.state, f))` behaves differently from `ready(entry.state)` with nothing visible at the call. `ahead` is a synchronous `() => boolean` callback.
- **North star:** explicit, effect-native.
- **Partial change, which needs no owner decision:** `ahead: Effect<boolean>`.
- **Owner question:** should `ready` and `orErrored` take the entry (explicit) instead of a Source (expressive)? That trades one north star for another.
- **Lines removed:** about 0.
- **Risk:** low.
- **Public API change:** the owner-question part would be yes.
- **Wire or stored format change:** no.

### A17. `src/inspection.ts` and `src/inspection/` share a name; record shapes are defined twice

- **Files:** `src/inspection.ts:10-106,152-178`, `src/frame.ts:48-153,408-529`; importers `view/runtime.ts:39`, `router/url-state-runtime.ts:14`, `actor/query-client.ts`, `command-owner.ts`, `local-engine.ts`, `durable-engine.ts`, `router/router.ts`, `tests/actor/command-cache.test.ts:31`.
- **Problem:**
  - The internal registry module and the public `effect-frame/inspection` directory share one name.
  - Each record is written as a TS interface (with `Option`) and again as a Schema (with `NullOr`), plus a 90-line hand converter (`toSnapshot`, which uses `switch`).
  - `makeOwner` is a synchronous side effect.
- **North star:** explicit and locality; effect-native (`makeOwner`).
- **Change:**
  - Move `src/inspection.ts` to `src/inspection/registry.ts` (not exported).
  - Registrations return the public record types from `frame.ts`. The internal interfaces and most of `toSnapshot` go; the diagnostic bounding stays.
  - `makeOwner` returns an `Effect`.
- **Lines removed:** about 80.
- **Risk:** medium.
- **Public API change:** no.
- **Wire or stored format change:** no. `Frame.Snapshot` is unchanged.

### A18. Minted-ID provenance through a hidden WeakSet (owner question)

- **Files:** `src/actor/command-id.ts:35-52`, `src/actor/ref.ts:254`, `src/view/form.ts:15` (a deep relative import into `../actor/command-id.js`), `src/actor/generated.ts:211`.
- **Problem:** `ref.send(msg, {commandId})` predicts or waits depending on the invisible identity of the options object. The same data behaves differently depending on where it came from. It is forgery-proof on purpose (doc at `:29-33`).
- **North star tension:** explicit against actor-model correctness (a supplied ID must never be treated as fresh). This is an owner question, not a change.
- **Lines removed:** none proposed.
- **Risk:** n/a.
- **Public API change:** n/a.
- **Wire or stored format change:** no.

### A19. `ActorHost` has a hidden in-memory store default

- **Files:** `src/actor/host.ts:18-33,275-290`; about 20 test call sites of `ActorHost.make` or `layer` without `store` (`rg -n 'implementations[:,]' packages`). No app is affected: the apps use `layerMemory`, and `host-durable-object/src/frame-host.ts:179` passes `store`.
- **Problem:** when `store` is omitted, the host silently gives every actor a fresh memory store. A production host that forgets it loses durability without an error. `layerMemory` already exists as the explicit spelling, so two names mean the same thing.
- **North star:** explicit.
- **Change:** make `store` required on `layer` and `make`. Add `ActorHost.memoryStore` as the value tests pass.
- **Lines removed:** about 3.
- **Risk:** low.
- **Public API change:** yes.
- **Wire or stored format change:** no.

---

## Not worth a pass (under about 5 lines each)

- `RefOptions.resume` is required inside the options object but defaults when the object is omitted (`ref.ts:314`).
- `frame.ts:441` `toSnapshot` uses `switch`, not `Match.valueTags` (it goes away with A17).
- `DurableHostConfig` has a 100 ms `pollInterval` default Reference (`durable-engine.ts:83-86`). It is tuning, and the Durable Object host overrides it.
- `engine-types.ts:8` `Committed<State>` and `mailbox-store.ts:25` `Committed` share a name but have different shapes. Rename one.
- `keyOf(QueryKey)` sits beside `KeyOf<C>` (`query.ts:153`). Rename it `cacheKeyOf`.
- `ref.ts:195` keeps the `admissions` Map in `Effect.sync`. A `Ref` would do.
- `Value` is reachable both flat and as `Behavior.Value` (0 uses of the second).
- Two server-only markers: `serverOnly` (`implement.ts:13`) and `queryServerOnly` (`query-host.ts:33`).
- `inspection.ts:165` makes `rootId` with a global `crypto.randomUUID` inside `Effect.gen`. It is documented as a platform boundary.
- `ActorImplementation.open` is a public, type-erased field (`implement.ts:202`).

## Owner questions

- **A7:** placement constructor names (`Actor.local`/`remote` vs keeping `spawn`/`ref`).
- **A14:** whether `Cell` or `spawn(Behavior.value)` is the one way to hold view state.
- **A16:** whether `ready` takes a query entry instead of a Source.
- **A18:** whether minted-ID provenance should stay implicit.
- **`View.form.endpoint`** (`view/form.ts:39`, `apps/*/page.tsx` pass `"/actors"`): it duplicates `HttpTransport.layer({baseUrl})` and the `HttpServer` mount. A Context value for the form endpoint would remove it, but it touches the `http/` scope.
