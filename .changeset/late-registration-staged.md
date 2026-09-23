---
"effect-frame": patch
---

A view that registers with a settled `Loading` after first paint no longer reaches the document before the fallback returns. The registration now tells the boundary at once, inside the registering setup: the content leaves the document before the new view writes a node, an empty mark keeps its place, and the fallback is drawn there. Before, a late row was connected for about a millisecond before `Loading` hid it.
