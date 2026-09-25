---
"effect-frame": minor
---

`memoryLocation(href)` from `effect-frame/router` is a `Location` held in memory, for a test or a terminal: `location` is the service, `current` the URL it holds, `history` every `push` and `replace` the router wrote, and `pop(href)` a Back or Forward move. The router's tests and the example apps' fixtures use it in place of a hand-built `LocationService`, and the fixtures read the app's own root id.
