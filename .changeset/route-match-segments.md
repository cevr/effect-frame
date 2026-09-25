---
"effect-frame": minor
---

`RouteMatch` carries `segments`, the matched route's segments (empty on not-found), and a route value carries its `segments`. A segment link's `current` reads the match: a segment is current only while a route that holds it is matched. Before, the check was a module-level table from each segment to the names of the trees that held it, filled at every mode constructor and never cleared, so a tree built elsewhere with the same name made an unmounted segment current.
