---
"effect-frame": minor
---

Each exported value has one path. `bun run declarations` now also fails when one value is exported flat and as a namespace member, or under two names.

- `Value` (and the `SetValue` type) is a flat export of `effect-frame/actor/client` only; `Behavior.Value` is removed. `Behavior` holds what builds a behavior: `value`, `reducer`, `machine`, and their types.
- `UrlStateConflict` and `UrlStateSchemaRejected` are `UrlState.UrlStateConflict` and `UrlState.UrlStateSchemaRejected` only; the flat exports of `effect-frame/router` are removed.
