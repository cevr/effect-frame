# Dashboard: many queries, one live stream, single flight at width (#40)

Dashboard is the example that runs many queries under one live stream and
proves that a command's cost is exact at width. It builds the Dashboard
section of #25 §4. Each acceptance row under "Dashboard — many queries, one
live stream, single flight at width" is now a test in `bun run gate`, and so
is the Dashboard half of the shared single-flight row. This document gives
the tests, the mutation that turns each one red, the decisions the build
made, and what stays Open.

## The shape

| Route               | Mode             | Segment           | Data                                                                                                                |
| ------------------- | ---------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| `/`                 | redirect (`ssr`) | none              | none; `before` sends the reader to `/d/acme`                                                                        |
| `/d/:tenant`        | `Route.streamed` | `dash` (layout)   | `TenantInfo({tenant})`, actor `Memo` (predicted)                                                                    |
| `/d/:tenant?range=` | (same tree)      | `overview` (leaf) | `Revenue`, `Orders`, `Funnel` on `{tenant, range}`; `Slowest({tenant})`; actor `Alerts`; actor `Orders` (predicted) |
| `/d/:tenant/orders` | (same tree)      | `orders` (leaf)   | `Orders({tenant, range: "all"})`, `OrderDetail({tenant})`; actor `Orders` (predicted)                               |

| Query         | Depends on | Read by                                                   |
| ------------- | ---------- | --------------------------------------------------------- |
| `TenantInfo`  | `Alerts`   | the layout's header (name, plan, unacked alerts)          |
| `Revenue`     | `Orders`   | the revenue card (fulfilled total in the window)          |
| `Orders`      | `Orders`   | the order list on both leaves (`OrderList` in TypeScript) |
| `Funnel`      | `Orders`   | the funnel card, behind a tab                             |
| `Slowest`     | nothing    | the slowest-endpoints card, under its own `Loading`       |
| `OrderDetail` | `Orders`   | the open orders on the orders page                        |

On `/d/acme` the page declares five keys. A `Fulfil` refreshes the three
that name `Orders`. An `Ack` refreshes `TenantInfo` alone. From
`/d/acme/orders` a `Fulfil` refreshes that page's two and not `Revenue`. A
`Write` to the memo refreshes nothing.

`DashShell` holds `Errored` outside `Loading`. Every card but the slowest
registers with that `Loading`. The funnel card mounts only when its tab is
revealed, after first paint.

## Rows, tests and mutations

Each mutation was applied alone by a script. The named test file was run
from `apps/dashboard` with `bun test --conditions=source`, and then the file
was restored. Every new test ran three times in a row, green each time.

| Row                                                                    | Test (file: name)                                                                                                                                                                                 | Mutation                                                                                  | Result                                    |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------- |
| One command refreshes its dependents on screen, in one reply           | `single-flight.test.tsx`: "a Fulfil from the overview refreshes exactly its three dependents", "an Ack … names Alerts", "a Fulfil from the orders page refreshes its two dependents, not Revenue" | `Revenue` without `depends: [Orders]`                                                     | Killed (2 tests)                          |
| (same row)                                                             | (same tests)                                                                                                                                                                                      | `query-host.ts` `dependents` returns every active key                                     | Killed (all 5 single-flight tests)        |
| A commit to an actor no query depends on does zero extra work          | `single-flight.test.tsx`: "a Write to the memo, which no query names, refreshes none and runs no handler"                                                                                         | `TenantInfo` depends on `[Alerts, Memo]`                                                  | Killed                                    |
| (same row)                                                             | (same test)                                                                                                                                                                                       | `host.ts` `refreshFor` without its `stale.length === 0` early return                      | Survived: equivalent, see below           |
| Canonical args make `{a,b}` and `{b,a}` one entry                      | `query.test.tsx`: "reordered arguments name one entry: its key is canonical"                                                                                                                      | `query-client.ts` `encodeKey` keeps the encoded string as written                         | Killed                                    |
| (same row)                                                             | (same test)                                                                                                                                                                                       | `canonical-json.ts` `canonicalize` returns its input                                      | Killed                                    |
| A failed refresh answers `RefreshFailed` and does not undo the command | `single-flight.test.tsx`: "a failed refresh answers RefreshFailed, and the Fulfil still commits"                                                                                                  | `host.ts` `call` dies when any refresh failed                                             | Killed                                    |
| (same row)                                                             | (same test)                                                                                                                                                                                       | `query-host.ts` `dependents` returns every active key                                     | Killed                                    |
| Invalidate-on-send, accept-on-reply holds stale for the round trip     | `query.test.tsx`: "revenue stays on screen, marked stale, from the Fulfil's send until its reply"                                                                                                 | `query-client.ts` `claim` does not recount its dependents when it is made                 | Killed (2 tests)                          |
| (same row)                                                             | (same test)                                                                                                                                                                                       | `query-client.ts` `display` never marks a pending entry stale                             | Killed (2 tests)                          |
| (same row, two commands in flight)                                     | `query.test.tsx`: "with two Fulfils in flight, the first reply does not clear stale"                                                                                                              | `query-client.ts` a released claim deletes every claim on its contract                    | Killed                                    |
| A nested `Loading` holds only its own card while the page paints       | `readiness.test.tsx`: "a nested Loading holds only the slowest card while the page paints"                                                                                                        | `SlowestCard` without its `Loading` (the card registers with the shell's)                 | Killed                                    |
| A source registered after first paint flips its scope pending again    | `readiness.test.tsx`: "the funnel card mounts late: the shell's scope goes pending again and settles"                                                                                             | `readiness.tsx` `derive` follows only the first set of registrations                      | Killed                                    |
| (same row)                                                             | (same test)                                                                                                                                                                                       | `readiness.tsx` `pendingOf` treats an empty registry as settled                           | Survived: not this page's case, see below |
| `active` names both branches during a transition and one after         | `transition.test.tsx`: "active names both leaves while the overview enters, and one after"                                                                                                        | `branch.ts` `commitSlot` closes the exited view but does not release its interests        | Killed (2 tests)                          |
| (same row)                                                             | (same test)                                                                                                                                                                                       | `branch.ts` `commitSlot` releases the exited interests but does not close the exited view | Survived: see below                       |
| A session of N navigations declares a bounded set                      | `transition.test.tsx`: "a session of 50 navigations declares only the current branch"                                                                                                             | `branch.ts` `commitSlot` does not release the exited interests                            | Killed                                    |

Also in the suite, with no mutation of their own: `query.test.tsx` "the
layout's TenantInfo is one entry and one read for the whole branch" (one
read across overview, orders and overview), `readiness.test.tsx` "a failing
Revenue settles the scope: exactly one fallback, and no hang", and
`boundary.test.ts` (the browser entry reaches no server module; an injected
`queries.server.js` import in `overview.tsx` is refused with its chain).

