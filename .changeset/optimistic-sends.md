---
"effect-frame": minor
---

Show optimistic sends on remote references (#19, #67).

New public surface on `effect-frame/actor` and `effect-frame/actor/client`:

- `Behavior.predict`: an optional pure copy of `apply`. `Behavior.value` and `Behavior.reducer` have it. `Behavior.machine` does not.
- `RefOptions.behavior`: give `ref` the actor's behavior. When it has `predict`, a send with a fresh command ID shows its predicted state at once.
- `ActorRef.displayed: Source<Displayed<State>>` and `Displayed<State> = Applied<State> | Provisional<State>`. A provisional value has `revision: {_tag: "Provisional", base, depth}` and no number of its own.

Behavior changes:

- `ActorRef.state` on a remote reference is now `displayed.state`. With no `predict`, `displayed` is `applied` and nothing changes. `applied` stays committed.
- A `predict` that throws during a replay drops only that command's prediction and logs `command.predict.defect`; the reference keeps following.
- A committed state replaces the prediction. A rejected command leaves the pending log and the rest replays over the same base. An `Uncertain` command keeps its prediction. A supplied command ID never predicts.
- Local and durable references never predict. Their `displayed` is their `applied`.

Migration: a custom `ActorRef` implementation must add `displayed`. A custom `Behavior` needs no change.
