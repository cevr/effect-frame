---
"effect-frame": minor
---

`Behavior.machine(definition, { refuse })` takes a refusal rule, as `reducer` and `value` do. The rule reads the event alone. A refused event never reaches the machine, commits no revision, and settles `Rejected(Refused)`.
