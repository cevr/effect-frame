---
"effect-frame": minor
---

`hydrate` reads the issues of a refused plain post that the document carries (`Form.issuesScriptId`) and provides them to the first render. A routed app calls `hydrate({ routes, notFound, root })` and writes no page-load sequence of its own.
