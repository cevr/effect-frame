---
"effect-frame": patch
---

A Back or Forward lands once its page is drawn (#31). The router placed a traversal's saved position at shell commit, while a declared query of the page could still be read again, so the position landed clamped against a short page (always in WebKit, sometimes in Chrome). A traversal now waits until every query the drawn branch declared has settled and the drawing shows it, then restores the position. A push or replace still lands at shell commit. Not breaking.
