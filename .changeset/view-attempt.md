---
"effect-frame": minor
---

Add `View.attempt(setup, fallback)`. It runs one setup in a child Scope of its caller and keeps it open on success. On a typed failure, it closes the failed child and waits for its finalizers before the fallback starts in a fresh child. Defects and interruption skip the fallback, and a closed owner never starts either Effect. The result keeps the fallback's own error and requires `R | R2 | Scope`.
