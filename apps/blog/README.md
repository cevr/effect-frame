# Blog: prerender, typed links, one client island

A blog whose pages are built before anyone asks for them. The build writes one file per page, at the path the route's own `href` prints, from one read of the store, as `Anonymous`. The server hands out a built file before the router runs; a page with no file renders on request and is the same page. Each post has one live island: its hearts.

The built tree is a cache over SSR, not a second pipeline. `docs/design/blog-example.md` records what each test proves and the mutation that turns it red.

## Run it

From this directory (`apps/blog`):

```sh
bun run build       # compile the client, then build dist/prerender from posts/
bun run dev         # serve it on http://127.0.0.1:3000
```

`bun run start` does both. `build` is the deploy build: `build:client` and then `prerender`. The repository gate runs `build:client` only, never `prerender`, because the gate does not read content (#23 §2.1). From the repository root, `bun run prerender` builds the pages alone.

Open <http://127.0.0.1:3000/posts>. Every post link is a built file. Delete one post's directory under `dist/prerender/generations/<id>/posts/` and open it again: the router renders it, and the reader sees the same page. Press the heart: with a script the count moves at once; with none, the form posts and the server answers 303.

`BLOG_POSTS` and `BLOG_OUT` point the build and the server at other directories. `PORT` sets the port.

## What each file does

| File                         | Role                                                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `posts/*.md`                 | The posts. Front matter holds `title`, `date` and `draft`. A draft is never listed and never built.                     |
| `src/contract.ts`            | The `Reactions` actor: one per post, keyed by slug. A heart carries a generated id.                                     |
| `src/behavior.ts`            | The reducer. The server hosts it, and the island predicts a heart with it.                                              |
| `src/queries.ts`             | `PostIndex`, `PostBody` (public) and `Draft` (the `editor` policy, which refuses `Anonymous`).                          |
| `src/segments.ts`            | The chrome, the index and the post segment, and the data each declares.                                                 |
| `src/routes.tsx`             | The one tree, `Route.prerender("blog", ...)`, and the post inputs: `runQuery(PostIndex)`, the same key the index reads. |
| `src/page.tsx`               | The post page and its island.                                                                                           |
| `src/views.tsx`              | The chrome, the index and the not-found page.                                                                           |
| `src/app.ts`                 | Hydrate the tree over a built or rendered document, then let the baked values be read again.                            |
| `src/document.ts`            | The document around every page. The build and the server add the one module tag.                                        |
| `src/client.tsx`             | The browser entry.                                                                                                      |
| `src/posts.server.ts`        | The post files, and the three query handlers. A server module.                                                          |
| `src/policies.server.ts`     | `public` and `editor`. A server module.                                                                                 |
| `src/reactions.server.ts`    | The host: the actor and the queries over one post directory. A server module.                                           |
| `src/prerender.server.ts`    | The build: `Prerender.build` over the host, the client bundle, and the command that exits non-zero on failure.          |
| `src/server.ts`              | The platform boundary: `Bun.serve`, the built pages before the router, and the actor transport.                         |
| `tests/build.test.ts`        | Paths, links, one read, the definition-time refusal, `PrerenderUnauthorized`, rebuilds, an aborted build.               |
| `tests/document.test.tsx`    | A built page: one seed stamped `builtAt`, a stale paint, one confirming read.                                           |
| `tests/island.test.tsx`      | The hearts resume from the baked revision; the form with no script posts one heart.                                     |
| `tests/serve.test.ts`        | A real server on a free port: a hit is the file and the router never runs; a miss renders the same page.                |
| `tests/deploy-build.test.ts` | The deploy build, run as a process: `bun run build` writes the published page tree.                                     |
| `tests/boundary.test.ts`     | The browser entry reaches no server module; an injected one is refused with its import chain.                           |

## Routes

| Route               | Answer                                                                                |
| ------------------- | ------------------------------------------------------------------------------------- |
| `GET /posts`        | The index, newest first. A built file when there is one.                              |
| `GET /posts/:slug`  | One post and its hearts. A built file when there is one, else rendered in `AwaitAll`. |
| `GET /client.js`    | The bundle the build wrote beside the pages, or the one the server built at start.    |
| `/actors/*`         | The actor transport and `/query`.                                                     |
| `POST /actors/form` | A heart posted with no script. It answers 303 to the post.                            |

A built page answers with a strong `ETag` and `cache-control: public, max-age=0, must-revalidate`; a matching `If-None-Match` answers 304.
