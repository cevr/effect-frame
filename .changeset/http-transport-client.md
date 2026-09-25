---
"effect-frame": minor
---

`HttpTransport.layer` reads through the `HttpClient` in context
(`effect/unstable/http`) instead of a Promise `fetch` that defaulted to
`globalThis.fetch`. Its type is now
`Layer<ActorTransport, never, HttpClient>`: a browser or server writes
`.pipe(Layer.provide(FetchHttpClient.layer))`. An interrupted call aborts
its request, and a `changes` stream aborts its connection when it ends.
`HttpTransport.Fetch` and `HttpTransport.FetchLike` are removed.

New: `HttpTest.client(handler)` from `effect-frame/actor/testing`, an
`HttpClient` whose requests go straight into a web handler such as the one
`HttpServer.make` builds, so a test crosses the real wire with no socket.
