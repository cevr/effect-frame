---
"effect-frame": patch
---

A multi-word event prop now fires. `onKeyDown` listened for `keyDown` and `onPointerDown` for `pointerDown`, which no DOM event is called, so neither handler ever ran. The runtime now lowercases the whole name after `on`: `onKeyDown` listens for `keydown`.
