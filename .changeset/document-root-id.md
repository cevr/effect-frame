---
"effect-frame": major
---

`Html.Document` takes a required `rootId`, and the renderer writes the mount element (`<div id="…">`) around the drawing; `head` now ends before it and `tail` starts after it. `Dom.root(id)` finds that element in the browser or fails with the new `Dom.RootNotFound`. A server document and a browser entry name the id once and import it.
