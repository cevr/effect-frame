# Testing and runtime inspection

Source review: 2026-09-21. The target is an actor framework with declarative,
explicit JSX and Effect composition. The recommendations below preserve that
model.

## Recommendation

Use the production actor, query, router, and view runtimes in tests. Replace
external services through Layers. Control completion through Deferred values.
Control time through Effect TestClock. Keep Bun and effect-bun-test as the test
runners.

Add a small scoped view test API with a defined action and commit boundary.
Use the same runtime inspection schema in tests and live debug tools. Keep a
small real-browser suite for behavior that requires the browser.

These additions extend #58 and the test tools delivered in #59. Issue #66
tracks the view test helpers and browser regression command. They do not
require Foldkit's central Model or a second runtime that simulates actors.

## Compared sources

| Project      | Reviewed revision                          | Useful pattern                                                                          | Limit                                                                                                                                    |
| ------------ | ------------------------------------------ | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Foldkit      | `63949f4e96600f03818b076cad6a50f1162ffdb4` | Typed pending work, explicit completion, scoped lifecycle checks, bounded debug history | Story and Scene substitute command results. Scene inspects a VNode tree. These tests do not prove browser or Effect scheduling behavior. |
| New Remix    | `a1057f6821114b739a7d1737c61bfa39ac56da46` | Production request boundary, small UI test wrapper, isolated browser execution          | A UI flush does not finish future timers or network requests.                                                                            |
| Effect Frame | `2647ee1e574eeb56628717a3e2e5225d8e524b48` | Real QueryTest host/cache, Layer replacement, scoped tests, TestClock, injected fetch   | View render still relies on a fixed yield count. Live inspection is not yet implemented.                                                 |

The Remix source package declares `3.0.0-rc.3`. Its live API page displayed
`3.0.0-rc.2`. The source revision above is the reference here. This is not a
claim that rc.3 was verified on npm. This review concerns new Remix 3. Older
Remix v2 and React Router test stubs are separate APIs.

## Foldkit

