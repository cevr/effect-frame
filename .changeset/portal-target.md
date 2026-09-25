---
"effect-frame": minor
---

A `<Portal>`'s `into` takes a `PortalTarget`, which only a host module makes: `Dom.target(element)` in the browser, `target(renderable)` from `effect-frame/view/opentui` in a terminal. A host draws only into a target it made. The HTML and Remote hosts make none, so a Portal in a server render or a driven view is now a defect, `View.PortalTargetRefused`, that names the drawing host and the host that made the target. Before, the HTML host drew nothing and said nothing. Write `<Portal into={Dom.target(document.body)}>` where `<Portal into={document.body}>` was written. A custom host that draws a Portal adds a `portal` member (`PortalHost`) that resolves the targets it made.
