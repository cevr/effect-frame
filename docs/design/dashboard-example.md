# Dashboard: many queries, one live stream, single flight at width (#40)

Dashboard is the example that runs many queries under one live stream and
proves that a command's cost is exact at width. It builds the Dashboard
section of #25 §4. Each acceptance row under "Dashboard — many queries, one
live stream, single flight at width" is now a test in `bun run gate`, and so
is the Dashboard half of the shared single-flight row. This document gives
the tests, the mutation that turns each one red, the decisions the build
made, and what stays Open.

## The shape

| Route                      | Mode             | Segment               | Data                                                                                                     |
| -------------------------- | ---------------- | --------------------- | -------------------------------------------------------------------------------------------------------- |
| `/`                        | redirect (`ssr`) | none                  | none; `before` sends the reader to `/d/acme`                                                             |
| `/d/:tenant`               | `Route.streamed` | `dash` (layout)       | `TenantInfo({tenant})`                                                                                   |
| `/d/:tenant?range=`        | (same tree)      | `overview` (leaf)     | `Revenue`, `Orders`, `Funnel` on `{tenant, range}`; `Slowest({tenant})`; actor `Alerts`, the live stream |
| `/d/:tenant/orders/…`      | (same tree)      | `orders` (layout)     | `Orders({tenant, range: "all"})`                                                                         |
| `/d/:tenant/orders`        | (same tree)      | `orders-index` (leaf) | `OrderDetail({tenant})`                                                                                  |
| `/d/:tenant/orders/:order` | (same tree)      | `order` (leaf)        | `TenantInfo({tenant})` again, as `info`: the shared declaration                                          |

| Query         | Depends on | Read by                                                                     |
| ------------- | ---------- | --------------------------------------------------------------------------- |
| `TenantInfo`  | `Alerts`   | the layout's header (name, plan, unacked alerts)                            |
| `Revenue`     | `Orders`   | the revenue card (fulfilled total in the window)                            |
| `Orders`      | `Orders`   | the overview's order card and the orders layout (`OrderList` in TypeScript) |
| `Funnel`      | `Orders`   | the funnel card, behind a tab                                               |
| `Slowest`     | nothing    | the slowest-endpoints card, under its own `Loading`                         |
| `OrderDetail` | `Orders`   | the open orders on the orders index                                         |

On `/d/acme` the page declares five keys. A `Fulfil` refreshes the three
that name `Orders`. An `Ack` refreshes `TenantInfo` alone. From
`/d/acme/orders` a `Fulfil` refreshes that page's two and not `Revenue`. A
`Write` to the memo refreshes nothing.

