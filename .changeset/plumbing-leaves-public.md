---
"effect-frame": minor
---

Framework plumbing leaves the public namespaces of `effect-frame/actor/client` (and `effect-frame/actor`). No app or example used any of these; the view, router and post route import them by path.

- `Wire` is no longer exported. A plain post goes to `endpoint` plus `/form`; the JSON verbs answer at `prefix` plus `/send`, `/call`, `/snapshot`, `/changes`, `/query` and `/query/batch`.
- `Form` drops `FormMalformed`, `Tree`, `flatten`, `Fields`, `Structure`, `IssuesJson`, `frameworkFields`, `decode`, `withValues` and `without`. Decode a form body with `Form.codec(schema)`.
- `Generated` drops `annotation`, `generationOf`, `memberNamed`, `drawFresh`, `membersOf`, `mint` and `mintAll`.
- `Streaming` drops `ValueOutcome`, `ErrorOutcome`, `shell`, `declared`, `awaitDeclared`, `actorSeeds` and `settledPatches`.
- `canonicalize` is no longer exported.
