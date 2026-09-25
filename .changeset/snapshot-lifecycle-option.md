---
"effect-frame": major
---

`Frame.CommandLifecycle` and `Frame.QueryValue` are exported schemas, and the internal records use them. In `Frame.Snapshot`, an `Uncertain` command's `admitted` is now `Option<number>` in the Type (it was `number | null`); the encoded JSON is unchanged (`null` when no pass was admitted).