The page follows one live stream: `Alerts`. The order book and the memo are
only commanded. Each view that commands them holds a `commandRef`, which
sends and reads no snapshot and opens no change stream. On the overview the
client reads one actor snapshot and opens one change stream, both of
`Alerts` (`single-flight.test.tsx`: "the overview follows one live stream,
Alerts, and commands the rest"). Before this change it read three and
opened three: `Alerts`, `Orders` and `Memo`.

`DashShell` holds `Errored` outside `Loading`. Every card but the slowest
registers with that `Loading`. The funnel card mounts only when its tab is
revealed, after first paint.

## Rows, tests and mutations

Each mutation was applied alone by a script. The named test file was run
with `bun test --conditions=source`, from `apps/dashboard` for app tests
and from `packages/effect-frame` for package tests, and then the file was
restored. Every new test ran three times in a row, green each time.

| Row                                                                                         | Test (file: name)                                                                                                                                                                                                                                                                                                             | Mutation                                                                                                          | Result                                                     |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| One command refreshes its dependents on screen, in one reply                                | `single-flight.test.tsx`: "a Fulfil from the overview refreshes exactly its three dependents", "an Ack … names Alerts", "a Fulfil from the orders page refreshes its two dependents, not Revenue"                                                                                                                             | `Revenue` without `depends: [Orders]`                                                                             | Killed (2 tests)                                           |
| (same row)                                                                                  | (same tests)                                                                                                                                                                                                                                                                                                                  | `query-host.ts` `dependents` returns every active key                                                             | Killed (all single-flight tests)                           |
| A commit to an actor no query depends on does zero extra work                               | `single-flight.test.tsx`: "a Write to the memo, which no query names, refreshes none and runs no handler"                                                                                                                                                                                                                     | `TenantInfo` depends on `[Alerts, Memo]`                                                                          | Killed                                                     |
| (same row)                                                                                  | (same test)                                                                                                                                                                                                                                                                                                                   | `host.ts` `refreshFor` without its `stale.length === 0` early return                                              | Survived: equivalent, see below                            |
| The page follows one live stream                                                            | `single-flight.test.tsx`: "the overview follows one live stream, Alerts, and commands the rest"                                                                                                                                                                                                                               | the round-1 app: `Orders` and `Memo` as route actors                                                              | Killed (three snapshots, three streams)                    |
| Canonical args make `{a,b}` and `{b,a}` one entry                                           | `query.test.tsx`: "reordered arguments name one entry: its key is canonical"                                                                                                                                                                                                                                                  | `query-client.ts` `encodeKey` keeps the encoded string as written                                                 | Killed                                                     |
| (same row)                                                                                  | (same test)                                                                                                                                                                                                                                                                                                                   | `canonical-json.ts` `canonicalize` returns its input                                                              | Killed                                                     |
| A failed refresh answers `RefreshFailed` and does not undo the command                      | `single-flight.test.tsx`: "a failed refresh answers RefreshFailed, and the Fulfil still commits"                                                                                                                                                                                                                              | `host.ts` `call` dies when any refresh failed                                                                     | Killed                                                     |
| (same row)                                                                                  | (same test)                                                                                                                                                                                                                                                                                                                   | `query-host.ts` `dependents` returns every active key                                                             | Killed                                                     |
| Invalidate-on-send, accept-on-reply holds stale for the round trip                          | `query.test.tsx`: "revenue stays on screen, marked stale, from the Fulfil's send until its reply"                                                                                                                                                                                                                             | `query-client.ts` `claim` does not recount its dependents when it is made                                         | Killed (2 tests)                                           |
| (same row)                                                                                  | (same test)                                                                                                                                                                                                                                                                                                                   | `query-client.ts` `display` never marks a pending entry stale                                                     | Killed (2 tests)                                           |
| A dependent stays stale while any command is unsettled (#19)                                | `query.test.tsx`: "with two Fulfils in flight, the first reply does not clear stale"                                                                                                                                                                                                                                          | `query-client.ts` a released claim deletes every claim on its contract                                            | Killed                                                     |
| An override is dropped by any authoritative value and never rolled back on `Rejected` (#19) | `query.test.tsx`: "the override shows at once, stale, and the ack's refresh replaces it", "any authoritative value drops the override, before the ack lands", "a Rejected ack leaves the override; the next authoritative value replaces it", "an ack during a tenant switch never writes one tenant's header into another's" | `commands.ts` `ack` does not call `override`; `override` writes a value taken from the shown header (the old API) | Killed (3 tests); the tenant-switch test is red on db094cb |
| (same row)                                                                                  | (the Rejected test)                                                                                                                                                                                                                                                                                                           | `alerts.server.ts` the refuse rule matches no alert                                                               | Killed                                                     |
| A layout's declaration is one entry and one read for a three-deep branch                    | `query.test.tsx`: "the layout's TenantInfo is one entry and one read for a three-deep branch"                                                                                                                                                                                                                                 | none of its own; the package twin is `route-data.test.tsx`                                                        | Not mutated                                                |
| Declared data starts concurrently                                                           | `query.test.tsx`: "every declaration starts before the slowest one is released"                                                                                                                                                                                                                                               | `branch.ts` `allOrNothing` with `concurrency: 1`                                                                  | Survived: see below                                        |
| A key two segments declare survives one of them exiting                                     | `transition.test.tsx`: "a key two segments declare: the leaf exits, it stays; the layout's moves, it goes"                                                                                                                                                                                                                    | `query-client.ts` `openSlot` invalidates the slot when any one declaration closes                                 | Killed (2 tests)                                           |
| Five placeholders precede five patches; one actor seed in the first chunk                   | `streaming.test.ts`: "five placeholders precede five patches; one actor seed is in the first chunk"                                                                                                                                                                                                                           | `streaming.ts` `Closed` names every patched id but the first                                                      | Killed                                                     |
| A page request's Scope closes on every exit but a returned body                             | `server-scope.test.ts`: "a defect in the drawing closes the Scope and answers 500", "a redirect closes the Scope before it answers", "a returned body keeps the Scope until the body ends"                                                                                                                                    | `server.ts` `answerWith` does not close the Scope on a non-success exit                                           | Killed (the defect test)                                   |
| A nested `Loading` holds only its own card while the page paints                            | `readiness.test.tsx`: "a nested Loading holds only the slowest card while the page paints"                                                                                                                                                                                                                                    | `SlowestCard` without its `Loading` (the card registers with the shell's)                                         | Killed                                                     |
| A source registered after first paint flips its scope pending again                         | `readiness.test.tsx`: "the funnel card mounts late: the shell's scope goes pending again and settles"                                                                                                                                                                                                                         | `readiness.tsx` `derive` follows only the first set of registrations                                              | Killed                                                     |
| (same row, never connected)                                                                 | (same test, a `MutationObserver` on the app root)                                                                                                                                                                                                                                                                             | the 0.21.0 `runtime.ts` retained plan, before ede4df7                                                             | Killed (`#funnel-card` added twice)                        |
| (same row)                                                                                  | (same test)                                                                                                                                                                                                                                                                                                                   | `readiness.tsx` `pendingOf` treats an empty registry as settled                                                   | Survived here; killed by package tests, see below          |
| `active` names both branches during a transition and one after                              | `transition.test.tsx`: "active names both leaves while the overview enters, and one after"                                                                                                                                                                                                                                    | `branch.ts` `commitSlot` closes the exited view but does not release its interests                                | Killed (2 tests)                                           |
| (same row)                                                                                  | (same test)                                                                                                                                                                                                                                                                                                                   | `branch.ts` `commitSlot` releases the exited interests but does not close the exited view                         | Survived here; a different invariant, see below            |
| A session of N navigations declares a bounded set                                           | `transition.test.tsx`: "a session of 50 navigations declares only the current branch"                                                                                                                                                                                                                                         | `branch.ts` `commitSlot` does not release the exited interests                                                    | Killed                                                     |

Also in the suite, with no mutation of their own:
`readiness.test.tsx` "a failing Revenue settles the scope: exactly one
fallback, and no hang", and `boundary.test.ts` (the browser entry reaches no
server module; an injected `queries.server.js` import in `overview.tsx` is
refused with its chain).

Notes on the survivors:

- **`refreshFor` without its early return** is an equivalent mutant.
  `query.batch([])` answers `[]`, so the reply and the handler counts do
  not change. The early return saves a call, and nothing more.
- **`pendingOf` with an empty registry pending** is not equivalent in
  general. It survives here because the shell always registers `TenantInfo`
  during its own setup, so the Dashboard's scope is never empty. The
  package kills it: `tests/view/readiness.test.tsx` "a Loading with no
  registration shows its content", `tests/view/owned-attempt.test.tsx`
  "adds no readiness registration: an empty Loading shows its content", and
  `tests/router/nested-transition.test.tsx` "4. closes one child, then the
  root, with records removed in order" (its empty outlet shows the layout).
- **Releasing interests without closing the exited view** is not
  equivalent. It breaks a different lifetime invariant: the exited view's
  Scope, not the keys in `active`. The Dashboard tests check keys, so it
  survives here. The package kills it: `tests/router/route-data.test.tsx`
  "the leaf exits and the shared key stays; the layout exits and it goes",
  and `tests/router/nested-transition.test.tsx` "2. replaces the child
  under a retained layout and overlaps a shared key" and "4. closes one
  child, then the root, with records removed in order".
- **`allOrNothing` with `concurrency: 1`** survives because opening a
  declaration on the client does not wait for its value: the entry opens
  and its read starts, and the next part runs. The test pins what a reader
  sees, that every read has started while the slowest has not answered. A
  mutant that makes the opening wait for a value is more than a one-line
  change. The package twin is `nested-transition.test.tsx` "1. starts every
  declaration in parallel, then starts the unseeded child under the layout
  Loading".
- **No mutation targets the mid-transition half on its own.** Every change
  that would drop the exited keys before the entering leaf commits is more
  than a one-line edit to `commitSlot`. The package twin
  (`query-active.test.tsx`) holds the same claim.

## Counts the spec states differently

- **Six declarations, not eight.** #25 §4 says "eight declarations". The
  overview branch declares six: the layout's `TenantInfo`, `Revenue`,
  `Orders`, `Funnel`, `Slowest`, and the `Alerts` actor. The test counts
  six.
- **Five placeholders and one actor seed, not eight placeholders.** Since
  0.21.0 a route actor travels as an `ActorSeed` record, not a
  `Placeholder`. A route actor is settled before its view draws, so there
  is nothing to patch later, and its seed is written with the drawing in
  the first chunk. The streamed overview therefore writes five query
  placeholders, five patches, and one `ActorSeed`.

## Decisions

1. **A `Memo` actor was added.** The row "a commit to an actor no query
   depends on does zero extra work" needs such an actor, and the spec's
   tables name none. The shell writes it through a `commandRef`, so it is
   no live stream, and no `depends` list names it. The memo card shows the
   text the host committed for this page's last write, from the settled
   handle.
2. **Every argument record carries `tenant`, not `id`.** One policy,
   `tenantMember`, reads the same field off every actor key and every query
   argument. The spec's `TenantInfo({id})` is `TenantInfo({tenant})`.
3. **`TenantInfo` carries the unacked alert count.** That is why it depends
   on `Alerts`, why an `Ack` refreshes it, and what the ack's `override`
   writes.
4. **The `Orders` snapshot carries the rows.** Every order query derives
   from the actor's state, read through the host, so a `Fulfil` really
   changes what the refreshed handlers return.
5. **The `Orders` query is `OrderList` in TypeScript.** Its wire name is
   `Orders`, as the spec says. The export name avoids a clash with the
   `Orders` contract.
6. **One streamed tree, three deep.** `dash` is a layout over the overview
   leaf and the `orders` layout, which holds an index leaf and an order
   leaf. Every view inherits the layout's `TenantInfo` binding. The order
   leaf declares the same key again as `info` (a child may not reuse a
   parent's name): that is the shared-declaration row.
7. **The principal comes from a fixture header.** The server reads
   `x-dashboard-member` and serves the request as a member of the named
   tenants. The dev server stamps the demo member when a request names
   none. The in-process tests provide `CurrentPrincipal` on each verb. There
   is no sign-in page: that is the Auth example's ticket.
8. **The funnel sits behind a tab.** It is how the late registration row is
   built. First paint therefore shows the header, the memo and five cards;
   the funnel's key is declared by the route and so is on screen for
   `active` from the start.
9. **The memo is a form.** A submit reads its field from the event
   (`Form.last`). A click handler that read a separate draft actor raced the
   input's own send and wrote an empty memo.
10. **`Alerts` is a machine, and an `Ack` writes through `override`.** The
    alerts are an effect-machine behavior (`Behavior.machine`), as §4 says,
    so nothing predicts an ack. The ack writes one fewer waiting alert to
    the header's `TenantInfo` entry through `override`, then sends. The
    override is a function of that entry's own `Ready` value. A value taken
    from the shown header was wrong during a tenant switch: the header still
    showed Acme while the override wrote Globex's entry, so Globex became
    `Ready({ name: "Acme Co" }, stale)`. While the entry loads, the override
    writes nothing and returns `false`. One
    alert, `a3`, is pinned: the host's refuse rule rejects its ack before
    admission, which is how the `Rejected` outcome is built.
11. **The order book and the memo are commanded through `commandRef`.** A
    view opens one per tenant, lazily, in its own Scope, and each send reads
    the params the view has now, so a tenant move sends to the new tenant.
    The overview's open count reads the window's rows, not the book.
12. **Each command is two requests.** A `send` admits it and declares no
    keys; the settling `call` carries the page's `active` keys and its reply
    carries the refreshes. The tests read the command's cost from the
    settling `call`, and check that the `send` declared and refreshed
    nothing.
13. **`settle` fails loudly,** as in Notes: a check that never holds dies
    with "settle: … never held".
14. **The page request's Scope is closed on every exit but a returned
    body.** `answerWith` closes it on a failure, a defect or an
    interruption while drawing or while making the response, and answers
    500 on a defect. A returned body keeps it until the body ends.

## Framework changes

Each is its own commit with a changeset and a test that fails on the old
code.

| Commit               | Change                                                                                                                                       | Red on the old code                                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ede4df7 fix(view)    | A late registration hides its `Loading` before the row is connected                                                                          | the package test saw `#late-card` added twice; the Dashboard test saw `#funnel-card` added twice                                                               |
| 846300d feat(actor)  | `override` on a followed query and on a route query binding                                                                                  | `followed.override is not a function`, `post.override is not a function`                                                                                       |
| 6479cc7 feat(actor)  | `commandRef`: a remote reference that only sends                                                                                             | `Export named 'commandRef' not found`                                                                                                                          |
| 7416d36 feat(actor)  | `Behavior.machine(definition, { refuse })`                                                                                                   | the refused event was `Applied`                                                                                                                                |
| 02d33f5 fix(actor)   | `zip` loses no change between its first read and its subscriptions                                                                           | the combined source never reached the new value; the Dashboard's order leaf showed "no such order" on a direct load                                            |
| 00ad836 feat(actor)! | `override(update)` derives from its own entry's `Ready` value; a no-op returning `false` while it loads or failed; the value form is removed | the package test's post 2 became `Ready("value:post:t1/1 (guess)", stale)`; the Dashboard's Globex entry became `Ready({ name: "Acme Co", alerts: 2 }, stale)` |

## Open

- **An override inside a synchronous drawing read is a defect.** An
  `override` on a `Ready` entry during the SSR or streamed shell's first
  pass throws `AsyncFiberError`, over a warmed request cache too, and on
  the old API as well. Not fixed here. Since 00ad836 a `Loading` entry
  cannot move, so the moving fixtures in `streaming-delivery.test.tsx` and
  `route-data.test.tsx` now expect SSR and the streamed shell to render
  coherent, and only `AwaitAll`, where the entry is `Ready`, to refuse.

- **A request with no member is a 500. Blocked on #55.** The layout's
  `TenantInfo` and the overview's `Alerts` are guarded by `tenantMember`,
  and a policy refusal from a route declaration is a defect by rule
  (`route-checks.md`, "`Unauthorized` from a declaration is not a
  `RouteFailure`"). What a route does before, on error, and while pending
  is the owner decision in #55. Until it is decided, actor and query
  enforcement stay as they are, and the page answers 500.
