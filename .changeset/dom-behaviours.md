---
"effect-frame": minor
---

Composable DOM behaviours: `Dom.focus(options)`, `Dom.scrollIntoView(options)`, and `Dom.observeSize(onSize)` are attachments a view lists on an element, `attach={[Dom.scrollIntoView({ block: "nearest" }), Dom.focus()]}`, each run once the element is in the document and ended with it. `Dom.afterPaint` is the Effect a behaviour yields when it needs layout first.
