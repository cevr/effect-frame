---
"effect-frame": minor
---

`effect-frame/view` no longer exports the interpreter's node model: `ControlNode`, `ElementNode`, `ElementProps`, `ForNode`, `MatchNode`, `PortalNode`, `ShowNode`, `PropValue`, `BoundaryKind`, `Component`, `Tag`, `MatchCases`, `ShowIfProps` and `ShowWhenProps`. None had a caller outside the package. An author needs `Node`, `Child`, and the props types of the tags it wraps (`ForProps`, `ShowProps`, `MatchProps`, `PortalProps`), which stay.
