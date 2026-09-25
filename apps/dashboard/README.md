# Dashboard: many queries, one live stream

One tenant's dashboard. The overview declares eight things at once: five
queries and three actors. A command refreshes exactly the queries on screen
that name its actor, in its own reply. Nothing else runs.

The route tree is one streamed layout, `/d/:tenant`, with two leaves: the
overview and the orders page. The layout holds the tenant header and the
team memo. Each leaf inherits the layout's bindings, so the tenant is read
once for the whole session. `docs/design/dashboard-example.md` records what
each test proves and the mutation that turns it red.

## Run it

Start the server from this directory (`apps/dashboard`):

```sh
bun run dev
```

Open <http://127.0.0.1:3000>. `/` sends you to `/d/acme`. The shell streams
its skeleton first; the cards arrive together, and the slowest endpoints
arrive last, under their own fallback. Fulfil an order: revenue, the order
list and the funnel dim, then land with the new figures. Ack an alert: the
header's alert count drops, and nothing else is read.

The dev server serves every request as a member of `acme`. A test names the
member on each request instead. Set `PORT` to use another port.

## What each file does

| File                           | Role                                                                                                            |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `src/contract.ts`              | The three actor contracts: `Orders`, `Alerts`, and `Memo`, which no query names. Browser safe.                  |
| `src/queries.ts`               | The six queries and their `depends` lists: the point of the example.                                            |
| `src/behavior.ts`              | The reducers. The host runs them; the page's `Orders` and `Memo` references predict with them.                  |
| `src/segments.ts`              | The layout segment and its two children, and the data each one declares.                                        |
| `src/routes.tsx`               | The route tree: one streamed layout, two leaves, and the redirect from `/`.                                     |
| `src/views.tsx`                | The shell (outer `Errored` and `Loading`), the memo card, and the fallbacks.                                    |
| `src/overview.tsx`             | The overview's cards. The slowest endpoints sit under a nested `Loading`; the funnel mounts on a reveal.        |
| `src/orders-page.tsx`          | The orders page: every order, and the open ones.                                                                |
| `src/commands.ts`              | `Fulfil`, `Cancel`, `Ack`, `Write`, and the snapshot of a bound actor.                                          |
| `src/app.ts`                   | Hydrate the route tree over the server's nodes.                                                                 |
| `src/orders.server.ts`         | The `Orders` actor. A server module.                                                                            |
| `src/alerts.server.ts`         | The `Alerts` and `Memo` actors. A server module.                                                                |
| `src/queries.server.ts`        | The query handlers. They read the actors through the host they run in. A server module.                         |
| `src/policies.server.ts`       | `tenantMember`: one policy for every actor and query, read off the `tenant` field. A server module.             |
| `src/host.server.ts`           | The in-memory host over the actors and queries. A server module.                                                |
| `src/server.ts`                | The platform boundary: `Bun.serve`, `Bun.build`, and the request's principal.                                   |
| `src/client.tsx`               | The browser entry.                                                                                              |
| `tests/single-flight.test.tsx` | Each command's reply refreshes exactly its dependents on screen; a memo write refreshes none.                   |
| `tests/query.test.tsx`         | One read of the layout's tenant; canonical keys; stale from send until the last reply.                          |
| `tests/readiness.test.tsx`     | The nested `Loading`; the late funnel card; one fallback on failure.                                            |
| `tests/transition.test.tsx`    | `active` names both leaves mid-transition, one after, and stays bounded over 50 navigations.                    |
| `tests/boundary.test.ts`       | An injected server import is the one refusal, named with its import chain; `bun run boundary` checks the entry. |

## Routes

| Route                   | Answer                                                             |
| ----------------------- | ------------------------------------------------------------------ |
| `GET /`                 | A redirect to `/d/acme`.                                           |
| `GET /d/:tenant`        | The overview, streamed. `?range=7d`, `30d` (the default) or `all`. |
| `GET /d/:tenant/orders` | The orders page, streamed, under the same layout.                  |
| `GET /client.js`        | The browser bundle, built once at start and held in memory.        |
| `/actors/*`             | The actor transport and the `/query` endpoint.                     |
