# effect-frame

## 0.14.0

### Minor Changes

- [`5436837`](https://github.com/cevr/effect-frame/commit/54368373a506f9b7c8a35eeceaab47f9695e400a) Thanks [@cevr](https://github.com/cevr)! - Show optimistic sends on remote references ([#19](https://github.com/cevr/effect-frame/issues/19), [#67](https://github.com/cevr/effect-frame/issues/67)).

  New public surface on `effect-frame/actor` and `effect-frame/actor/client`:

  - `Behavior.predict`: an optional pure copy of `apply`. `Behavior.value` and `Behavior.reducer` have it. `Behavior.machine` does not.
  - `RefOptions.behavior`: give `ref` the actor's behavior. When it has `predict`, a send with a fresh command ID shows its predicted state at once.
  - `ActorRef.displayed: Source<Displayed<State>>` and `Displayed<State> = Applied<State> | Provisional<State>`. A provisional value has `revision: {_tag: "Provisional", base, depth}` and no number of its own.

  Behavior changes:

  - `ActorRef.state` on a remote reference is now `displayed.state`. With no `predict`, `displayed` is `applied` and nothing changes. `applied` stays committed.
  - A `predict` that throws during a replay drops only that command's prediction and logs `command.predict.defect`; the reference keeps following.
  - A committed state replaces the prediction. A rejected command leaves the pending log and the rest replays over the same base. An `Uncertain` command keeps its prediction. A supplied command ID never predicts.
  - Local and durable references never predict. Their `displayed` is their `applied`.

  Migration: a custom `ActorRef` implementation must add `displayed`. A custom `Behavior` needs no change.

## 0.13.0

### Minor Changes

- [`cd81747`](https://github.com/cevr/effect-frame/commit/cd817471f58fb461e5fef3871e03c17c0a787c28) Thanks [@cevr](https://github.com/cevr)! - Publish nested routes on the `Route` namespace of `effect-frame/router`, and `View.lazy` on `effect-frame/view`.

  New exports on `Route`:

  - Addresses: `segment`, `child`, `Segment`, `SegmentOptions`, `AnySegment`. A segment's type holds only its name, parent, search keys, printers, and `currentAt`.
  - Branches: `leaf`, `layout`, `Branch`, `AnyBranch`, `Tree`, `BranchRejected`. Segments and branches are branded: only the constructors make them.
  - Mount: `client(name, root)` mounts a tree from a branch of a root segment. `client(name, definition)` stays the flat form. It is now the one-leaf shorthand of the same model and runs on the same runtime.
  - Data: `query`, `actor`, `Declaration`, `Declarations`, `QueryDeclaration`, `ActorDeclaration`, `RouteData`, `Values`. A segment with declarations requires `data`.
  - Props: `SegmentProps`, `LayoutProps`, `PropsOf`, `LayoutPropsOf`. Segment views get `href`, `updateSearch`, and `replaceSearch`.
  - Presentation: `Pending`, `Presentation`, `Recovery`.
  - Checks: `target`, `redirect`, `Continue`, `Target`, `Redirect`, `Verdict`, `Before`, `BeforeInput`, `NavigationKind`, `Printable`, `RouteFailure`, `CheckNavigation`, `RedirectCycle`.
  - Links: `Linkable` (the shape `link` accepts) and `Current` (`"page" | "ancestor" | "none"`).

  New on `Link`: `current: Source<Route.Current>`. `Link` draws `aria-current="page"` on the destination and `aria-current="true"` on a segment the URL continues below. A segment is never current on not-found or on another route.

  New exports on `View`: `lazy`, `LazyImportFailed`, `LazyModule`.

  Leave checks, the browser commit, and navigation receipts stay private ([#56](https://github.com/cevr/effect-frame/issues/56)).

  Migration:

  - Routes built with `Route.client(name, definition)` need no source change.
  - `link` now takes `<Params, Search>` (decoded types) and accepts a flat route or a segment. Remove explicit type arguments: `link<"book", typeof P, typeof S, never>(book, ...)` becomes `link(book, ...)`. Inferred calls do not change.
  - `Route.Route` now extends `Linkable`, so it also has `searchAt` and `currentAt`. A `Route` object written by hand must add both.
  - `Route.client` is overloaded. A wrong flat definition is reported as TS2769, with the flat form's own error below it on the same property.
  - A flat route's `params` and `search` Sources now publish together, and only when the raw path record or the route's encoded search changes. A hash-only move, a write of a key the route does not decode (such as a `UrlState` key), a reordered query, and a search that decodes and encodes the same publish nothing. A raw path change that decodes to equal params (`/books/05` after `/books/5`) still publishes.

## 0.12.0

### Minor Changes

- [`1fb583f`](https://github.com/cevr/effect-frame/commit/1fb583f85a162c5f6de839c3e6f9e16eb8f0e4e0) Thanks [@cevr](https://github.com/cevr)! - Add the browser-safe `effect-frame/inspection` subpath for live inspection of a Frame root.

  - `Protocol`: the versioned (v1) wire contract.
    - `Protocol.wire` holds the fixed strings: `version`, `subprotocol`, `attachTokenPrefix`, `versionHeader`, `attachPath`, `rootsPath`, and `inspectPath`.
    - The schemas hold every bound: `InspectRequest` (with `RootSelector`, 1 to 256 characters with no control characters, and `DeadlineMillis`, an integer from 1 to 30000), `RootInfo` (with `RootId` and `RootName`), `SnapshotTooLarge`, `GatewayError`, and the reader documents `RootsResponse`, `InspectResponse`, `ErrorResponse`, and `ReaderResponse`.
    - `RootRpcs` and its one `Inspect` RPC are **unstable**: they are built with `effect/unstable/rpc`, so their types follow that module and can change with an Effect release. The wire format is versioned by `Protocol.wire.version`.
  - `attachGateway({ url, token })`: connects the current root's `Frame.Service` to a loopback inspection gateway (`127.0.0.1` or `localhost`) over one browser-originated WebSocket. It returns at once, retries with a delay that doubles from `initialRetryMillis` to `maxRetryMillis`, resets the delay only after a connection stayed open for one second, and stops when its scope closes. A throwing `onStatus` observer never stops the loop. It fails with `InvalidAttachOptions` for a malformed or non-loopback gateway URL, a malformed token, a non-finite or non-positive retry or open timeout, a `maxRetryMillis` below `initialRetryMillis`, or a root name with control characters.

  The subpath imports only `effect` core and `effect-frame/frame`. Import it from a development entry only; a production entry that does not import it carries no inspection, RPC, or socket code.

## 0.11.1

### Patch Changes

- [`4bf2d80`](https://github.com/cevr/effect-frame/commit/4bf2d80d3f0e9786d6b0f4c64003df4608743191) Thanks [@cevr](https://github.com/cevr)! - The `MailboxStore` conformance suite in `effect-frame/actor/testing` has two new cases. "a seen command ID is never admitted again" re-sends a committed ID after later commands and an advance and requires `Duplicate` with the first admission and its receipt, no pending entry, and no admission number spent. "a receipt outlives the retry bound" re-sends and reads the receipt once per pass of the 8-pass bound while other commands and autonomous changes commit, then requires the same receipt for a manual retry. A store that prunes receipts or re-admits a seen ID now fails the suite.

## 0.11.0

### Minor Changes

- [`900c30d`](https://github.com/cevr/effect-frame/commit/900c30da1eed6992a0ad1225f798a8a913796900) Thanks [@cevr](https://github.com/cevr)! - `send` now returns a command handle for local, durable, and remote references, and never fails. A handle has a `state` source (Sent, Admitted, Applied, Rejected, or Uncertain) and a `settled` effect. Durable and remote handles also carry `commandId` and `retry`. A local handle is never Uncertain.

  Durable and remote references own each command. The framework creates a fresh command ID with native secure crypto, or keeps a supplied `commandId`. A remote command runs one send and one same-ID call per pass, for up to 8 passes with a 10 second pass deadline and capped, jittered backoff. At exhaustion it stays `Uncertain{attempt: 8}` until `retry` settles it with the same ID and bytes.

  Breaking: `Applied.revision` is now a `CommittedRevision` (`{_tag: "Committed", value}`), and `ProvisionalRevision` is added. Wire, store, and change stream revisions stay numeric; `resumeCodec` decodes them as committed. `Receipt`, `SendError`, and the `Admitted` export are removed. `call` options for durable and remote references take an optional `commandId`. A remote `call` no longer fails with `Unreachable`: a lost reply or an unreachable host ends the wait with `Uncertain`, because the command may still commit. `CallError["remote"]` is now the remote rejections (`ActorStopped`, `CommandConflict`, `Unauthorized`, `ContractMismatch`, `UnknownContract`) or `Uncertain`.

  Remote commands claim their contract's live query entries, which stay stale until the last command settles and refresh after it applies. The claim is private to the cache that `queryCacheLayer` builds: `QueryCacheService` is unchanged, and a custom or wrapped cache keeps the public contract: the contract is invalidated when a command starts, and the reply's refreshes are applied when it settles. `Frame.inspect` now reports `commands` as `Available` with its retained records.

## 0.10.1

### Patch Changes

- [`adba70c`](https://github.com/cevr/effect-frame/commit/adba70c5b1182b35e5304e9d75e6dd66d355d548) Thanks [@cevr](https://github.com/cevr)! - Type `Frame.DiagnosticValue` as a `Schema.Codec`, not a `Schema.Schema`. A `Frame.Snapshot` schema then has no unknown encoding or decoding services, so a typed encode, decode, or RPC schema of a snapshot type checks. The runtime schema is unchanged.

## 0.10.0

### Minor Changes

- [`59211aa`](https://github.com/cevr/effect-frame/commit/59211aa3b290783512aa0857c5f62845151a9288) Thanks [@cevr](https://github.com/cevr)! - Add `View.attempt(setup, fallback)`. It runs one setup in a child Scope of its caller and keeps it open on success. On a typed failure, it closes the failed child and waits for its finalizers before the fallback starts in a fresh child. Defects and interruption skip the fallback, and a closed owner never starts either Effect. The result keeps the fallback's own error and requires `R | R2 | Scope`.

## 0.9.2

### Patch Changes

- [`ed2d341`](https://github.com/cevr/effect-frame/commit/ed2d341918a110cb3390f98e32673139b6812dfe) Thanks [@cevr](https://github.com/cevr)! - Fix keyed list reorder when rows swap. A moved row could anchor on a row that moved later, so a swap left rows out of order. A reorder now keeps the longest run of rows already in order and moves only the others, walking backwards so each anchor is already in its final place.

## 0.9.1

### Patch Changes

- [`982f1a9`](https://github.com/cevr/effect-frame/commit/982f1a9b1066447916909814bb85061f72dba84c) Thanks [@cevr](https://github.com/cevr)! - Type the router's not-found view with its own requirements. `mount` now requires the union of the routes' and the not-found view's services, so a not-found view can use `Router` or another service that no route needs.

## 0.9.0

### Minor Changes

- [`8bec38f`](https://github.com/cevr/effect-frame/commit/8bec38fe1e895401fd588860e1ac1a8c8c3cab45) Thanks [@cevr](https://github.com/cevr)! - Keep readiness content owners live while fallback presentation is active, including deferred keyed rows and nested boundaries. A queued attachment runs once after its node reaches the document, and it is dropped when its owner ends first.

  Add an optional host capability for constructing hidden nodes without claiming connected hydration nodes.

## 0.8.1

### Patch Changes

- [`b6b37a5`](https://github.com/cevr/effect-frame/commit/b6b37a586a142d9e62ddf31c8a19a212ed043481) Thanks [@cevr](https://github.com/cevr)! - Keep local actors and hosted durable implementations on their private command engines while preserving the existing actor and transport contracts.

## 0.8.0

### Minor Changes

- [`6359ee8`](https://github.com/cevr/effect-frame/commit/6359ee89d8f3367982507cddbd363ea9fb24f08a) Thanks [@cevr](https://github.com/cevr)! - Include bounded, optional Frame snapshots in failed ViewTest condition receipts.

## 0.7.2

### Patch Changes

- [`a7a6382`](https://github.com/cevr/effect-frame/commit/a7a6382750393bcf0c043968a21a1faf39d646c6) Thanks [@cevr](https://github.com/cevr)! - Keep dependent query entries stale after an admitted command send until a
  committed receipt or an authoritative refresh arrives. Committed duplicate
  sends retain their existing refresh behavior without applying the command
  again.

## 0.7.1

### Patch Changes

- [`6e2b399`](https://github.com/cevr/effect-frame/commit/6e2b399fd762928039aeac4ee81a147cdf33a5be) Thanks [@cevr](https://github.com/cevr)! - Release host event listeners with the branch, row, and mount scope that owns their element. Start view work only after that owner accepts it, so a closed owner cannot start stale handlers or attachment setup.

## 0.7.0

### Minor Changes

- [`e717f0a`](https://github.com/cevr/effect-frame/commit/e717f0ae7b1ed841043143273c4a66685604cd10) Thanks [@cevr](https://github.com/cevr)! - Add the browser-safe `effect-frame/frame` entry for scoped, schema-backed runtime inspection snapshots.

## 0.6.0

### Minor Changes

- [`a29c9b9`](https://github.com/cevr/effect-frame/commit/a29c9b900e3df3ed4891da62eceb331e23f14234) Thanks [@cevr](https://github.com/cevr)! - Add a scoped view testing harness that observes production host writes, owns
  mounted work, and reports bounded timeout diagnostics.

## 0.5.0

### Minor Changes

- [`d4eed34`](https://github.com/cevr/effect-frame/commit/d4eed349bd528dc1fba51f33adc5c3dd7efb1562) Thanks [@cevr](https://github.com/cevr)! - View-owned URL state with scoped encoded-key claims, canonical URL sources, serialized set and update operations, and explicit push operations.

### Patch Changes

- [`2647ee1`](https://github.com/cevr/effect-frame/commit/2647ee1e574eeb56628717a3e2e5225d8e524b48) Thanks [@cevr](https://github.com/cevr)! - Readiness registrations now leave `Loading` and `Errored` scopes with their owner scope, so removed or disposed view branches cannot keep a boundary pending or failed.

## 0.4.0

### Minor Changes

- [`2bf0bd8`](https://github.com/cevr/effect-frame/commit/2bf0bd8ee1eae2324495558ff83c154bb6c40568) Thanks [@cevr](https://github.com/cevr)! - Add local transport and query-host helpers for testing the real query cache.

## 0.3.0

### Minor Changes

- [`47cdfb0`](https://github.com/cevr/effect-frame/commit/47cdfb06f6dbc209085a0b6cb8e46d99178b3f5d) Thanks [@cevr](https://github.com/cevr)! - Attached behaviours and `Portal`. An element takes `attach={...}`: one or more behaviours, each an Effect given the host node (`Dom.attach((element) => Effect)`, `Tui.attach`), run once the node is in the document, in the scope of the branch or row that owns the element, so a listener, an observer, or a fiber the behaviour opened ends when the element leaves. There is no node reference. The server host never runs a behaviour. `<Portal into={node}>` draws children under another host node, owned by the branch that opened it. Hosts gain one operation, `attach`.

- [`e3ddec5`](https://github.com/cevr/effect-frame/commit/e3ddec54ede6d73bb77e79f9a44ad426e87a8f72) Thanks [@cevr](https://github.com/cevr)! - Add declared batched query contracts with per-key states, HTTP batching, authorization isolation, and single-flight refresh support.

- [`841a233`](https://github.com/cevr/effect-frame/commit/841a2331f1d046c6bb1fae152c3ebd4d9da4b8e6) Thanks [@cevr](https://github.com/cevr)! - Composable DOM behaviours: `Dom.focus(options)`, `Dom.scrollIntoView(options)`, and `Dom.observeSize(onSize)` are attachments a view lists on an element, `attach={[Dom.scrollIntoView({ block: "nearest" }), Dom.focus()]}`, each run once the element is in the document and ended with it. `Dom.afterPaint` is the Effect a behaviour yields when it needs layout first.

- [`c40ed46`](https://github.com/cevr/effect-frame/commit/c40ed46709abd122d78f2da64cb3f799f258c6dc) Thanks [@cevr](https://github.com/cevr)! - `Match`: exhaustive control over a source of a tagged union. `<Match on={state} cases={{ Idle: () => ..., Running: (s) => ... }} />` takes the case table of Effect's `Match.tagsExhaustive`, draws one branch, hands each case a source of its own member, and updates a kept tag in place. `Query` is now one `Match` over `QueryState`. `QueryState.match` takes the same case shape (`Ready: (state) => ...`, not `(value, stale)`) and has a curried form, `match(cases)`, that builds its matcher once for hot paths; `tests/perf/match.bench.ts` records why.

- [`ccf6470`](https://github.com/cevr/effect-frame/commit/ccf6470b26e461df5f65e3872c0f01286955f51d) Thanks [@cevr](https://github.com/cevr)! - Add scoped `Source.debounce`, `Source.throttle`, and `Source.mapEffect` derivations.

- [`8946cbf`](https://github.com/cevr/effect-frame/commit/8946cbf73f994a980b732889af6d834e80dc0db6) Thanks [@cevr](https://github.com/cevr)! - Typed links. `link(route, params, search)` yields a `Link` in a view's setup: the live href printed through the route's own Schemas, `active` (a source, `true` while the document is on that route), and separate `go` (push) and `replace` effects. `<Link link={l} replace class>` draws it as an anchor with a real `href` and `aria-current="page"`. `router.current` is a source of the current match (route name and URL), and `isActive(router, route)` derives from it.

- [`dd95567`](https://github.com/cevr/effect-frame/commit/dd95567ad5d4d51ec6ecf49db87d3c6269a1c0fd) Thanks [@cevr](https://github.com/cevr)! - Schema-driven route search state: omitted defaults, encoded key mapping, repeated values with lossless empty-array markers, string literal and union fields, serialized functional updates, retained keys, and separate push and replace navigation.

- [`c5917f5`](https://github.com/cevr/effect-frame/commit/c5917f51c84d9f993069c6f1c465d4efbcbdb73b) Thanks [@cevr](https://github.com/cevr)! - A view is a function. `View.make` is removed: a view is `(props) => Effect<Node, E, R>`, and a named view is `Effect.fn("Name")(function* (props) { ... })`. Compose a child with `yield* Child(props)`. `Loading`, `Errored`, and `Await` are now plain views: call them with their props and `yield*` the result. `View.list` names its row view `row`, not `setup`. `Route.spa` is renamed `Route.client`.

### Patch Changes

- [`a9d6665`](https://github.com/cevr/effect-frame/commit/a9d666500e0fb39c433a771d6f5c40f7967334bd) Thanks [@cevr](https://github.com/cevr)! - A keyed list (`For`, `View.list`) now moves only the rows whose position changed. Before, every emission re-inserted every row's nodes, which moved them in the document and dropped focus, selection, and scroll inside a row that had not moved.

## 0.2.0

### Minor Changes

- [`8559a4b`](https://github.com/cevr/effect-frame/commit/8559a4b3004d363a7e47e1a6c60c1fb7850534db) Thanks [@cevr](https://github.com/cevr)! - `Cell.make(initial)` is the local value a view keeps: `{ state, get, set, update }`, a `Behavior.value` actor underneath, and a write after its scope closed is a no-op. `Source.all({ a, b })` and `Source.all([a, b])` build one source from several with `zip`'s re-read rule, and `Source.on(source, f)` follows a source on a fiber in the current scope. The combinators are also exported flat (`all`, `on`, `select`, `zip`).

- [`8559a4b`](https://github.com/cevr/effect-frame/commit/8559a4b3004d363a7e47e1a6c60c1fb7850534db) Thanks [@cevr](https://github.com/cevr)! - `View.bind`, `View.event`, `View.submit` and `View.select` are module functions, and `View.Context` and `Capabilities` are gone. `bind` was already data, and a prepared event is now data too: the runtime forks the handler into the scope of the branch or row that owns the element, when the host fires. A plain function that returns a `Node` needs nothing from the view that calls it; a setup that reads no service needs no generator. Migration: delete `const view = yield* View.Context` and replace `view.bind` with `View.bind` (and so on), and drop `View.Context` from any `R` you named.

- [`8559a4b`](https://github.com/cevr/effect-frame/commit/8559a4b3004d363a7e47e1a6c60c1fb7850534db) Thanks [@cevr](https://github.com/cevr)! - Contracts and hosts say less. `query()` defaults `version` to 1, `depends` to none and `policy` to `"public"`, and every host resolves `"public"` without a `QueryPolicies` layer (a table entry of that name still replaces it). `ActorHost.layer` no longer requires `store`: omitted, each actor gets an in-memory mailbox, which is what a query-only host or a test wants.

- [`8559a4b`](https://github.com/cevr/effect-frame/commit/8559a4b3004d363a7e47e1a6c60c1fb7850534db) Thanks [@cevr](https://github.com/cevr)! - `View.list({ each, keyBy, setup })` is a keyed list whose rows run a setup Effect in a scope of their own: a row may make cells, follow queries and add finalizers, and the scope closes when the row leaves. A setup that completes at once builds before the mount returns; one that suspends lands in its place when it completes, and the mount closing interrupts it. `list` is an Effect, not a JSX element, because it captures the context it is yielded in and the enclosing view's `R` names what the rows need. `<For>` is unchanged and is the plain case of the same node.

- [`8559a4b`](https://github.com/cevr/effect-frame/commit/8559a4b3004d363a7e47e1a6c60c1fb7850534db) Thanks [@cevr](https://github.com/cevr)! - `Show` narrows. `when` takes any source with an `is` test (a type predicate narrows), the children may be a function of a source of the tested value that exists only while the branch is shown, and `fallback` draws otherwise. `Query` is the one control for a query's three states: `loading`, `failed(error)` and `ready(value, stale)`, each a source, with no placeholder value to name. `Await` is `Query` as a view and drops `before`. `QueryState` gains `isLoading`, `isReady`, `isFailed` and `match` (also under the `QueryState` name in both entries), and `QueryFailure` is a Schema with an `isQueryFailure` guard, so an `Errored` fallback narrows its `unknown` in one call.

### Patch Changes

- [`8559a4b`](https://github.com/cevr/effect-frame/commit/8559a4b3004d363a7e47e1a6c60c1fb7850534db) Thanks [@cevr](https://github.com/cevr)! - Document that an event handler's write lands after the host callback returns: the handler runs on a fiber of its own, so a script that fires an event and reads an actor in the same tick reads the old value.

- [`8559a4b`](https://github.com/cevr/effect-frame/commit/8559a4b3004d363a7e47e1a6c60c1fb7850534db) Thanks [@cevr](https://github.com/cevr)! - Give `ready`, `readyWithStale`, `orErrored`, `fakeQuery` and `Router.mount` explicit signatures. tsgo emitted their `Effect.fn` generics as unbound type parameters with `unknown` error and requirement types, which made every consumer of the published declarations infer `unknown` and fail to type check.

- [`8559a4b`](https://github.com/cevr/effect-frame/commit/8559a4b3004d363a7e47e1a6c60c1fb7850534db) Thanks [@cevr](https://github.com/cevr)! - A `Show` branch and a `For` row are built untracked inside the effect that switches them, so their first reads no longer trigger Solid's strict-mode untracked-read warning.

## 0.1.0

### Minor Changes

- First published release: actors, queries, views and the router, as proven by the egw-search port.
