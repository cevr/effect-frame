---
"effect-frame": minor
---

The actor host has one HTTP handler, and every edge decision is written at
its call.

- `HttpServer.make({ prefix, principal, maxBodyBytes, form })` serves the
  JSON verbs, `changes`, and the plain-form route. Each verb answers at
  exactly `prefix + Wire.paths.*` (a path that only ends in a verb is a
  404), so an app hands it every path under the prefix unchanged instead
  of stripping the prefix. The principal is derived once per request for
  every route.
- `maxBodyBytes` is required. A body over it answers 413 before it is
  decoded, whether its length is declared or streamed.
  `HttpServer.defaultMaxBodyBytes` is one MiB. `HttpServer.readText`,
  `HttpServer.BodyTooLarge` and `HttpServer.BodyUnreadable` are the
  bounded reader, for a host that reads a body itself.
- `form` is `Option.some({ contracts, login, render, commitWithin })` or
  `Option.none()`. `commitWithin` is required;
  `HttpServer.defaultCommitWithin` is ten seconds.
- Removed: `HttpServer.form` and `HttpServer.FormPostOptions` (the `form`
  option replaces them; its type is `HttpServer.FormRoute`), and
  `HttpServer.toWebHandler` (build the handler with `HttpServer.make` in
  the runtime that holds the host).
- `renderDocument` requires `principal`: every check and query the render
  reads runs under it, where it used to read an ambient `CurrentPrincipal`
  that defaulted to `Anonymous`.
- New: `respondDocument(render, { onTimeout })` answers one page request.
  It owns the render's Scope, answers a redirect with 303 (path and
  search), a document with its status, a timeout with `onTimeout`, and a
  defect with 500, and closes the Scope on every exit but a returned body.
