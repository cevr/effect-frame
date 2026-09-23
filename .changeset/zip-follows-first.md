---
"effect-frame": patch
---

`zip`, and so `Source.all`, no longer loses a change that lands between its first read and its subscriptions. It read both sides up front and then dropped each side's first element, so a value that changed in between was never seen: a view bound to it stayed on the old value. It now reads once both sides are followed, then once per later element.
