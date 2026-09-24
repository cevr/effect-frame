---
"effect-frame": minor
---

A durable behavior can name when a state next needs the actor running with no request: `Behavior.wakeAt`, and `Behavior.machine(definition, { wakeAt })` for a machine. The durable engine stores the wake with each commit, so a machine deadline or work in flight survives a restart or an eviction. A host that can wake an idle actor, such as a Durable Object, arms its alarm in the same transaction.

`MailboxStore.commit` and `MailboxStore.advance` take the wake as a new argument, and `Committed` carries it as `wake`. A custom store must store it with the state and return it from `latest`. The conformance suite checks this.
