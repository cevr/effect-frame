---
"effect-frame": patch
---

A Portal that a `Show`, `Match`, `View.show`, or `For` reveals after mount no longer halts reactivity. When the drawing host refused its target, the build threw inside Solid's flush: every later signal write in the process was dropped, and the branch's scope never closed. The refusal is now reported to the mount instead: the Portal draws nothing, and the mount's scope closes with the `View.PortalTargetRefused` defect. A refusal in the first build still fails `View.mount` with that defect.
