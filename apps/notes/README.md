# Notes: the end-to-end example

One actor contract, one server, two live clients. A browser page and a terminal observe the same notes list over the same HTTP transport. Nothing is mocked.

## Run it

Start the server from this directory (`apps/notes`):

```sh
bun run dev
```

Open <http://127.0.0.1:3000>. The page arrives server rendered, with the snapshot it was rendered from embedded beside it. The browser adopts those nodes, subscribes to the actor, and then follows every revision.

In a second shell, start the terminal client:

```sh
NOTES_URL=http://127.0.0.1:3000 bun run terminal
```

Run both from `apps/notes`. The terminal client needs a real TTY, so start it
in its own shell, not through `turbo` or `bun run --filter`.

Type a note in either client and press Enter. Both update. Tick a box in the browser and the terminal line changes to `[x]`. Press Ctrl-C to leave the terminal.

## What each file does

| File                    | Role                                                                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `src/contract.ts`       | The contract. Browser safe: it imports only `effect` and the actor client entry.                                                    |
| `src/notes.server.ts`   | The behavior, and the two transports the server can run over. A server module: `bun run boundary` fails if `client.tsx` reaches it. |
| `src/commands.ts`       | Command ids and the send helpers both views share.                                                                                  |
| `src/page.tsx`          | The browser view.                                                                                                                   |
| `src/terminal-view.tsx` | The terminal view. Same setup, different tags.                                                                                      |
| `src/server.ts`         | The platform boundary: `Bun.serve`, `Bun.build`, and the environment.                                                               |
| `src/client.tsx`        | The browser entry: read the resume payload, hydrate, follow.                                                                        |
| `src/terminal.tsx`      | The terminal entry.                                                                                                                 |
| `tests/e2e.test.tsx`    | The proof. A real server on a free port, a real socket, both clients.                                                               |

## Routes

| Route            | Answer                                                        |
| ---------------- | ------------------------------------------------------------- |
| `GET /`          | The HTML document, the rendered list, and the resume payload. |
| `GET /client.js` | The browser bundle, built once at start and held in memory.   |
| `/actors/*`      | The actor transport. The clients use it as `baseUrl`.         |

## Point it at another host

Set `NOTES_UPSTREAM` to a host that already serves the contract. The server then proxies to that host instead of running the actors itself:

```sh
NOTES_UPSTREAM=https://notes.example.com bun run dev
```

This is the one line that decides placement. The contract, the views, and the clients do not change. See `docs/design/acceptance.md` for what this claim still lacks a test for.

## The two views

The browser and the terminal share the contract, the reference, the command ids, and the send helpers. They do not share the JSX tags: a browser has `section`, `ul`, and `li`; a terminal has `box` and `text`. The submit event also differs, because an OpenTUI input emits `enter` where a browser form emits `submit`. Everything above the tags is one code path.
