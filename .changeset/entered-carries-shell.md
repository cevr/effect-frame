---
"effect-frame": minor
---

`Route.Entered` carries what the router reads from a mounted route: `shell`, the last commit's shell, and `questions`, the leave checks it would ask for a candidate. The router no longer keeps them in a module-level map beside the value, and no longer invents a shell for a route it did not build.
