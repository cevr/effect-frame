---
"effect-frame": minor
---

`Source.zip(a, b)` gives the pair, `Source<readonly [A, B]>`, as `Effect.zip` does. The combining form is `Source.zipWith(a, b, f)`: write `Source.zip(a, b, f)` as `Source.zipWith(a, b, f)`. The README has a table of the `Source` combinators.
