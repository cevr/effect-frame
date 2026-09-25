# Architecture pass 1: agent DX trial

Rift: `/Users/cvr/Developer/personal/.rifts/effect-frame/arch-pass1` (effect-frame 0.26.1). No repo file was edited.

## Method and budget

- **Newcomer reading:** README.md, CONTEXT.md, and the four index files (`actor/index.ts`, `actor/client.ts`, `view/index.ts`, `router/index.ts`). None of them documents the signatures I needed. Before I could write a line, I also had to read into 14 implementation files: `behavior.ts`, `contract.ts`, `view.ts`, `control.ts`, `source.ts`, `actor.ts`, `query.ts`, `query-client.ts`, `query-host.ts`, `implement.ts`, `view/form.ts`, `readiness.tsx`, `router/route.ts` and `router/branch.ts`. That is about 20 reads before the first compile.
- **Cold compile:** it produced 16 errors from 3 root causes (friction 1, 3 and 4). All of them were fixed after 3 more reads.
- **Silent mistakes:** 4 mistakes compiled cleanly but were wrong at runtime or broke the codebase's conventions (friction 2, 5, 7 and 8).
- **Probe file:** a separate file, `mistakes.tsx.txt`, holds 12 deliberate first guesses. It records what the compiler says about each one.
- **Checks:** `tsgo`, the patched `tsc` running the Effect LS plugin (it extends the root tsconfig) and the repo's `oxlint` config are all clean on the final files.

## Friction points (JSX first)

1. **"PascalCase" does not tell you whether something is a JSX tag or an Effect.**
   - **Tried:** `<Loading fallback=...>{Child(props)}</Loading>`, because `Show`, `For`, `Match` and `Query` are all tags.
   - **Got:** `TS2786 'Loading' cannot be used as a JSX component … Type 'Effect<Node, unknown, unknown>' is not assignable to type 'Node'`.
   - **Why:** `Loading` and `Errored` are Effects to `yield*`. The readiness `Query` has the same PascalCase but is a synchronous tag. `View.list` is an Effect, while `For` is a tag for the same job. The reverse mistake, `yield* Show(...)`, gives `TS2488 Type 'ShowNode<boolean>' must have a '[Symbol.iterator]()'`, which points nowhere useful.
   - **Fix:** Call `Loading({ fallback, children: CounterView(props) })`.
   - **What would have prevented it:** One naming rule, for example: PascalCase always means a sync tag, and Effect-returning boundaries are lowercase (`View.loading`, `View.errored`, `View.list`). Failing that, a README table of every view export and its kind (tag or yield).
   - **North star:** explicit over implicit, declarative.

2. **`bind` and `event` are exported twice, and the apps use only one form.**
   - **Tried:** `import { bind, event } from "effect-frame/view"`. `view/index.ts` exports them flat and as `View.*`.
   - **Got:** Compiled. The apps use `View.bind` and `View.event` 56 times and the flat forms 0 times.
   - **Fix:** Switch to the `View.*` forms.
   - **What would have prevented it:** One export path. Drop the flat re-exports, or ban them with a lint rule.
   - **North star:** explicit.

3. **Keyed `For` loses its item type when `each` is written inline.**
   - **Tried:** `<For each={View.select(count, s => s.changes)} keyBy={(c) => ...}>`.
   - **Got:** `TS18046 'change' is of type 'unknown'`. The error points at `keyBy`, not at the real cause, which is TypeScript deferring inference over context-sensitive JSX props.
   - **Fix:** Hoist the source into a variable, or annotate `keyBy={(c: Change) => ...}`. Every `For` in the apps carries that annotation, which shows the problem is known.
   - **What would have prevented it:** Doc on `ForProps` saying "annotate keyBy". Alternatively, a lint rule, or an API where `keyBy` is not context-sensitive, for example a field name (`key="seq"`).
   - **North star:** expressive.

4. **Route data gives `Source<RemoteActorRef>`, not a reference.**
   - **Tried:** `View.select(props.data.counter, r => r.state)` and `counter.send(...)`.
   - **Got:** A wall of `FollowedQuery<unknown> | Source<RemoteActorRef<AnyContract>> | undefined` errors. This happened because I had typed props by hand as `SegmentProps<{}, {}, any>`. Once `Route.PropsOf<typeof seg>` was in place (found only in `branch.ts`; README never names it), the remaining problem was that no `Source.flatMap` or `switch` exists.
   - **Fix:** A hand-written `stateOf`, `{ get: flatMap, changes: Stream.switchMap }`.
   - **Where the answer was:** `apps/dashboard/src/commands.ts` `snapshotOf`. `apps/notes/src/page.tsx` solves the same problem a different way, with a hand-made `View.list` keyed over the reference Source. `View.form` still needs a bare ref, so I also wrote `yield* props.data.counter.get`, which goes stale if the key moves. A reviewer would flag it.
   - **What would have prevented it:** `Source.switchMap` (or `Source.flatten`). A `Route.PropsOf` line in README's Routing section. A `data.x.state` convenience on actor bindings.
   - **North star:** actor-model, Effect-native.

5. **Intrinsic JSX is untyped: any tag, any attribute name, any event name.**
   - **Setup:** `IntrinsicElements { [tag: string]: ElementProps }`.
   - **Got:** `className="y"`, `onClik={View.event(...)}` and `<form onSubmit={View.event(...)}>` all compile. The last one should be `View.submit`, and without it the browser posts natively. All of these are silent.
   - **Why the errors that do appear don't help:** errors only come from the value type (`RawProp`). So a raw `Source` child gives `Type 'Source<number>' is not assignable to type 'RawProp'`, and a React-style `onClick={() => ...}` gives `Type '() => Effect' is not assignable to type 'RawProp'`. Neither error says "wrap in View.bind" or "wrap in View.event".
   - **What would have prevented it:** Typed intrinsics, or at least `on${Capitalize}` keys typed as `Prepared` and a named brand error (`{ "wrap with View.bind": Source<A> }`), in the same style as `Form.Covered`.
   - **North star:** explicit, expressive.

