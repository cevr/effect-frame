---
"effect-frame": minor
---

`View.event` and `View.submit` also take an Effect: a handler that reads no event is the Effect itself, run once per event. `onClick={View.event(addPane)}` replaces `onClick={View.event(() => addPane)}`. A handler that reads its event is written as before. What stays refused: a raw Effect, a raw function, or a raw `Source` in a prop, and an Effect whose error channel is not `never`.
