---
"effect-frame": minor
---

`View.bind(source, f)` paints in the same flush as the rest of its list. A `Bound` now keeps its source and its projection, and the runtime applies the projection where it draws, so a projected row item is read from the row as directly as the item itself. Before, `bind` stored `Source.select(source, f)`, which lost the row's direct read and repainted the row one scheduler turn after its siblings. The type `Bound<A>` changes shape: its `source` field is replaced by `open(read)`, which hands the source and the projection to `read`. `View.bind` is still the only way an app makes one.
