---
"effect-frame": patch
---

A row's or branch's setup that dies is no longer dropped. The setup of a `For` row, a `View.list`, `View.keyed`, `View.show` or `View.match` branch, or a route's view in an outlet runs on a fiber that nothing joined, so a defect in it left the row empty and reached no one. It now goes where a refused Portal goes: in the first build `View.mount` fails with it, and after mount the mount's scope closes with it, so the view's owner sees the defect and the rest of the process keeps running. A route whose `pending` fallback is showing hands its setup's defect to the mount the same way. A setup interrupted because its row left or its branch hid is not a defect and leaves the mount open.
