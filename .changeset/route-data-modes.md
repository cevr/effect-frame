---
"effect-frame": minor
---

Render a route tree's server document by its rendering-mode constructor, and resolve declared route data before render (#18 §3.3, §6, with #22 and #85).

New exports on `effect-frame/router`:

- `Route.ssr(name, root)`, `Route.streamed(name, root)`, and `Route.awaitAll(name, root)`, beside `Route.client(name, root)`. Each takes a branch of a root segment or the one-leaf flat definition, as `Route.client` does. A mode is the constructor; no route value carries a mode field.
- `Route.ModeConstructor`, the type of the four constructors, and `Route.RenderingMode` (`"ClientOnly" | "SSR" | "AwaitAll" | "Streamed"`, the #22 names).
- `renderDocument({ routes, notFound, url, document, closeWhen })`: answer one request, in the request's Scope. It matches the URL and runs the matched route's checks first, for every mode, `Route.client` included. It returns a `DocumentOutcome`:
  - `{ _tag: "Redirect", location }` when a check redirects: answer 303. The render does not follow it.
  - `{ _tag: "Rendered", route, mode, status, body }`. `route` is `{ _tag: "Matched", route }` or `{ _tag: "NotFound" }`; `status` is 404 for not-found and 200 otherwise; `mode` is the settled tree's (a hand-written route and not-found render as `SSR`); `body` is a `Stream<string>` that needs nothing and cannot fail.
  - `SSR` resolves every query the matched branch declares, in parallel, before any view draws. It draws once and writes the settled values in one seed script. The client hydrates with no read.
  - `Streamed` writes the shell first, with a `Placeholder` for each declared query, then one `Patch` per query as it settles (#22).
  - `AwaitAll` writes one document once every read settled (#22).
  - `ClientOnly` writes the document with an empty mount element and reads nothing.
  - The checks and the drawing read through one query cache per request, held by the request Scope (#28). A query both read is read once and written once; a query only a check read is not written.
  - Every read goes through `ActorTransport` under the caller's `CurrentPrincipal`, so each route query's named policy checks it (#85). A refusal is seeded as the refusal, never as the value.
- `DocumentTimedOut { phase: "settle" | "draw" }`: `closeWhen` completed before the checks, the declarations, or the first drawing ended. Nothing was written, and what the render opened is closed.
- `DocumentOptions`, `DocumentOutcome`, `DocumentRedirect`, `DocumentRoute`, `DocumentServices`, `RenderedDocument`.
- `Route.UrlValueRejected { name, reason }`: a route prints only what a URL carries both ways. A path segment must be well-formed text that is not empty and not `.` or `..`; a search key or value must be well-formed text. **Breaking:** `href`, `hrefAt`, `hrefFrom`, `Route.printPath`, and `Route.printSearch` now die with `UrlValueRejected` for another value, where they used to print a URL that parsed as other values (or threw a `URIError` for a lone surrogate in a path). Parse refuses the same values: a raw pathname with `%2E` or `%2E%2E` no longer matches.

Changes to existing types (no behavior change):

- `Route.client` is now a `ModeConstructor` value, with the same two call forms.
- `Html.renderToStream` and `Html.renderAwaitAll` spell their requirement type through one alias; it is the same set of services.
- The `Html` namespace lists its exports. Its public names are unchanged.
