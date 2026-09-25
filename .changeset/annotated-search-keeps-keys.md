---
"effect-frame": patch
---

An annotated `Route.search` codec keeps its keys. `Route.search(S).annotate({ title })` made a new Schema value that the codec's key table did not know, so the segment's keys became unknown, `UrlState.make` refused it as opaque, and `retain` lost its fields. `Route.search` now records its fields as a Schema annotation, which `.annotate()` keeps.
