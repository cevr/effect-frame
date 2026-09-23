---
"effect-frame": minor
---

`mount` takes `traversalReadLimit` (a `Duration.Input`, default 3 seconds): how long a traversal waits for the reads its page declared before it places the saved position. At the limit it lands on the page as it is (the scroll may clamp) and never places again when the reads settle later, and the Navigation API's traversal is released. Before, a declared read that never settled held the traversal for ever.
