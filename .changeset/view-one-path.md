---
"effect-frame": minor
---

Each `effect-frame/view` export has one path.

- `bind`, `event`, `submit` and `attach` are `View.bind`, `View.event`, `View.submit` and `View.attach` only; the flat function exports are removed.
- The `View` namespace holds functions, Effects and the `View` type. Every other type is a flat export: `Bound`, `Prepared`, `Attached`, `Handler`, `Bind`, `PlainPost`, `CommandForm`, `FormBinding`, `ListOptions` and `LazyModule` (was `View.LazyModule`).
- `ViewTest` moves off `effect-frame/view` to its own subpath: `import { ViewTest } from "effect-frame/view/testing"`. A browser entry that imports `effect-frame/view` no longer carries the test harness.
