---
"effect-frame": minor
---

A view's `pushSearch` and `replaceSearch` take a value or an updater of the latest search, as a `UrlState`'s `push` and `replace` and a link's search do: `props.replaceSearch({ filter: "open" })`. The one change shape is `Route.SearchChange<Search>`; the type `LinkSearch` is gone, so write `Route.SearchChange`.
