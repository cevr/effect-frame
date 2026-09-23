---
"effect-frame": minor
---

A prerender build now fails by name when an actor the page reads refuses `Anonymous` (#23 §2.3). Before, only a refused query failed with `PrerenderUnauthorized`; a declared `Route.actor` whose policy refused `Anonymous` died with the transport's raw `Unauthorized`. Now both fail with `PrerenderUnauthorized`, and nothing is written.

Breaking: `PrerenderUnauthorized { route, href, query }` is now `PrerenderUnauthorized { route, href, read, contract }`. `contract` replaces `query` and names the refused contract; `read` is `"query"` or `"actor"`. A caller that reads `error.query` reads `error.contract` instead.
