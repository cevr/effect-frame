---
"effect-frame": patch
---

The DOM host hands a `select`'s chosen value to an event handler as
`HostEvent.value`, as it does an input's text. It handed `""` before.
