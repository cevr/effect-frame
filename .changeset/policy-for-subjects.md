---
"effect-frame": minor
---

`Policy.forSubjects({ contracts, queries }, check)` is a rule over typed keys: it names the contracts and queries it reads, and `check` gets the subject's key or arguments decoded by that contract's or query's own codec. A subject it does not name, of another version, or whose key does not decode is refused. The types `PolicySubjects` and `PolicySubjectKey` name its input.