Notes on the survivors:

- **`refreshFor` without its early return** is an equivalent mutant.
  `query.batch([])` answers `[]`, so the reply and the handler counts do
  not change. The early return saves a call, and nothing more.
- **`pendingOf` with an empty registry settled** survives because the shell
  always registers `TenantInfo` during its own setup: the dashboard's scope
  is never empty. Notes proves the empty case (`notes-example.md`, decision
  8 and Open).
- **Releasing interests without closing the exited view** survives because
  `active` is the route's interests, not the view's scope. The view holds
  no query of its own. The test checks keys, not DOM teardown.
- **No mutation targets the mid-transition half on its own.** Every change
  that would drop the exited keys before the entering leaf commits is more
  than a one-line edit to `commitSlot`. The package twin
  (`query-active.test.tsx`) holds the same claim.

## Decisions

1. **A `Memo` actor was added.** The row "a commit to an actor no query
   depends on does zero extra work" needs such an actor, and the spec's
   tables name none. The memo lives on the layout, so it is on every page,
   and no `depends` list names it.
2. **Every argument record carries `tenant`, not `id`.** One policy,
   `tenantMember`, reads the same field off every actor key and every query
   argument. The spec's `TenantInfo({id})` is `TenantInfo({tenant})`.
3. **`TenantInfo` carries the unacked alert count.** That is why it depends
   on `Alerts`, and why an `Ack` refreshes it.
4. **The `Orders` snapshot carries the rows.** Every order query derives
   from the actor's state, read through the host, so a `Fulfil` really
   changes what the refreshed handlers return.
5. **The `Orders` query is `OrderList` in TypeScript.** Its wire name is
   `Orders`, as the spec says. The export name avoids a clash with the
   `Orders` contract.
6. **One streamed tree.** Both leaves sit under one `Route.layout`, so the
   layout's bindings are inherited and `TenantInfo` is one entry and one read
   for the whole session.
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
10. **`Alerts` is not predicted.** Its route binding has no behavior. An
    `Ack` shows when the host commits it, through the live stream.
11. **Each command is two requests.** A `send` admits it and declares no
    keys; the settling `call` carries the page's `active` keys and its reply
    carries the refreshes. The tests read the command's cost from the
    settling `call`, and check that the `send` declared and refreshed
    nothing.
12. **`settle` fails loudly,** as in Notes: a check that never holds dies
    with "settle: … never held".

No framework change was needed. Every row held on the released 0.21.0 code.

## Open

- **The late card is in the live DOM for about one millisecond.** When the
  funnel card mounts, its nodes are inserted into the page before the
  shell's scope flips pending and hides it. By the next macrotask the card
  is detached and the skeleton shows. The test asserts states, not
  insertions, so it passes. A user will not see one frame of it, but a
  `MutationObserver` does. This is a readiness question (#16) that this
  ticket reports and does not decide.
- **A request with no member is a 500.** The layout binds the `Memo` actor,
  and a policy refusal of a route actor is a defect by rule
  (`route-checks.md`, "`Unauthorized` from a declaration is not a
  `RouteFailure`"). The fix is a `before` check that sends a non-member to a
  sign-in page, and the dashboard has none. The Auth example owns it.
- **No real-server streaming test.** The Dashboard rows are all proven in
  process. A manual run of the real server served the streamed shell and
  its records to a member. The streaming rows are proven by Notes.
- **Not built from §4:** the optimistic `Ack` override (`FollowedQuery` has
  no `override`), and a timing proof that eight declarations resolve in
  parallel. Neither is a Dashboard row.
