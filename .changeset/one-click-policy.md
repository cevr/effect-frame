---
"effect-frame": minor
---

`Link` and `followLinks` share one plain-click policy, so a `Link` click
leaves the same cases to the browser as a plain anchor does: a modified or
middle click, `target="_blank"`, a download, another origin, and a link
that only changes the current page's fragment. `Link` no longer writes
`data-frame-replace`, and `followLinks` no longer reads it: a plain anchor
always pushes, and a move that replaces is a `Link` with `replace`.
