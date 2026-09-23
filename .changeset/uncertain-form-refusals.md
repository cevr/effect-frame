---
"effect-frame": minor
---

A plain form redrawn after a lost reply keeps its command id until the command settles (#21, #29).

- The 504 redraw draws a new framework field, `$uncertain`, into the form. When a post that carries it does not decode (for example, a required redacted field was not typed again), the route answers 200 with the issues and keeps the same `$command` and `$uncertain`. Before, it minted a fresh id, so the corrected post could apply the message a second time. A post without the marker still gets a fresh id.
- The route now decodes and encodes each plain post twice. When the two payloads differ, it answers 500, logs the contract name, and sends nothing. A form message codec must be repeatable: mint a value that needs entropy or a clock at render with `Generated`, never at decode.
- The hydrated `View.form` binding spends an id when it sends, not when the form fails to decode. A submit that does not decode sends nothing, and the next submit still carries the adopted id. Choosing the id, decoding, and spending it run under one permit per form, so two submits in flight never share an id: the second mints its own.

**Breaking:** `FormIssues` has a required `outcome: "Refused" | "Uncertain"` (`Form.FormOutcome`), and `Form.IssuesJson` carries it. Code that builds a `FormIssues` by hand must set it. `Form.frameworkFields` has `uncertain: "$uncertain"`.
