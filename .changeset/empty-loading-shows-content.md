---
"effect-frame": minor
---

A `Loading` with no registration now shows its content. It has nothing to wait for. Before, it showed its fallback until a first read registered, so a `Loading` around content that reads no query never drew that content, and the router registered a settled read on behalf of a failed or still-preparing segment to work around it. That workaround is gone. A read that registers later, unsettled, still puts the boundary back in its fallback before the registering view writes: a keyed row that sets up after mount may show the rest of the content first.
