---
"effect-frame": minor
---

The router's `Match` type (which route the document is on, and its URL) is renamed `RouteMatch`, so it never meets the view's `Match` tag in one file. `bun run declarations` now also fails when two published subpaths export one value name, apart from the declared re-exports (`actor` over `actor/client`, and the two JSX runtimes).
