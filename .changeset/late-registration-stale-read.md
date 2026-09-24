---
"effect-frame": patch
---

A `Loading` that a late view has made pending no longer shows its content again for a moment. When a registered query changed just before the late view registered, the scope could read that change over the registrations it had before, find them all settled, and put the content, the new view included, back in the document until the next read hid it. The scope now reads over the registrations it has when it reads, and the boundary acts on its current value, not on the value its subscription delivered.
