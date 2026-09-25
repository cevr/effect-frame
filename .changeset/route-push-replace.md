---
"effect-frame": minor
---

Every router move is named `push` or `replace`. `RouterService.navigate` and
`Receipts.navigate` are now `push`. A `Link`'s `go` is now `push`. A view's
`updateSearch` is now `pushSearch`, beside `replaceSearch`. `UrlState`
drops `set`, `update`, `push.set`, and `push.update` for `push(change)` and
`replace(change)`, where a change is a value or an updater of the latest
value (`UrlState.Change<A>`). `UrlState.make(codec, { keys })` is now
`{ searchKeys }`.
