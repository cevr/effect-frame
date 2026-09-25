---
"effect-frame": minor
---

A browser `Location` carries its surface and its Back/Forward traversals on the value, under a symbol-keyed optional field of `LocationService` that is not public. A spread of a Location keeps them. A Location an app writes (a memory or test Location) does not change: the field is optional.
