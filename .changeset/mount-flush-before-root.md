---
"effect-frame": patch
---

Fix: `mount` now runs pending reactive work before it creates its root. Before, a list row added in another mounted view just before a mount (a server render, for one) was created under the new mount's root, and closing that mount disposed the row's bindings: the row stayed drawn but no longer followed its item.
