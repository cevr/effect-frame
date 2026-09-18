# Solid 2, SSR, and OpenTUI compatibility

Date: 2026-09-18.
Ticket: [Verify Solid 2, SSR, and OpenTUI renderer compatibility](https://github.com/cevr/effect-frame/issues/2).
Method: primary source review and live package metadata checks.
Status: research complete. Runtime compatibility is not yet proved.

## Result

One view model can plausibly supply values, operations, and owned resources to all three targets. Solid 2 supplies the reactive graph and a custom host interface. Its compiler has DOM, SSR, and universal output modes. This supports a shared source model with target adapters. It does not establish that one compiled JSX module can run unchanged on all targets. HTML and terminal elements have different properties and event contracts. These are source-based conclusions, not runtime test results. See S1, S2, O1, and O4.

The existing OpenTUI Solid binding is a Solid 1 binding. It needs a Solid 2 port or a new Solid 2 adapter over OpenTUI Core. Changing its peer range alone cannot make it compatible. Its copied renderer uses the old effect signature. Its helpers use removed Solid APIs. Its compiler uses the Solid 1 Babel preset. See O1–O4 and S2–S3.

No public owner API, component API, or shared element vocabulary is selected here.

## Version evidence

| Source                                                       | Verified state                                           | Meaning                                                                                                     |
| ------------------------------------------------------------ | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Solid `next` Git source                                      | `e171fc2157264d1846d5c81a368b98142f362a1b`               | All five inspected packages declare `2.0.0-rc.8`.                                                           |
| npm `solid-js`                                               | `latest=1.9.15`, `next=2.0.0-rc.8`, `beta=1.10.0-beta.0` | An unqualified install selects Solid 1.                                                                     |
| npm `@solidjs/signals`, `@solidjs/web`, `@solidjs/universal` | `latest=2.0.0-rc.0`, `next=2.0.0-rc.8`                   | Select versions explicitly.                                                                                 |
| npm `@solidjs/compiler`                                      | `latest=2.0.0-rc.2`, `next=2.0.0-rc.8`                   | An unqualified compiler install does not match the current RC.                                              |
| npm `solid-js@2.0.0-rc.8`                                    | `gitHead=f8b40b7e2049d67ceebe1d2e90a1029eb64e097d`       | The published RC and current `next` source are different commits.                                           |
| OpenTUI Git source                                           | `c01292fd0837bafd07ce458c74416b2b375a41ab`               | `@opentui/solid` declares `0.5.11`.                                                                         |
| npm `@opentui/solid`                                         | `0.5.11`; exact peer `solid-js=1.9.12`                   | This release does not accept Solid 2. It depends on `babel-preset-solid=1.9.12` and `@opentui/core=0.5.11`. |
| Solid first-party Effect example                             | `effect=^3.22.0`                                         | It is useful prior work. It is not proof of an Effect 4 adapter.                                            |
| Local Effect source used for scope review                    | `effect=4.0.0-rc.112`                                    | Installed under Effect Encore. No claim about the latest npm Effect version.                                |

Commands: `git ls-remote`, `git rev-parse HEAD`, `npm view <package> dist-tags --json`, `npm view @opentui/solid version peerDependencies dependencies --json`, and `npm view solid-js@2.0.0-rc.8 gitHead --json`.

Package sources: S0, O0, E0. Primary registry endpoints: [Solid metadata](https://registry.npmjs.org/solid-js), [Signals metadata](https://registry.npmjs.org/@solidjs%2fsignals), [Web metadata](https://registry.npmjs.org/@solidjs%2fweb), [Universal metadata](https://registry.npmjs.org/@solidjs%2funiversal), [Compiler metadata](https://registry.npmjs.org/@solidjs%2fcompiler), [OpenTUI Solid metadata](https://registry.npmjs.org/@opentui%2fsolid).

The previous source caches remain unchanged. Their commits were Solid `e1e9f8cec3549ac5fd252381bc362aa9a5249a64` and OpenTUI `6b9863ea7c5fae22bfebb23c242ddcc4c2b0aa0e`. Fresh temporary clones hold this review's source. The effect-frame repository had no package manifest or installed binding. Therefore, the OpenTUI result is a source and publication check, not a check of an effect-frame installation.

The published Solid commit has the same three compiler modes and the split universal effect signature. However, five relevant files differ from current `next`: the universal renderer, compiler types, async core, SSR signals, and SSR renderer. Their combined diff has 1,690 insertions and 277 deletions. Do not transfer current-source fixes to the npm RC by version label alone. The fetched publication commit is available in `/tmp/effect-frame-solid-current/.git`. See S0–S6.

## Verified source contracts

### Renderer and compiler

`@solidjs/universal.createRenderer` takes element, text, property, insertion, removal, parent, child, and sibling operations. Current source also accepts an optional sentinel and bulk cleanup operation. Its `effect` takes separate compute and apply functions. `render` creates a root, flushes the first mount, and returns an idempotent disposer that removes mounted nodes. See S1.

The compiler accepts `generate: "dom" | "ssr" | "universal" | "dynamic"`, `moduleName`, and `hydratable`. The default module is `@solidjs/web`. Universal fixtures import host functions from the selected module. Dynamic attributes use the split effect signature. A terminal build must expose the exact generated helper names and behavior, including refs and spread handling. See S2.

Solid 2 exports `merge`, `omit`, and `onSettled`. Its source marks `onMount` as not implemented. The old one-function `createEffect` form is invalid. Current OpenTUI imports `mergeProps`, `splitProps`, and `onMount`, and uses the old effect form in its portal helper. Thus, the port extends beyond the copied renderer. See S3 and O3.

OpenTUI's Babel transform selects `generate: "universal"` and `moduleName: "@opentui/solid"`. Its Bun plugin rewrites Solid 1 server entry files to client entry files. Solid 2 has conditional server and browser exports and does not expose those old deep paths in its export map. A new terminal build must select the live reactive implementation for both Solid and its dependencies. It must prove that all imports share one runtime instance. The old path rewrite is not a verified Solid 2 solution. See S0 and O2.

The OpenTUI host has behavior beyond a minimal tree. Text requires a text parent. Removal waits until the next tick before destroying an unattached node. Slots and scroll boxes change parent lookup. Static and dynamic text use different entity handling. Solid 2's host receives optional static properties at element creation and has a sentinel operation. A port must check these differences. Directly copying the OpenTUI hooks into the Solid 2 interface is not proved safe. See O1 and S1–S2.

The host interface does not execute an Effect returned as a node. The first-party Effect adapter instead converts the Effect to an AsyncIterable, which a Solid computation consumes. An Effect-aware view model therefore needs an explicit adapter boundary. The source does not require a new JSX language. A compiler transform would be additional work only if the chosen public API asks JSX to perform new implicit Effect operations. See S1 and S7. This is a design inference.

### SSR and hydration

Use a DOM build and a separate SSR build of the same web view source. Use matching hydration options and the Solid 2 web runtime. A universal terminal build does not produce the web renderer's HTML and hydration records. The upstream parity test already uses this separate-build pattern. See S2 and S8.

Solid documents three source policies. `server` adopts serialized data without an initial client computation. `hybrid` adopts the data and then starts client work. `client` defers the computation until hydration completes. Owners and IDs must stay aligned. An extra client-only owner can shift later IDs. The documented `transparent` option has a narrow integration use; it is not a general fix for different server and client trees. See S9.

The async server implementation distinguishes a first value used in document HTML from later serialized stream values. A hybrid iterator closes after its first value. An unbounded stream needs an explicit SSR policy. It must not keep the initial HTTP response open forever by accident. Use a bounded initial snapshot or a tested client takeover policy. The last two sentences are recommendations. See S6 and S9.

`renderToString` warns that it cannot serialize async data. `renderToStream` handles async output. Current stream code disposes the Solid graph when the sink fails or the consumer cancels. This is not proof that Effect finalizers have completed. See S5–S7.

### Ownership and cleanup

Solid restores ownership separately from dependency tracking. `runWithOwner` sets tracking to false. `createRoot` calls `createOwner`, which attaches to the current parent when one exists. The source implementation takes precedence over the nearby comment that calls every root detached. Read reactive inputs during the tracked compute step. Pass their values into the lazy Effect program. A signal read after an async gap is not repaired by `runWithOwner`. See S3–S4 and S7.

The client async core calls the old iterator's `return()` when a flight is replaced or cleaned up. It ignores values from old flights. It observes rejected cleanup promises but does not await them. Server iterator helpers also do not await `return()`. Do not assume that SSR disposes every pending iterator at the same point as the client graph. The adapter must have an owner or request cancellation path independent of iterator consumption. See S4 and S6. The final two sentences are safety requirements inferred from these different paths.

The first-party Effect adapter starts a fiber from the iterator. Its `return()` forks interruption and returns immediately. Its owner cleanup calls `runtime.dispose()` without awaiting it. It also erases the service requirement with `any` and has an untyped fallback runner. These choices do not establish typed provision of services or awaited resource release. See S7.

Effect 4 RC.112 provides the missing lifetime tools. `Scope.fork` makes a child that closes with its parent. `Fiber.interrupt` completes after the fiber completes. Interruption is cooperative. `ManagedRuntime` registers started fibers in its scope and returns a Promise from `dispose`. Scope finalization can be sequential or parallel. A parallel parent scope does not prove application-specific release order. See E1–E3.

## Recommended adapter constraints

These are design conclusions. They are not tested implementation facts.

1. Keep one Solid graph per rendered tree. Supply typed Effect operations and sources at its boundary. Do not add a second authoritative UI state graph without a separate need.
2. Keep process services, each SSR request or terminal session, each subtree, and each operation at explicit lifetimes. Link child scopes to parents. Do not put request identity in a process-wide runtime.
3. On owner disposal, synchronously mark the adapter closed. Stop result publication. Request interruption. Record the shutdown operation so the host can await it.
4. Await the request or session shutdown operation before reporting final resource release. Use the same path after normal completion, render failure, client disconnect, and terminal exit.
5. Sequence exclusive resource replacement within Effect. A Solid cleanup callback cannot wait for the old finalizer before a new compute starts.
6. Preserve the Effect service and error types until the host boundary. Add compile-time failure cases for missing services. Define expected error presentation and defect handling separately.
7. Build or port a Solid 2 OpenTUI adapter. Replace the copied Solid 1 renderer and compiler wiring. Audit its context, portal, slot, event, and cleanup helpers.
8. Pin one complete Solid RC set for the proof. Record package integrity and source commit. Repeat the proof after changing any compiler or runtime package.

Basis: S0–S9, O0–O4, E0–E3. These constraints do not select public names or syntax.

## Smallest decisive proof

Use one host-neutral view model with an explicit input, one derived text value, one asynchronous read, and one operation. Use a fake Effect service with start, completion, interruption, and finalizer counters. Use a deferred finalizer to expose early shutdown. Supply a small web view and a terminal view. If identical JSX source is a requirement, use common host components with separate web and terminal implementations. Record that extra requirement before treating source reuse as proved.

Compile the web view twice, with DOM and SSR output. Compile the terminal view with universal output against the proposed Solid 2 adapter. Use real DOM hydration and OpenTUI's test renderer. An in-memory host alone proves only the universal protocol. It does not prove OpenTUI behavior. Upstream test patterns are S8 and O4.

| Test                      | Required result                                                                                                                                                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build and module identity | All generated helper imports exist. Every reactive import resolves to the same pinned live runtime within a target. SSR resolves to server entries. Missing Effect services fail type checking.                                                                             |
| Initial mount and update  | DOM and terminal show the same model values. Updating the explicit input changes text and a dynamic property after Solid flush. No work runs from an untracked signal read.                                                                                                 |
| Superseded read           | Start read A, then B. A receives interruption. Let A resolve late. Neither host displays A. B displays once. No unhandled rejection occurs.                                                                                                                                 |
| Pending and error output  | Verify initial loading, stale data during a new read, an expected service error, a defect, and recovery. Both hosts follow the stated policy.                                                                                                                               |
| Normal SSR and hydration  | Render bounded async data. Hydrate the output. Preserve DOM identity. Emit no hydration warning. Under `server` policy, start no duplicate client read. A later input update must still work.                                                                               |
| Streaming hydration       | Hydrate the shell before the final chunk arrives. Apply the later chunk. Preserve identity and perform no duplicate service read. Repeat with all chunks present before hydration.                                                                                          |
| Stream policy             | Under `hybrid`, verify initial data and one client takeover. Under `client`, verify declared first paint or loading fallback. Verify that a persistent source cannot hold a finite response open.                                                                           |
| Request isolation         | Render two interleaved requests with different service values. Each receives only its own value. Cancel one. The other still completes.                                                                                                                                     |
| Teardown                  | Exercise subtree removal, full DOM unmount, SSR sink failure, readable cancellation, render failure, and terminal destroy. Block the async finalizer. Shutdown must remain pending until it finishes. Finalize each resource once. Leave no active fiber or event listener. |
| Exclusive replacement     | Block A's release. Request B. B must not acquire the exclusive resource until A releases it.                                                                                                                                                                                |
| Terminal host fidelity    | Check empty placeholders, static and dynamic `&` and `<` text, node moves, refs, a portal or slot, and scroll-box child removal. Destroy only removed nodes. Do not destroy moved nodes.                                                                                    |

The minimum go/no-go slice is build identity, mount/update, superseded read, normal SSR/hydration, and awaited teardown on both hosts. Passing that slice proves a narrow shared boundary. The remaining tests are required before a general compatibility claim.

## Tests performed and limits

Performed: live npm metadata queries, remote-head checks, exact source reads, and a Git diff against the published Solid commit. No framework code was written. No dependencies were installed. No upstream or adapter runtime suite ran. No lint/typecheck/test command exists in the empty effect-frame source. The document change was checked with `git diff --check` before commit.

Not proved: current npm RC behavior, OpenTUI with Solid 2, async finalizer order across hosts, Effect 4 type preservation, streamed hydration of Effect-derived data, compiler output under the new terminal wiring, or terminal cleanup after a native renderer failure. The proof plan above is the remaining implementation work.

## Primary source inventory

All Solid links below are fixed to `e171fc2157264d1846d5c81a368b98142f362a1b`, unless stated otherwise. All OpenTUI links are fixed to `c01292fd0837bafd07ce458c74416b2b375a41ab`. The full local paths give the inspected file locations.

- **S0 — Versions and export conditions.** `/tmp/effect-frame-solid-current/packages/solid/package.json`; `/tmp/effect-frame-solid-current/packages/signals/package.json`; `/tmp/effect-frame-solid-current/packages/web/package.json`; `/tmp/effect-frame-solid-current/packages/universal/package.json`; `/tmp/effect-frame-solid-current/packages/compiler/package.json`. [Solid manifest](https://github.com/solidjs/solid/blob/e171fc2157264d1846d5c81a368b98142f362a1b/packages/solid/package.json), [web manifest](https://github.com/solidjs/solid/blob/e171fc2157264d1846d5c81a368b98142f362a1b/packages/web/package.json), [published source tree](https://github.com/solidjs/solid/tree/f8b40b7e2049d67ceebe1d2e90a1029eb64e097d).
- **S1 — Host contract and disposal.** `/tmp/effect-frame-solid-current/packages/universal/src/universal.ts:28` and `:573`. [Host interface and implementation](https://github.com/solidjs/solid/blob/e171fc2157264d1846d5c81a368b98142f362a1b/packages/universal/src/universal.ts).
- **S2 — Compiler contract.** `/tmp/effect-frame-solid-current/packages/compiler/types.d.ts:1`; `/tmp/effect-frame-solid-current/packages/compiler/__tests__/fixtures/universal/jsxAttributeValues/output.js:1`; `/tmp/effect-frame-solid-current/packages/compiler/__tests__/fixtures/universal/textInterpolation/output.js:1`. [Options](https://github.com/solidjs/solid/blob/e171fc2157264d1846d5c81a368b98142f362a1b/packages/compiler/types.d.ts), [dynamic attribute output](https://github.com/solidjs/solid/blob/e171fc2157264d1846d5c81a368b98142f362a1b/packages/compiler/__tests__/fixtures/universal/jsxAttributeValues/output.js), [text output](https://github.com/solidjs/solid/blob/e171fc2157264d1846d5c81a368b98142f362a1b/packages/compiler/__tests__/fixtures/universal/textInterpolation/output.js).
- **S3 — Solid 2 effect and exports.** `/tmp/effect-frame-solid-current/packages/signals/src/signals.ts:495`; `/tmp/effect-frame-solid-current/packages/solid/src/index.ts:1` and `:255`. [Effects](https://github.com/solidjs/solid/blob/e171fc2157264d1846d5c81a368b98142f362a1b/packages/signals/src/signals.ts#L495), [exports](https://github.com/solidjs/solid/blob/e171fc2157264d1846d5c81a368b98142f362a1b/packages/solid/src/index.ts).
- **S4 — Client ownership and cancellation.** `/tmp/effect-frame-solid-current/packages/signals/src/core/core.ts:2418`; `/tmp/effect-frame-solid-current/packages/signals/src/core/owner.ts:312` and `:403`; `/tmp/effect-frame-solid-current/packages/signals/src/core/async.ts:648`. [Owner restoration](https://github.com/solidjs/solid/blob/e171fc2157264d1846d5c81a368b98142f362a1b/packages/signals/src/core/core.ts#L2418), [root ownership](https://github.com/solidjs/solid/blob/e171fc2157264d1846d5c81a368b98142f362a1b/packages/signals/src/core/owner.ts#L312), [iterator cleanup](https://github.com/solidjs/solid/blob/e171fc2157264d1846d5c81a368b98142f362a1b/packages/signals/src/core/async.ts#L648).
- **S5 — SSR lifecycle.** `/tmp/effect-frame-solid-current/packages/web/src/server.ts:1646`, `:1725`, `:1801`, and `:2603`. [SSR source](https://github.com/solidjs/solid/blob/e171fc2157264d1846d5c81a368b98142f362a1b/packages/web/src/server.ts#L1801).
- **S6 — Server async and cleanup.** `/tmp/effect-frame-solid-current/packages/solid/src/server/signals.ts:332`, `:403`, `:1494`, and `:1705`. [Server iterator handling](https://github.com/solidjs/solid/blob/e171fc2157264d1846d5c81a368b98142f362a1b/packages/solid/src/server/signals.ts#L1494).
- **S7 — First-party Effect example.** `/tmp/effect-frame-solid-current/examples/effect/package.json:16`; `/tmp/effect-frame-solid-current/examples/effect/src/solid-effect.ts:40`. [Manifest](https://github.com/solidjs/solid/blob/e171fc2157264d1846d5c81a368b98142f362a1b/examples/effect/package.json), [adapter](https://github.com/solidjs/solid/blob/e171fc2157264d1846d5c81a368b98142f362a1b/examples/effect/src/solid-effect.ts).
- **S8 — Existing web test patterns, read but not run.** `/tmp/effect-frame-solid-current/packages/web/test/hydration/parity-harness.spec.tsx:1`; `/tmp/effect-frame-solid-current/packages/web/test/hydration/loading-late-fragment.spec.tsx:1`; `/tmp/effect-frame-solid-current/packages/web/test/server/server-diagnostics.spec.tsx:237`. [Parity harness](https://github.com/solidjs/solid/blob/e171fc2157264d1846d5c81a368b98142f362a1b/packages/web/test/hydration/parity-harness.spec.tsx), [late fragment](https://github.com/solidjs/solid/blob/e171fc2157264d1846d5c81a368b98142f362a1b/packages/web/test/hydration/loading-late-fragment.spec.tsx), [disconnect test](https://github.com/solidjs/solid/blob/e171fc2157264d1846d5c81a368b98142f362a1b/packages/web/test/server/server-diagnostics.spec.tsx#L237).
- **S9 — Documented hydration policies.** `/tmp/effect-frame-solid-current/documentation/solid-2.0/05-async-data.md:159`. [Source policies](https://github.com/solidjs/solid/blob/e171fc2157264d1846d5c81a368b98142f362a1b/documentation/solid-2.0/05-async-data.md#L159).
- **O0 — Binding versions.** `/tmp/effect-frame-opentui-current/packages/solid/package.json:61`. [Manifest](https://github.com/anomalyco/opentui/blob/c01292fd0837bafd07ce458c74416b2b375a41ab/packages/solid/package.json).
- **O1 — Host behavior and copied Solid 1 renderer.** `/tmp/effect-frame-opentui-current/packages/solid/src/reconciler.ts:59`; `/tmp/effect-frame-opentui-current/packages/solid/src/renderer/universal.js:1`. [Host](https://github.com/anomalyco/opentui/blob/c01292fd0837bafd07ce458c74416b2b375a41ab/packages/solid/src/reconciler.ts), [renderer](https://github.com/anomalyco/opentui/blob/c01292fd0837bafd07ce458c74416b2b375a41ab/packages/solid/src/renderer/universal.js).
- **O2 — Compiler and entry rewriting.** `/tmp/effect-frame-opentui-current/packages/solid/scripts/solid-transform.ts:1`; `/tmp/effect-frame-opentui-current/packages/solid/scripts/solid-plugin.ts:84`. [Transform](https://github.com/anomalyco/opentui/blob/c01292fd0837bafd07ce458c74416b2b375a41ab/packages/solid/scripts/solid-transform.ts), [Bun plugin](https://github.com/anomalyco/opentui/blob/c01292fd0837bafd07ce458c74416b2b375a41ab/packages/solid/scripts/solid-plugin.ts).
- **O3 — Integration helpers.** `/tmp/effect-frame-opentui-current/packages/solid/src/elements/extras.ts:1`; `/tmp/effect-frame-opentui-current/packages/solid/src/elements/hooks.ts:10`. [Portal](https://github.com/anomalyco/opentui/blob/c01292fd0837bafd07ce458c74416b2b375a41ab/packages/solid/src/elements/extras.ts), [hooks](https://github.com/anomalyco/opentui/blob/c01292fd0837bafd07ce458c74416b2b375a41ab/packages/solid/src/elements/hooks.ts).
- **O4 — Mount, destroy, test renderer, and JSX vocabulary.** `/tmp/effect-frame-opentui-current/packages/solid/index.ts:9`; `/tmp/effect-frame-opentui-current/packages/solid/jsx-runtime.ts:73`. [Entry](https://github.com/anomalyco/opentui/blob/c01292fd0837bafd07ce458c74416b2b375a41ab/packages/solid/index.ts), [JSX](https://github.com/anomalyco/opentui/blob/c01292fd0837bafd07ce458c74416b2b375a41ab/packages/solid/jsx-runtime.ts).
- **E0 — Installed Effect version.** `/Users/cvr/Developer/personal/effect-encore/node_modules/effect/package.json:4`.
- **E1 — Effect runtime ownership.** `/Users/cvr/Developer/personal/effect-encore/node_modules/effect/src/ManagedRuntime.ts:208` and `:292`.
- **E2 — Child scopes and awaited close.** `/Users/cvr/Developer/personal/effect-encore/node_modules/effect/src/Scope.ts:458` and `:534`.
- **E3 — Awaited interruption.** `/Users/cvr/Developer/personal/effect-encore/node_modules/effect/src/Fiber.ts:315`.

Prior notes used only to find source: `/tmp/effect-solid-v2-review.md` and `/tmp/effect-ui-source-notes.md`. Their findings were checked against the primary files above.
