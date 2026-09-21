---
"effect-frame": minor
---

Attached behaviours and `Portal`. An element takes `attach={...}`: one or more behaviours, each an Effect given the host node (`Dom.attach((element) => Effect)`, `Tui.attach`), run once the node is in the document, in the scope of the branch or row that owns the element, so a listener, an observer, or a fiber the behaviour opened ends when the element leaves. There is no node reference. The server host never runs a behaviour. `<Portal into={node}>` draws children under another host node, owned by the branch that opened it. Hosts gain one operation, `attach`.
