---
"effect-frame": patch
---

Back and Forward restore the entry's saved scroll position under `NavigationBehavior.Preserve` with `browserNavigation`, as they do with `browserLocation` (#31). `Preserve` keeps a push or replace where the page is; a traversal returns to where the entry was. Focus under `Preserve` still does not move.
