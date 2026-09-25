---
"effect-frame": minor
---

A refused plain post is redrawn by the router. `renderDocument` writes the
refusal's issues after the document's `tail` when `Form.FormContext` is
present, and the new `redrawDocument(render)` turns a document render into
the form route's `render`, failing with `DocumentRedirected` on a redirect.
`FormRoute.render` now takes the page `URL`, resolved against the posting
request's own origin, instead of a path. Replace a hand-written redraw with
`render: redrawDocument(renderPage)`, and drop the issues script from the
document's `tail`.
