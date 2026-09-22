---
"effect-frame": patch
---

Type the router's not-found view with its own requirements. `mount` now requires the union of the routes' and the not-found view's services, so a not-found view can use `Router` or another service that no route needs.
