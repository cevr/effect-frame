---
"effect-frame": minor
---

Breaking: `override` takes a function, `override((current) => next)`, and returns whether it wrote. This applies on `QueryEntry`, `FollowedQuery` and a route's query binding. The function receives the entry's own Ready value, which is read in the same step that writes the result, under the principal generation of that moment. While the entry is Loading or Failed nothing is written and the result is `false`.

The plain `override(value)` form is removed. A caller built its value from what a view showed, and during a key switch a followed query still shows the old key's value while `override` writes the new key's entry, so one key's data could be written into another. The function form cannot take a value from another entry.
