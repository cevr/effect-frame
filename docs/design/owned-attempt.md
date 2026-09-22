# Owned attempt

This note records the first route-boundary slice: `View.attempt` and the
proofs of its lifetime. The helper was proved privately first, then exported
as `View.attempt` from `effect-frame/view`. No route constructor or route
field changed. Issues #36, #55, and #56 stay open.

Source: `packages/effect-frame/src/view/attempt.ts`.
Proofs: `packages/effect-frame/tests/view/owned-attempt.test.tsx`.

```ts
const attempt: <E, R, E2, R2>(
  setup: Effect.Effect<Node, E, R>,
  fallback: (error: E) => Effect.Effect<Node, E2, R2>,
) => Effect.Effect<Node, E2, R | R2 | Scope.Scope>;
```

## Lifetime model

The owner is the `Scope` in the context where the attempt is yielded. For a
`View.list` row, that is the row scope. For a direct view setup, it is the
mount scope. The helper does not find a later owner. A returned `Node` carries
no Scope.

1. The helper reads the owner. If the owner is closed, it interrupts. It does
   not start setup.
2. It forks one child of the owner and runs setup with only `Scope` replaced.
   Other services and `Clock` come from the caller.
3. On success, it checks the owner again. If the owner closed while setup was
   suspended, it interrupts, and the `Node` is not returned. Otherwise the child
   stays open until the owner closes.
4. On any failure, the child closes with that exit. The close waits for every
   finalizer, including a held one.
5. A cause with only typed failures goes to the fallback with the first typed
   error. A cause with a defect or an interruption skips the fallback. If a
   typed failure is mixed with a defect or an interruption, it is re-raised as
   a defect, so setup `E` never appears in `E2`.
6. The fallback runs under the same owner rules in a new child. Its own typed
   failure stays `E2`. It closes its child and propagates. There is no retry.

The owner check is explicit because `Scope.fork` on a closed scope returns a
closed scope and does not fail. Holding a `Scope` value does not give
permission to start work.

## Evidence

| Proof                         | What the test observes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Success retention          | Two rows each open a local actor and a held QueryTest query. `Frame.inspect` shows their records. Query data and item updates do not run setup again. When row `b` is removed, its actor and query records disappear. Row `a` keeps its record ids and DOM identity. The parent keeps its actor and its setup count of 1.                                                                                                                                                                                                                                                                                                                                                 |
| 2. Typed failure ordering     | Setup opens an actor and a query, then fails. A finalizer holds the close. The fallback does not start while that finalizer is held. After release, the fallback runs in a new scope. That scope is not the failed scope and not the row scope. The failed scope is closed, the service value is kept, and the TestClock time reads 5000. The failed actor and query records are removed.                                                                                                                                                                                                                                                                                 |
| 3. Types and E2               | Exact `Equals` fixtures use `Effect.Success`, `Effect.Error`, and `Effect.Services` on expressions without annotations. There are `@ts-expect-error` negative fixtures. At runtime, the fallback's `FallbackFailed` comes back as the typed error. Setup and fallback each run once, and the fallback child closes.                                                                                                                                                                                                                                                                                                                                                       |
| 4. Defects and interruption   | A setup defect, a setup interruption, and a typed failure mixed with a defect each skip the fallback and close the setup child. A fallback defect propagates once. A closed owner does not start setup. An owner that closes while a failed child is in its close does not start the fallback, even though the attempt fiber is not interrupted by that owner. A setup that completes after its owner closed is refused. When the root closes during a suspended setup or fallback, the finalizer runs once, nothing is mounted, and releasing the gate later has no effect.                                                                                              |
| 5. Repeated failures          | Three rows fail one after the other under one live parent. After each fallback appears, only the fallback's actor and query are present. After each row exits, only the parent's records remain. In the held case, the row exits while the failed child's finalizer is held. The attempt then ends interrupted, and no fallback starts.                                                                                                                                                                                                                                                                                                                                   |
| 6. Layout and outlet          | The layout yields an explicit outlet Effect inside `Loading.children`. The outlet is a `View.list` row that uses `attempt`. The unseeded child starts a real held query while the layout fallback is shown. The child content appears after release. A fixture transition acquires the shared tenant declaration, then replaces the outlet item, then releases the old declaration. The tenant query has 1 handler call and the same record id. The layout element, the outlet element, the layout actor, and the layout setup count (1) do not change. The control without entering-first acquisition fetches the tenant query again (2 calls) and gets a new record id. |
| 7. Host timing and boundaries | HTML output shows the setup node, the fallback node, or `<ul></ul>` for a delayed row. The delayed row starts and then closes. Attachments run once, after insertion, for a delayed setup node and for a fallback node. Ordinary `Show` destroys and recreates the element, but the attempt child stays open until the mount closes. A `Loading` that holds only an attempt shows its fallback. One settled registration shows the content.                                                                                                                                                                                                                               |

Six mutations were checked against the proof file. Each one made at least
one proof fail: no closed-owner check, no check after success, a close that
does not wait, setup run in the caller's scope, no child close, and a catch
that also takes defects mixed with typed failures.

## Limits and contradictions

- **A Node does not transfer lifetime.** The attempt's resources belong to the
  owner where the attempt was yielded. Placing the returned `Node` in a `Show`
  branch does not give that branch the resources (proof 7). A route or row
  boundary must itself be the owner. Proof 1 and proof 6 use the row owner.
- **Empty registration hides a failed child's fallback.** If a child fails
  with a typed error inside a layout `Loading` and no other registration
  remains, the fallback runs but stays hidden. The accepted rule (no
  registration means pending) shows the `Loading` fallback (proof 6, third
  navigation). A route `errored` display under a layout `Loading` needs a
  settled registration in that `Loading`, or a boundary outside it. This is a
  design input for #55. The helper does not change it.
- **Overlap is not a list property.** `View.list` removes the exited row before
  it creates the entering row. The shared key was kept only because the
  fixture transition acquired it first. Without that, the control fetches it
  again. The router transition must own this order (#18, #36).
- **Mixed causes.** A typed failure that is mixed with a defect or an
  interruption is re-raised as a defect. It is not given to the fallback.
- **Attempt fiber not owned by the owner.** When the caller's fiber is not
  interrupted by the owner, the helper refuses the result at its next check.
  Setup code that is still running continues until it completes. A finalizer
  that it adds to the closed child runs at once. Code that must
  stop earlier needs an owner that also interrupts it. `View.list` rows and
  mounts interrupt it.
- **HTML.** The first frame is serialized before a delayed row can finish.
  The proof shows that the output is correct at that moment. It is not
  streaming or `AwaitAll` behavior (#22).

No route API, pending timing, lazy loading, leave checks, browser history,
server rendering mode, or public `View.attempt` follows from this proof.
