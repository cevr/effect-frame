---
"effect-frame": patch
---

Declarations of one route actor address in one tree share one reference. A layout and its leaf that declare the same actor now draw one revision and the document carries one seed for it; before, a commit between their opens could draw two revisions, and the leaf did not hydrate.