[Story](https://github.com/foldkit/foldkit/blob/63949f4e96600f03818b076cad6a50f1162ffdb4/packages/foldkit/src/test/story.ts)
tests call the pure update function. A test sends a typed message, checks the
model or pending commands, then supplies a typed result for a pending command.
Command matching uses the definition or the definition with its arguments.
An ambiguous match fails with a list of pending commands. The simulation
tracks interruption keys and command result mapping.

[Scene](https://github.com/foldkit/foldkit/blob/63949f4e96600f03818b076cad6a50f1162ffdb4/packages/foldkit/src/test/scene.ts)
adds the real view function and accessible locators over its VNode output.
It tracks commands, mount starts, mount ends, and ignored interactions.
At the end, it checks that the test accounted for these operations.
This is useful test language. It is not a browser or the production Effect
runtime.

Adapt the explicit control of pending work. A Frame test can hold a real
query handler with a Deferred, observe Loading, complete the handler, then
observe the committed result. It can close an owner scope and assert that
the query, readiness registration, actor, and host nodes are released.
Do not inject a synthetic actor result that skips its mailbox or receipt.

Foldkit's [debug store](https://github.com/foldkit/foldkit/blob/63949f4e96600f03818b076cad6a50f1162ffdb4/packages/foldkit/src/devTools/store.ts)
records bounded message history, model diffs, command identities, and mount
events. Its [MCP tools](https://github.com/foldkit/foldkit/blob/63949f4e96600f03818b076cad6a50f1162ffdb4/packages/devtools-mcp/README.md)
support narrow paths, summaries, filters, counts, and explicit runtime IDs.
These are good interfaces for agents. Their time travel depends on the
Foldkit model and update function. A Frame snapshot must not imply that it
can rewind remote writes or replay arbitrary Effects.

## New Remix

The [official testing guide](https://guides.remix.run/testing/) separates
module tests, request tests, browser component tests, and complete browser
flows. The runner has server, browser, and E2E execution modes.

The production router accepts a Web Request and returns a Response. Tests
can check middleware, status, headers, sessions, and response bodies without
opening a socket. Frame already has the corresponding actor HTTP seam:
tests connect the production client and server through injected fetch.

The [UI test helper](https://github.com/remix-run/remix/blob/a1057f6821114b739a7d1737c61bfa39ac56da46/packages/ui/src/test.ts)
creates the production root, renders, flushes, and returns a container,
selectors, root, action helper, and cleanup. The action helper awaits its
action and then flushes. Cleanup disposes the root and removes the container.

Browser tests run through Playwright in one isolated iframe per test file.
The test context provides cleanup and an abort signal. These lifecycle
patterns fit Frame's Scope. Frame does not need another test runner or global
method mocks to adopt them. The inspected Remix fake-timer implementation
replaces timeout and interval functions. Its comment also claims Date.now
control, but the implementation does not supply that guarantee.

Remix also has route JSON output, project diagnostics, and asset inspection.
These inspect declarations and project resources. They do not establish a
live actor/query inspector. The review did not audit every Remix extension.

## Frame test boundaries

| Boundary              | Proof                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| Actor and query tests | Real mailbox/cache behavior, typed failures, revisions, cancellation, scope release, virtual time |
| Request tests         | Production decoding, policy, batching, response encoding, headers, transport failures             |
| View and router tests | Real mount and owners, rendered state, URL updates, readiness, disposal                           |
| Browser tests         | Focus, input events, native history, navigation, hydration, browser/server integration            |

`QueryTest.layer` already accepts canonical query implementations and actor
implementations. It uses the real local host and QueryCache. EGW now uses
it with its real batched Search contract.

The current `render` helper performs ten scheduler yields and then flushes
Solid's reactive graph. Readiness and query test helpers call it twice.
A fixed number of yields is not a completion contract.

Define completion for the work an action starts and the mounted owner can
acknowledge. Do not wait for every fiber, timer, subscription, or blocked
remote query. Do not replace the fixed count with an unbounded global drain.
Return useful pending-owner diagnostics when a bounded wait fails. Tests
must cover deep propagation, blocked queries, recurring work, owner disposal,
and two independent roots.

Keep assertions close to the test's contract. A query test asserts its typed
state. A view test asserts rendered output. An ownership test can assert an
inspection snapshot. A full-tree snapshot should not replace those assertions.

## Inspection contract

Provide one service at each app root. Register actual owners with their
existing scopes. Read known framework-owned memory when collecting a snapshot. Remove each
registration when its owner closes. Do not reconstruct current state from
logs or copy it into a second state store.

An arbitrary `Source.get` or mailbox-store read can suspend. Do not use these
as unrestricted inspection callbacks. Read the actual in-memory cells that
the framework owns.

The snapshot needs mounted route identity and decoded values, open query
identity/state/staleness/age, actor identity/kind/revision, pending command
state, and URL key claims. Give the data a schema and stable order. State
whether it is atomic or a set of samples. Use the production Effect Clock
for ages. Reading must not open queries, spawn actors, send commands, or wait
for application work to finish.

The first release must mark command coverage `Unavailable` until real
command handles exist. Zero active request fibers do not prove that no
durable command remains pending. This field cannot be an empty complete list.

Use existing effect-machine inspection events for machine details where
they apply. Reducers, value actors, and Frame command/query ownership still
need their own Frame records. Do not claim a machine inspector covers all
Frame state.

The first API is an in-process read. A live text/JSON command needs an
explicit connection to the running root. A later bounded event history can
add causal IDs, transitions, interruption, and failure details. Keep current
state separate from history. Missing history is not proof that no actor exists.

The [Effect primitive review](./effect-primitives.md) selects `RcMap` for active
query ownership. It also records the limits of `PersistedQueue` and `EventLog`
for Frame's command receipts and current-state inspection.

## Delivery and acceptance

1. Keep #59's published QueryTest seam. Finish the reviewed migration of
   ordinary readiness cases. Keep controlled-source tests only where they
   state a source-level contract that the real cache cannot express.
2. Land #58's scoped read API. Prove root isolation, nonblocking reads,
   removal, authoritative revisions, query state, and virtual age.
3. Replace fixed-yield assumptions with a defined view completion boundary.
   Add a small scoped test wrapper around the production mount.
4. Add browser regression tests for the EGW flows already checked by hand.
5. Connect the inspection schema to live text/JSON tooling. Add bounded
   history only after the live read API has a tested owner and lifetime.

Full #58 closure still requires its live CLI acceptance. Command diagnostics
must follow #37's actual command handle states when those states land.

## Local source receipts

Foldkit:

- `/Users/cvr/.cache/repo/foldkit/foldkit/packages/foldkit/src/test/story.ts`
- `/Users/cvr/.cache/repo/foldkit/foldkit/packages/foldkit/src/test/scene.ts`
- `/Users/cvr/.cache/repo/foldkit/foldkit/packages/foldkit/src/test/internal.ts`
- `/Users/cvr/.cache/repo/foldkit/foldkit/packages/foldkit/src/test/query.ts`
- `/Users/cvr/.cache/repo/foldkit/foldkit/packages/foldkit/src/test/story.test.ts`
- `/Users/cvr/.cache/repo/foldkit/foldkit/examples/auth/src/page/loggedOut/page/login.story.test.ts`
- `/Users/cvr/.cache/repo/foldkit/foldkit/packages/foldkit/src/devTools/store.ts`
- `/Users/cvr/.cache/repo/foldkit/foldkit/packages/foldkit/src/runtime/devToolsIntegration.ts`
- `/Users/cvr/.cache/repo/foldkit/foldkit/packages/devtools-mcp/README.md`

Remix:

- `/Users/cvr/.cache/repo/remix-run/remix/packages/remix/package.json`
- `/Users/cvr/.cache/repo/remix-run/remix/packages/test/src/index.ts`
- `/Users/cvr/.cache/repo/remix-run/remix/packages/test/src/lib/config.ts`
- `/Users/cvr/.cache/repo/remix-run/remix/packages/test/src/lib/runner-browser.ts`
- `/Users/cvr/.cache/repo/remix-run/remix/packages/test/src/app/client/entry.ts`
- `/Users/cvr/.cache/repo/remix-run/remix/packages/test/src/lib/context.ts`
- `/Users/cvr/.cache/repo/remix-run/remix/packages/test/src/lib/fake-timers.ts`
- `/Users/cvr/.cache/repo/remix-run/remix/packages/fetch-router/src/lib/router.ts`
- `/Users/cvr/.cache/repo/remix-run/remix/packages/ui/src/test.ts`
- `/Users/cvr/.cache/repo/remix-run/remix/packages/ui/src/runtime/render.ts`
- `/Users/cvr/.cache/repo/remix-run/remix/packages/ui/src/runtime/vdom.ts`
- `/Users/cvr/.cache/repo/remix-run/remix/packages/cli/src/lib/commands/routes.ts`
- `/Users/cvr/.cache/repo/remix-run/remix/packages/cli/src/lib/route-map.ts`
- `/Users/cvr/.cache/repo/remix-run/remix/packages/cli/src/lib/commands/assets.ts`
- `/Users/cvr/.cache/repo/remix-run/remix/packages/cli/src/lib/doctor/run.ts`

Frame was reviewed in
`/Users/cvr/Developer/personal/.rifts/effect-frame/build-dx-round2` at
`2647ee1e574eeb56628717a3e2e5225d8e524b48`. The full source paths below point
to the matching files in the warm source. Its release commit
`c26875397b53ecd5994912df775accf743fa7267` changes package metadata only:

- `/Users/cvr/Developer/personal/effect-frame/packages/effect-frame/src/actor/testing/query.ts`
- `/Users/cvr/Developer/personal/effect-frame/packages/effect-frame/src/actor/query-client.ts`
- `/Users/cvr/Developer/personal/effect-frame/packages/effect-frame/src/actor/actor.ts`
- `/Users/cvr/Developer/personal/effect-frame/packages/effect-frame/src/actor/behavior.ts`
- `/Users/cvr/Developer/personal/effect-frame/packages/effect-frame/src/router/router.ts`
- `/Users/cvr/Developer/personal/effect-frame/packages/effect-frame/src/view/runtime.ts`
- `/Users/cvr/Developer/personal/effect-frame/packages/effect-frame/tests/view/query-test-layer.test.tsx`
- `/Users/cvr/Developer/personal/effect-frame/packages/effect-frame/tests/view/readiness.test.tsx`
- `/Users/cvr/Developer/personal/effect-frame/packages/effect-frame/tests/actor/source.test.ts`
- `/Users/cvr/Developer/personal/effect-frame/packages/effect-frame/tests/actor/http.test.ts`
- `/Users/cvr/Developer/personal/effect-frame/packages/effect-frame/tests/README.md`
- `/Users/cvr/Developer/personal/effect-frame/node_modules/.bun/effect-machine@0.27.0+4452d4a4fc6c5fd5/node_modules/effect-machine/dist/inspection.d.ts`
- `/Users/cvr/Developer/personal/effect-frame/node_modules/.bun/effect-machine@0.27.0+4452d4a4fc6c5fd5/node_modules/effect-machine/dist/testing.d.ts`
- `/Users/cvr/Developer/personal/.worktrees/bible-tools/egw-frame-dx/apps/egw-search/src/search-page.test.tsx`

## Validation limits

The comparison is a source review. The Remix runner and Foldkit test suite
were not executed. Focused Frame checks passed: seven Source tests and two
QueryTest tests. The reviewed #35/#52 changes also passed their full gates.
Browser behavior needs separate runtime proof.
