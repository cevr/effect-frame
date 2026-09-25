# Notes: the end-to-end example

One actor contract, one server, two live clients. A browser page and a terminal observe the same notes list over the same HTTP transport. Nothing is mocked.

The browser side is one route tree in every rendering mode: `/lists` renders on the server (SSR), `/lists/:list` streams, `/lists/:list/print` waits for every read (`AwaitAll`), and `/scratch` draws on the client only. The list page and its print page share one view; the mode is the route's constructor, never a branch in a view. `docs/design/notes-example.md` records what each test proves and the mutation that turns it red.

## Run it

Start the server from this directory (`apps/notes`):

```sh
bun run dev
```

Open <http://127.0.0.1:3000>. `/` sends you to `/lists`. Open a list: the shell arrives first, and the counts stream in after it. The browser adopts the server nodes, subscribes to the list's actor, and then follows every revision. The terminal shows `inbox`.

In a second shell, start the terminal client:

```sh
NOTES_URL=http://127.0.0.1:3000 bun run terminal
```

Run both from `apps/notes`. The terminal client needs a real TTY, so start it
in its own shell, not through `turbo` or `bun run --filter`.

Type a note in either client and press Enter. Both update. Tick a box in the browser and the terminal line changes to `[x]`. Press Ctrl-C to leave the terminal.

## What each file does

| File                       | Role                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `src/contract.ts`          | The contract. Browser safe: it imports only `effect` and the actor client entry.                                                |
| `src/queries.ts`           | `ListIndex` and `ListCounts` (both depend on `Notes`), and `ListNotes`, the notes a list page resumes from.                     |
| `src/behavior.ts`          | The reducer. The server hosts it, and the list page's reference predicts an add with it.                                        |
| `src/segments.ts`          | The route segments: paths, the `list` and `filter` codecs, and the data each page declares.                                     |
| `src/routes.tsx`           | The route tree. Each page names its rendering mode here, and only here.                                                         |
| `src/page.tsx`             | The list page. The same view for `/lists/:list` and `/lists/:list/print`.                                                       |
| `src/views.tsx`            | The shell, the index, the scratch page, and the fallbacks.                                                                      |
| `src/app.ts`               | Hydrate the route tree over the server's nodes.                                                                                 |
| `src/notes.server.ts`      | The host, and the two transports the server can run over. A server module: `bun run boundary` fails if `client.tsx` reaches it. |
| `src/queries.server.ts`    | The query handlers. A server module.                                                                                            |
| `src/policies.server.ts`   | The policy table: `public` for the queries, `notes` for the actor (a send to `archive` is refused). A server module.            |
| `src/commands.ts`          | Command ids and the send helpers both views share.                                                                              |
| `src/terminal-view.tsx`    | The terminal view. Same setup, different tags.                                                                                  |
| `src/server.ts`            | The platform boundary: `Bun.serve`, `Bun.build`, and the environment.                                                           |
| `src/client.tsx`           | The browser entry: read the records, hydrate, follow.                                                                           |
| `src/terminal.tsx`         | The terminal entry.                                                                                                             |
| `tests/e2e.test.tsx`       | A real server on a free port, a real socket, both clients.                                                                      |
| `tests/modes.test.tsx`     | One list view under SSR, streaming, `AwaitAll` and client-only, each hydrated clean.                                            |
| `tests/routes.test.tsx`    | Every route prints what it parses; a filter change is a stayed transition; bad templates are refused.                           |
| `tests/streaming.test.tsx` | The shell before a held query, `resolvedAhead`, no records on `AwaitAll`, and a cut stream.                                     |
| `tests/query.test.tsx`     | One add refreshes both dependent queries, or none; an exited page releases its keys.                                            |
| `tests/readiness.test.tsx` | One fallback in each nesting order; a refetch keeps the counts on screen.                                                       |
| `tests/command.test.tsx`   | `Sent` before the reply, the predicted row, the rollback, and stale counts over HTTP.                                           |
| `tests/navigation.test.ts` | Scroll and focus in real WebKit and Chrome.                                                                                     |
| `tests/boundary.test.ts`   | An injected server import is the one refusal, named with its import chain; `bun run boundary` checks the entry.                 |
| `tests/plain-form.test.ts` | The compose form with no script: a real post, a 303, and a double post that adds one note.                                      |

## Routes

| Route                    | Answer                                                                            |
| ------------------------ | --------------------------------------------------------------------------------- |
| `GET /`                  | A redirect to `/lists`.                                                           |
| `GET /lists`             | The list names, rendered on the server. `?q=` filters them.                       |
| `GET /lists/:list`       | One list, streamed: the shell first, then the counts. `?filter=open` or `done`.   |
| `GET /lists/:list/print` | The same list in one document, sent when every read has settled.                  |
| `GET /scratch`           | A local draft. The server sends the shell only; the client draws the page.        |
| `GET /client.js`         | The browser bundle, built once at start and held in memory.                       |
| `/actors/*`              | The actor transport and the `/query` endpoint. The clients use it as `baseUrl`.   |
| `POST /actors/form`      | A plain form post from the compose form. It answers 303 to the page it came from. |

## Point it at another host

Set `NOTES_UPSTREAM` to a host that already serves the contract. The server then proxies to that host instead of running the actors itself:

```sh
NOTES_UPSTREAM=https://notes.example.com bun run dev
```

This is the one line that decides placement. The contract, the views, and the clients do not change. See `docs/design/acceptance.md` for what this claim still lacks a test for.

## The two views

The browser and the terminal share the contract, the reference, the command ids, and the send helpers. They do not share the JSX tags: a browser has `section`, `ul`, and `li`; a terminal has `box` and `text`. The submit event also differs, because an OpenTUI input emits `enter` where a browser form emits `submit`. Everything above the tags is one code path.
