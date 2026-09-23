---
"effect-frame": patch
---

The first frame holds a layout's outlet (#37). A layout that yields its outlet inside `Loading` now draws a settled child on the first frame: an `SSR` document writes the child, not the fallback, and hydration of an `SSR` or `AwaitAll` document claims it with no `resolvedAhead`. A child that presents `pending` still starts in its row, when the parent is drawn. Not breaking.
