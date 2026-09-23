---
"effect-frame": patch
---

An `AwaitAll` render no longer reads the page from inside the drawing's reactive update. A boundary that switched, or a list row whose setup ended, woke the render at once, and the render could write a page whose bound text still showed its old value. The render now reads on a turn of its own.
