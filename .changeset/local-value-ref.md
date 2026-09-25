---
"effect-frame": minor
---

`LocalValueRef<A>` names the reference `Actor.local(Behavior.value(a))` returns: `LocalActorRef<A, SetValue<A>>`, with an optional `Refusal`. A prop that passes view state writes `draft: LocalValueRef<string>`, and `modify` takes it.
