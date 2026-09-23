---
"effect-frame": minor
---

A machine actor no longer takes its state back after a message. `Behavior.machine`'s `changes` also carries the start state and every transition its own messages make, and the actor committed each one it received as a new revision, after any message processed since. Three quick increments committed 0, 1, 2, 3, then 0, 1, 2, 3 again. A durable session could read `Empty` right after a sign-in committed.

A behavior's turn can now name its own state as `current`. When a change arrives, the actor commits that read, not the value the change carried. `Behavior.machine` sets it. A custom behavior whose `changes` only carries states it made on its own needs nothing new.
