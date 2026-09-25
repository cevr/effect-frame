---
"effect-frame": minor
---

`<For>` takes an optional `fallback`, drawn while the list has no rows, as `<Show>`'s `fallback` is drawn while its branch hides: `<For each={tasks} keyBy={(task) => task.id} fallback={<li>no tasks</li>}>`.
