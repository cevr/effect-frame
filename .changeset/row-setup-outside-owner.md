---
"effect-frame": patch
---

A layout entered under a `View.loading` that already shows its content draws again when its first read is still in flight. The layout's setup runs as a row of its parent's outlet, and its unsettled `View.ready` holds the boundary from inside that setup. The hold writes a signal, and the runtime ran the setup's synchronous part inside the row's Solid owner, so Solid's development build refused the write: the row died, the outlet stayed empty, and nothing was reported. The runtime now runs every Effect it starts (a row's setup, an event handler, a behaviour) outside Solid's owners; a build re-enters its own owner by name, and the place mark a hold leaves is made under the boundary's owner.