6. **A missing `Loading` is reported far from the cause.**
   - **Tried:** `ready(...)` with no `Loading` around it.
   - **Got:** No error at the view or the leaf. `LoadingScope` surfaces only in `Tree<"p", … | LoadingScope | …>` and in `mount`'s `R`.
   - **What would have prevented it:** Have `Route.leaf` or the mode constructors reject `LoadingScope` and `ErroredScope` in `R`, with a named brand error.
   - **North star:** explicit.

7. **`View.form` accepts a message the plain post can never decode.**
   - **Tried:** A contract `Increment { amount: Schema.Finite }` with `View.form({ message: Increment, typed: ["amount"] })`. Earlier I had also tried a parallel `IncrementForm` schema.
   - **Got:** Compiles. A runtime probe shows `Form.codec(...)` fails on `amount="5"` with `Finite` and succeeds with `FiniteFromString`. `Form.codec` does refuse the union at compile time, but neither `View.form` (`Covered` only) nor `HttpServer.form` (`contracts: AnyContract[]`) applies `Codable`. The parallel schema compiled too, even though the server decodes with the contract's schema.
   - **Fix:** Use `FiniteFromString` in the contract.
   - **What would have prevented it:** `Form.Codable<M>` on `CommandForm.message`, and requiring `message` to be a member of `contract.raw.message`.
   - **North star:** explicit, actor-model (one wire).

8. **Docs and app code disagree on how to name a view.**
   - `View.View` says "A named view is `Effect.fn("Name")(function*…)`". I wrote it that way. No app view does this; every one is an arrow that returns `Effect.gen`.
   - No app uses `Show` or `Match`, so the task's conditional has no precedent to copy.
   - The notes app hand-rolls a `filtered` Source that `Source.zip` already covers.
   - **North star:** declarative.

9. **Names collide across subpaths.**
   - `Loading` means `QueryState.Loading` in `actor/client` and the boundary in `view`.
   - `Query` means the server namespace in `actor` and a JSX tag in `view`.
   - `mount` is exported by both `view` and `router`.
   - An agent that auto-imports picks the wrong one.
   - **North star:** explicit.

10. **Newcomer docs are stale or duplicated.**
    - README "Current state" says "does not yet contain a framework runtime".
    - CONTEXT.md defines Server module, Browser entry and Shown branch twice.
    - README never gives the signature of `Route.PropsOf`, `Route.actor` or `Route.query`, and never shows the `Source<Ref>` binding shape.
    - `RouteDefinition.search` is required on a flat route but optional on a segment.
    - **North star:** explicit.

11. **Good signals.**
    - The Effect LS `schemaNumber` diagnostic (it suggests `FiniteFromString`) was the most helpful message of the run.
    - `Form.Covered` and `Match` exhaustiveness are the right error style.
    - The `TS2786` for view-as-tag at least names Effect vs Node.

## Where a reviewer would say "not how we write it here"

- Flat `bind` and `event` should be `View.*`.
- `View.select` should be `select` from `actor/client`.
- A reducer written with `switch` should use `Match.tagsExhaustive`. I fixed this.
- `Effect.fn` views should be arrow plus `Effect.gen`.
- The `yield* data.x.get` ref snapshot is not how the apps take a ref. The notes app keys a `View.list` on the ref Source.
- Ternaries are banned by `effect(noTernary)`. I fixed these.

## Top 5 changes, ranked by how many of my mistakes each prevents

1. **One kind rule for view exports.** PascalCase is a sync tag; Effects are lowercase, e.g. `View.loading`, `View.errored`, `View.list`. Collapse the duplicate exports and colliding names. Prevents #1, #2, #9, part of #8 (4-5 mistakes).
2. **Typed intrinsic JSX with branded "wrap with" errors** for raw Source, plain-arrow handlers and unknown `on*` props. Prevents #5 (4 probe mistakes) and speeds up #3.
3. **`Source.switchMap`/`flatten`, plus `data.actor.state` on actor bindings,** so `View.form` and `send` can take the binding. Prevents #4 and the stale-ref snapshot (3 mistakes, and removes the two hand-rolled app helpers).
4. **Apply `Form.Codable` and membership checks in `View.form` and `HttpServer.form`.** Prevents #7 (2 silent runtime refusals).
5. **A README "view cheat-sheet":** `Route.PropsOf`, `Route.actor`/`query` binding shapes, the `For` keyBy annotation, and reject `LoadingScope` at the leaf. Also remove the stale "Current state" text. Prevents #3, #6, #10 (3 mistakes).

## Trial files

Directory: `/private/tmp/claude-501/-Users-cvr-Developer-personal-bible-tools/3dd9474e-25f1-431c-bda5-218a3a8275f2/scratchpad/arch/trial/`

| File | What it is |
|---|---|
| `counter.ts` | Contract, reducer and query contract |
| `counter.server.ts` | `implementTransparent` and `implementQuery` |
| `counter-view.tsx` | Final route and view |
| `tsconfig.json` | tsgo config, `source` condition |
| `tsconfig.lint.json` | Extends the root tsconfig, with the Effect LS plugin |
| `counter-view.cold.tsx.txt` | First version that compiled |
| `mistakes.tsx.txt` | 12 first-guess probes |
| `probe-form.ts.txt` | Runtime probe of `Form.codec` |
| `probe-scope.tsx.txt` | Missing `Loading` probe |
