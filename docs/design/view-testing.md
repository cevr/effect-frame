# Scoped view testing

`ViewTest.make` mounts a view through the production `Host` and `mount`
runtime. It returns the setup value, mounted root, two wait helpers, and an
idempotent close operation.

```tsx
const page =
  yield *
  ViewTest.make({
    host: Dom.host,
    root,
    setup: (host, root) => mount(Page, props, host, root),
  });

const reachOne = page.act(update, {
  label: "counter reaches one",
  until: (root) => root.querySelector("#count")?.textContent === "1",
});
```

`waitFor` observes a synchronous, read-only predicate. `act` waits for the
action to succeed and then observes the predicate. Both operations wake from
successful host writes. They use a revision latch and a second registration
check, so a write cannot fall between observation and waiting without waking
the waiter.

The condition is the completion contract. The helpers do not wait for global
fiber quiescence, descendant event handlers, timers, or remote work. A test
that needs one of those results must wait for its own `Deferred` or domain
signal and then observe the rendered result. `render` flushes the Solid graph
that has already received source values. It does not deliver pending source
streams.

An already true condition can complete an `act` after its action succeeds
while a descendant handler remains blocked. Use a separate completion signal
when the handler itself is part of the contract. Solid's flush is global across
roots, so this helper records the mounted root's host writes but cannot claim
that another root did no work during the same flush.

Each action runs in a child `Scope` of the harness. Closing the harness is
idempotent. It interrupts actions and waits, releases host listeners, and
closes the mounted view. A timeout uses a finite positive live-clock deadline.
The application `TestClock` remains available to the mounted view and is not
advanced by the watchdog. Timeout receipts include the label, root identity,
revision values, bounded recent host operations, listener counts, and a root
summary capped at 2048 characters. The receipt also has an `inspection` field.
When the harness captured the optional `Frame.Service`, this field contains
the actual `Frame.Snapshot` from that root. The snapshot is sampled. It is not
an atomic view of the state at the deadline. Query values can contain the
encoded values produced by the Frame schema.

When the service is absent, collection reaches its live diagnostic deadline, or
the collector defects, `inspection` contains an explicit unavailable reason:
`FrameServiceMissing`, `CollectionTimedOut`, or `CollectionDefect`. A
successful wait and action do not collect a snapshot. Diagnostic collection
has its own short live deadline and its own child scope. It cannot replace the
original condition failure.

The snapshot schema bounds its diagnostic values, but it does not promise one
global JSON byte limit. The root summary and recent host operation list keep
their existing bounds. A later live CLI can add a bounded output projection.
The test helper does not add a second registry, collector callback, or live
debug endpoint.

Close receipts report `rootDisposed: false` until the harness scope's
finalizers finish. This keeps a receipt truthful while cleanup is blocked.
The live watchdog cannot interrupt a synchronous blocked JavaScript callback or
uninterruptible cleanup. Keep the outer test runner timeout as the final bound.

The helper is a host-level test tool. Happy DOM coverage does not claim
browser behavior. Browser-only behavior still needs a browser regression
suite. HTML string rendering remains one frame. It does not adopt streaming
rendering policies.
