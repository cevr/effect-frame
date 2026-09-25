---
"effect-frame": minor
---

`Source` gains `switchMap`, `flatten`, `succeed`, `fromSubscriptionRef`, `dedupe` and a `mapEffect` with the `Stream.mapEffect` meaning, so an app no longer writes a `{ get, changes }` pair by hand.

- `Source.switchMap(source, (value) => inner)` follows the source the latest value names; `Source.flatten` is the same with no projection.
- `Source.succeed(value)` is a source that never changes. `Source.fromSubscriptionRef(ref)` reads a `SubscriptionRef`.
- `Source.dedupe(source, equivalence)` drops a change equal to the one before it.
- `Source.mapEffect(source, f)` runs `f` on a read and on each change, in order.
- The old `Source.mapEffect`, which loads into a `QueryState` and switches on a new input, is renamed `Source.load`. Migrate `Source.mapEffect(s, f)` that expects a `QueryState` to `Source.load(s, f)`.
