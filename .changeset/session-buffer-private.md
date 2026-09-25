---
"effect-frame": minor
---

`HttpServer.sessionBuffer` and `HttpServer.SessionBuffer` are removed. The
shared session subscription still keeps the latest revision only
(capacity 1, sliding, replay 1); the buffer is written at the one
`Stream.share` that uses it.
