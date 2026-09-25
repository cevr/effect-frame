---
"effect-frame": minor
---

`Source.select`, `Source.debounce` and `Source.throttle` take the source first and have one signature. The data-last forms (`select(project)(source)`) are gone. With two overloads, an inline `select` in a JSX prop that was still being inferred resolved against `Source<readonly unknown[]>`, so `<For each={select(state, (s) => s.items)} keyBy={(item) => item.id}>` read `item` as `unknown`. It now infers the item, and `keyBy` needs no annotation.
