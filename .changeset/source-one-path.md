---
"effect-frame": minor
---

Each `Source` combinator has one path: `Source.select`, `Source.zip`, `Source.all`, `Source.on`, `Source.debounce`, `Source.throttle`, `Source.mapEffect` and the rest, imported as `Source` from `effect-frame/actor/client` (or `effect-frame/actor`). The flat `select`, `zip`, `all`, `on`, `debounce`, `throttle` and `mapEffect` exports are removed, and so is `View.select`. Replace `import { select } from "effect-frame/actor/client"` and `select(source, f)` with `import { Source } from "effect-frame/actor/client"` and `Source.select(source, f)`. The `Source<A>` type is the same name.
