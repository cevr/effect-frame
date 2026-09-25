# Route leave checks and browser commit (private proof)

> Decision record: it explains a choice as of its day, and its code may be
> out of date. The reference is [the package README](../../packages/effect-frame/README.md)
> and the JSDoc.

This note records route execution slice 5: scoped leave checks, the `Stayed`
receipt, and a browser `Location` that lets the router answer a Back or
Forward before it commits. All of it is private. `src/router/leave.ts`,
`src/router/leave-registry.ts`, `src/router/traversal.ts`, and
`src/router/browser-commit.ts` are not exported from `effect-frame/router`.
`src/router/index.ts`, `src/index.ts`, and `package.json` did not change.
There is no Changeset. Issues #31 and #56 stay open.

**The owner decision in scope §6 is still open.** This slice implements the
recommended answer so that it can be reviewed: Stay is guaranteed only on
router-controlled navigation and on a platform traversal that is proved
cancelable; durable draft preservation stays an application concern; the
unsupported Back and unload paths are stated below. This is not a claim that
the owner accepted it. The same holds for the scope's semantic amendment
(ask on stayed param or search changes as well as exits), which this slice
also implements.

Source: `packages/effect-frame/src/router/leave.ts`,
`packages/effect-frame/src/router/leave-registry.ts`,
`packages/effect-frame/src/router/traversal.ts`,
`packages/effect-frame/src/router/browser-commit.ts`,
`packages/effect-frame/src/router/receipt.ts`, and the private hooks in
`packages/effect-frame/src/router/branch.ts` and
`packages/effect-frame/src/router/router.ts`.
Proofs: `packages/effect-frame/tests/router/route-leave.test.tsx` (fixture
`Location`), `packages/effect-frame/tests/router/browser-commit.test.ts` (the
adapter with a fake `window.navigation`), and `packages/effect-frame/tests/router/route-leave-browser.test.ts`
(real Chrome and WebKit through `Bun.WebView`, with the page in
`tests/router/browser/leave-app.tsx` and the harness in
`tests/router/browser/harness.ts`).

## Shape

```ts
const PostView = (props: Branch.PropsOf<typeof post>) =>
  Effect.gen(function* () {
    const draft = yield* Draft.local(); // anything this instance owns
    // One registration on the mounted instance. It closes with the view's Scope.
    yield* Leave.onLeave(post, ({ previous, next, destination, kind }) =>
      Effect.gen(function* () {
        const dirty = yield* draft.isDirty;
        if (!dirty) return Leave.Leave;
        // Same post, other tab: a refinement. Allow it.
        if (Option.isSome(next) && next.value.params.postId === previous.params.postId) {
          return Leave.Leave;
        }
        // A dialog may acquire here: its Scope closes on every result.
        return yield* Confirm.ask(`Discard the draft for ${destination.pathname}?`);
      }),
    );
    return <article>…</article>;
  });
```

- `onLeave(owner, check)` needs `MountedRoute` and `Scope` in R. Each segment
  instance provides its own `MountedRoute` around its own view setup, so a
  child's registration never lands on its layout. An owner that is not the
  mounted segment is a defect (`LeaveOwnerMismatch`). The owner narrows the
  input's params and search; that is the one cast in `leave.ts`.
- The check's services are captured from the view's context at registration.
  The question runs with those services, a read-only `Router`, and a fresh
  temporary `Scope`. The view's Scope is never carried into it.
- `LeaveInput` has `previous` values, `next` values (`None`: the segment
  exits), the `destination` URL, and the `kind` (`push`, `replace`, `pop`).
  Values, not Sources.
- `ViewServices<R>` removes `MountedRoute` and `Scope` from a view's R, so the
  route's public service type does not change.
- `Receipt.Stayed(url)` is a new receipt constructor: a check answered Stay
  and nothing moved. A prompt superseded by a newer request reports
  `Unchanged`.

## Contract

### Order

A controlled push or replace, and a protected traversal, run in this order:

1. **Settle.** Match the candidate and run the slice 3 `before` checks and
   redirects. This opens no destination data.
2. **Leave.** Collect the old tree's questions for the settled URL and ask
   them. Nothing is asked when none is registered.
3. **History.** Push or replace once, to the settled URL; for a traversal,
   let the platform commit.
4. **Move.** Declarations, setup, and release (slice 2).

A Stay stops at step 2. The URL, the history entry, the declarations, the
DOM, and focus stay as they were.

### Which instances are asked

- Deepest first. The router stops at the first Stay.
- An instance is asked when its segment exits, or when it stays with changed
  params or search (its signature changes). An unchanged stayed segment is
  not asked. Inside one instance, its own registrations are asked in reverse
  order of registration.
- A failed instance (its setup failed into `errored`) registers nothing and
  is asked nothing.
- A replacement instance is a new registration. The old instance's checks
  unregister when its view Scope closes, so they can never veto the new one.
- Root close is cleanup, not a navigation. It asks nothing.

### Supersession and stale answers

The router holds at most one prompt. A newer request that would really move
supersedes it at admission; so does a traversal the platform abandons. A
request moves when it is a platform move (a pop or a traversal), or a push or
replace from the live instance (or from no instance) whose resolved URL
differs from the committed one. A same-URL request, a stale instance's
request, and a url-state write that changes nothing do not end a prompt; they
queue behind it and report `Unchanged`. A url updater is called once at
admission to judge this and again when the request runs, so it must be pure.

A superseded prompt's fiber is interrupted, its temporary Scope closes, and
its answer, if it ever arrives, decides nothing. The superseded request
reports `Unchanged`, and its traversal is refused. When a moving request is
already queued behind the one about to prompt, the prompt is superseded at
once.

### Failure, close, and the one consumer

- A failure or a defect while a protected traversal runs (a check dies,
  `settle` dies with `RedirectCycle`) answers `stay` before the traversal is
  finished: the platform does not commit a URL the router never showed. A
  `stay` after `leave` changes nothing, so a failure after the platform
  committed (in `move`) cannot be undone; that is the slice 2 limit.
- A traversal source (`traversal.ts`) has exactly one consumer: the router
  mounted on that `Location`, for the router's lifetime. A second router on
  the same `Location` is a defect (`TraversalConsumerTaken`).
- Root close is cleanup: when the consumer's Scope closes, the source lets
  every traversal it has not finished through, whatever the router was doing
  with it. This is the one owner of close; the router's own close does not
  answer traversals.
- Without a consumer, nothing is held: an offered traversal is let through at
  once, and the browser adapter does not intercept at all, so a mount that
  closes before its `Location` never leaves the platform waiting.

### Browser commit

`browserCommit(precommit)` is the browser `Location` with a private
traversal source (`traversal.ts`) beside the public `pops`. The capability is
read from each `navigate` event, never from `window.navigation` alone. Only a
same-document traversal that `canIntercept` and is not a fragment change
reaches the router.

| Event                                                           | `protection` | What happens                                                                                                                                                                                                |
| --------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cancelable`, and `NavigationPrecommitController` exists        | `precommit`  | Intercepted with a precommit handler that waits for the router. Stay rejects it: the entry never commits. Leave resolves it.                                                                                |
| `cancelable`, precommit engine with `precommit: "off"`          | `cancel`     | `preventDefault()` at once. Leave calls `traverseTo(key)` once with a private `info` marker; the listener lets that event through without asking again. History never moved. Stay does nothing more.        |
| `cancelable`, no precommit handler in the engine (WebKit)       | `none`       | As the row below, with `reason=noncancelable`. A canceled traversal is not safe there (see "WebKit and a canceled traversal").                                                                              |
| not `cancelable` (browser UI without history-action activation) | `none`       | Intercepted so the router can install the shell, but not asked: it follows the platform and logs `route.leave.unprotected url=… kind=pop checks=N reason=noncancelable` when a check would have been asked. |
| no Navigation API                                               | —            | `browserLocation`: the router follows `popstate` after commit and logs the same line with `reason=committed`.                                                                                               |

`intercept` may throw. The adapter claims an entry key (drops its `popstate`)
only after `intercept` succeeded. A failed precommit intercept falls back to
`cancel` when the event is cancelable; a failed plain intercept leaves the
move to `popstate`, which the router follows and reports. A failed intercept
of a re-issued traversal tells the router the commit did not happen here;
`popstate` then carries it.

There is no `history.go` compensation and no `beforeunload` substitute. The
report is a log line, not a Snapshot field, because the public inspection
types must not change in a private slice.

### WebKit and a canceled traversal

Observed on macOS 27 (Darwin 27.0.0), where `Bun.WebView` WebKit has the
Navigation API but no `NavigationPrecommitController`. On a bare page with
no router, after `preventDefault()` on a cancelable Back:

- The document stays on entry 1, and `navigation.currentEntry.index` is 1.
- WebKit's own back-forward list moved to entry 0.
- `navigation.traverseTo(key)` (with or without `info`, at once, in a
  microtask, or after 50 ms) and `navigation.back()` reject with
  `AbortError` and start a `reload` navigation of the current URL.
- `history.back()` then does nothing, and `history.forward()` reloads.

So the `cancel` path lost the page's state on Leave, and the proof "a wholly
stayed traversal keeps the caret" timed out waiting for a traversal that
became a reload. This is a platform fact, not a race. A longer timeout would
not help. The adapter now cancels only on an engine that has precommit
handlers (Chrome with `precommit: "off"`). Elsewhere a cancelable traversal
is `none`: followed, not asked, and reported with `reason=noncancelable`.
The WebKit suite is skipped on Linux CI (no `Bun.WebView` WebKit backend), so
CI never saw the failure.

### Scroll and focus (#31)

See `docs/design/navigation-behavior.md`. Every intercept uses
`scroll: "manual"` and `focusReset: "manual"`; the router lands at shell
commit through `Traversal.land`, before `finish`. A stayed segment keeps its
caret because focus moves only when the deepest segment entered. The router
writes and reads no scroll position.

## Evidence

The fixture proofs use a real local `ActorHost.layer`, the real actor transport,
`ViewTest`, and one `Frame` over one root. The history is a fixture `Location`
that records every push and replace, feeds pops, and carries a fixture
traversal queue. Waits are `Deferred` receipts. The browser proofs drive real
pages; they wait with `waitFor` conditions, and a Stay (which leaves nothing
to wait for) is followed by a 150 ms margin before the unchanged state is
asserted.

| Proof (`route-leave.test.tsx`)                                                                          | What it shows                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0. "keeps exact registration and route types"                                                           | The input's `previous.params` and `next` (an `Option` of the owner's `Values`) have the owner's exact types. A registration needs exactly `MountedRoute \| Scope \| Policy`; the route needs exactly `QueryCache \| ActorTransport \| Policy`. |
| 1. "Stay keeps the URL, declarations, DOM, and focus; then Leave commits once"                          | A held Stay: no history, no destination query or actor, the same post element, focus and caret on the draft; receipt `Stayed`. Leave: exactly one push.                                                                                        |
| 2. "a stayed post-ID change is refused and a search refinement is allowed"                              | `tenant=t1,postId=1\|tab=read` to `postId=2` is asked and refused; a `tab` change is asked and allowed. The layout is never asked.                                                                                                             |
| 3. "asks the deepest instance first and stops at the first Stay"                                        | Post before layout; a post Stay leaves the layout unasked.                                                                                                                                                                                     |
| 4. "a newer navigation supersedes a held prompt; the stale answer decides nothing"                      | The first receipt is `Unchanged`; its temporary Scope closed; the late answer changes nothing; the newer request commits.                                                                                                                      |
| 5. "a root close during a held dialog asks nothing more and leaks nothing"                              | Close interrupts the prompt, the dialog Scope closes, no layout question, no history, no local actor, query, mount, or route.                                                                                                                  |
| 6. "a route action during a held prompt commands the committed target"                                  | While the prompt holds, a post action still reaches post 1.                                                                                                                                                                                    |
| 7. "a check of a replaced instance never vetoes its replacement"                                        | After a failed setup and a replacement, only the live instance is asked; the failed one registered nothing.                                                                                                                                    |
| 8. "a check's temporary Scope closes on every result"                                                   | Stay, a held dialog answered Leave, and Leave each close the check's Scope once, and a held dialog's Scope is open while it waits. The view's Scope is untouched: the same post instance still shows. (Interruption closes it in 4 and 5.)     |
| 9. "a protected traversal is asked before commit; an unprotected one is followed and reported"          | `precommit`/`cancel` traversals are asked before the fixture commits and Stay refuses; a `none` traversal and a committed pop are followed, not asked, and log `reason=noncancelable` / `reason=committed`.                                    |
| 10. "a registration for another segment than the mounted one is a defect"                               | `LeaveOwnerMismatch` as a defect.                                                                                                                                                                                                              |
| 11. "a defect during a protected traversal refuses it; the router keeps working"                        | A dying check on a `precommit` and on a `cancel` traversal: each is answered `stay` before it finishes; no history, the URL and the view stay on post 1; the next push commits.                                                                |
| 12. "a request that would not move leaves an open prompt alone"                                         | During a held dialog: a no-op url updater, a same-URL push, and a stale instance's push close no Scope and remove no dialog. Stay then gives `Stayed`; the three give `Unchanged`; one question, no history.                                   |
| 13. "one router consumes a Location's traversals; a closed one holds nothing"                           | A second router on the same `Location` dies with `TraversalConsumerTaken`. After the first closes, the source is inactive and a new traversal is let through at once.                                                                          |
| 14. "a push supersedes a traversal prompt, and the traversal is refused"                                | The traversal is answered `stay`, its dialog Scope closes, the push prompts and commits once.                                                                                                                                                  |
| 15. "a pop supersedes a push prompt, and the router follows the pop"                                    | The push reports `Unchanged`, its dialog Scope closes, the router shows the popped post and logs `reason=committed`; no history write.                                                                                                         |
| 16. "a traversal the platform abandons during its prompt decides nothing"                               | Abandonment answers `stay`, finishes the traversal, and closes the dialog; the late answer moves nothing.                                                                                                                                      |
| 17. "a root close during a traversal prompt lets the traversal through; a closed router admits nothing" | Close answers the held traversal `leave` (cleanup, not a refusal) and closes the dialog; a later `navigate` writes no history.                                                                                                                 |

| Proof (`browser-commit.test.ts`, fake `window.navigation`)                  | What it shows                                                                                                 |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| "a precommit intercept that throws falls back to cancel and claims nothing" | One `intercept` try, one `preventDefault`, a `cancel` traversal; the entry's `popstate` still reaches `pops`. |
| "a noncancelable intercept that throws leaves the move to popstate"         | No traversal; the entry's `popstate` reaches `pops`.                                                          |
| "an accepted intercept claims its key: that popstate is dropped"            | A `none` traversal; the entry's `popstate` is dropped.                                                        |
| "without a consumer the adapter holds nothing"                              | No `intercept`, no `preventDefault`; `popstate` reaches `pops`.                                               |

| Proof (`route-leave-browser.test.ts`)                                                      | Engine | What it shows                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "records the engine's capabilities"                                                        | both   | Each engine is probed once before the proofs are declared; the fixture page must see the same values. Chrome must have `navigation`. The Chrome precommit proof skips (not fails) without `NavigationPrecommitController`.                                                         |
| "Back and Forward: a precommit Stay keeps everything; Leave commits once"                  | Chrome | A held `history.back()`: path, entry index, the same `#post` element, the draft text, focus, and the caret `[1, 3]` unchanged while held and after Stay. Leave moves one entry. Forward is refused, then permitted. No unprotected log.                                            |
| "without a precommit handler: the canceled event is re-issued once on Leave"               | Chrome | `precommit: "off"`: Stay keeps everything; Leave asks exactly once more and moves one entry; the entry count is unchanged.                                                                                                                                                         |
| "a noncancelable browser-UI Back is followed and reported, never stayed"                   | Chrome | DevTools `Page.navigateToHistoryEntry` without activation: the page moves, the check is not asked, one `reason=noncancelable` log. After a real click, the same UI Forward is cancelable and a Stay keeps the page.                                                                |
| "Back and Forward restore each entry's scroll once the router is done"                     | Chrome | Scroll 1200 on post 1, 300 on post 2: Back and Forward restore each; Back from the short not-found page restores 300 on post 2.                                                                                                                                                    |
| "a wholly stayed traversal keeps the caret"                                                | both   | Back from `?tab=b` to `?tab=read`: the same post element, draft, focus, and caret.                                                                                                                                                                                                 |
| "Back is stayed where the engine can cancel it, and followed and reported where it cannot" | WebKit | Branches on the probe before Back. With a precommit handler: Stay keeps the page, one more question, no log. Without one: the check is not asked; one log, `reason=noncancelable` with the Navigation API and `reason=committed` without it; Forward and Back still move after it. |

### Engine support observed

Host: macOS 15 (Darwin 24.6.0), Bun 1.4.2.

| Engine                                 | Navigation API | Precommit handler | Programmatic `history.back()` | Browser-UI Back (DevTools)                                  |
| -------------------------------------- | -------------- | ----------------- | ----------------------------- | ----------------------------------------------------------- |
| HeadlessChrome 153 (`Bun.WebView`)     | yes            | yes               | cancelable                    | not cancelable without activation; cancelable after a click |
| WebKit 605.1.15 (`Bun.WebView`, macOS) | no             | no                | `popstate` after commit       | not driven (WebView has no toolbar path)                    |
| WebKit (`Bun.WebView`, macOS 27)       | yes            | no                | cancelable, not safely        | not driven                                                  |

Also observed in Chrome 153, on a bare page with no router: after a
precommit rejection of a Forward, `history.forward()` fires no `navigate`
event at all; `navigation.forward()` does. The proof uses
`navigation.forward()` for the permitted Forward. For an intercepted
traversal, `popstate` fires after the handler starts, so the adapter drops
`popstate` for an entry the router already holds. Chrome does not accept a
precommit handler on a noncancelable event: with the cancelable guard removed
(B3), the adapter's `intercept` fallback turned that Back into `none` and the
proof still passed. Firefox was not run.

### Mutations

Each mutation was applied to the source, the proof file was run, and the
original was restored. The runs were scripted in the session scratchpad; this
table is the record.

| Mutation                                                      | Killed by                                              |
| ------------------------------------------------------------- | ------------------------------------------------------ |
| M1: ask after history moves                                   | fixture 1–6, 8                                         |
| M2: ask shallowest first                                      | fixture 3, 5                                           |
| M3: no supersession of a held prompt                          | fixture 4, 5                                           |
| M4: ask exits only (stayed changes not asked)                 | fixture 1, 2, 3, …                                     |
| M5: never unregister a check                                  | fixture 7                                              |
| M6: no temporary Scope for a check                            | fixture 4, 8                                           |
| M7: no unprotected report                                     | fixture 9                                              |
| M8: a noncancelable traversal is treated as protected         | fixture 9                                              |
| M9: a superseded prompt reports `Stayed`                      | fixture 4                                              |
| M10: an unchanged layout is asked                             | fixture 1, 2, 7, 8, 9                                  |
| B1: `focusReset: "after-transition"`                          | browser caret proof                                    |
| B2: the precommit handler ignores Stay                        | browser Back/Forward, noncancelable (after activation) |
| B3: a noncancelable event is treated as `precommit`           | killed before F2; now **equivalent** (see above)       |
| B4: the re-issued traversal is asked again                    | browser cancel path                                    |
| B5: `scroll: "manual"`                                        | browser scroll                                         |
| B6: the traversal handler resolves at commit, not at `finish` | **survives**                                           |
| N1: a defect in a protected traversal does not answer `stay`  | fixture 11                                             |
| N2: interruption also answers `stay`                          | **equivalent**: the source's close answers first       |
| N3: every admitted request supersedes a prompt                | fixture 12                                             |
| N4: a source queues a traversal without a consumer            | fixture 13                                             |
| N5: a second consumer is allowed                              | fixture 13                                             |
| N6: an abandoned traversal does not end its prompt            | fixture 16                                             |
| N7: a push does not supersede a prompt                        | fixture 4, 5, 14, 16                                   |
| N8: the consumer's close does not let held traversals through | fixture 17                                             |
| F2a: claim the key before `intercept`                         | adapter 1, 2                                           |
| F2b: no `cancel` fallback after a failed precommit intercept  | adapter 1                                              |
| F5c: hold a traversal without a consumer                      | adapter 4                                              |

B6 survives because the router installs the shell in the microtasks after
commit, before the browser restores scroll, even from a short page. The wait
on `finish` is correct for a slow shell (held setup or lazy import) but no
proof here makes the shell slow. It is recorded, not claimed.

## Limits

- **Unsaved work is not protected on every Back.** A browser-UI Back without
  history-action activation is not cancelable; the router follows it and
  logs. Without the Navigation API (WebKit here), every Back commits first
  and is followed and logged. A document unload (close, reload, cross-document
  navigation) asks nothing: there is no `beforeunload` bridge. An application
  that must never lose a draft must persist it.
- No history compensation: an unprotected traversal is never undone with
  `history.go`.
- The report is a log line (`Effect.logWarning`), not an inspection record.
  A Snapshot field for it needs a public inspection change.
- #31 is built; see `docs/design/navigation-behavior.md`. B6 above is the
  timing gap in the proof.
- On root close, a `cancel` traversal that was already canceled stays
  canceled; the platform is not asked to redo it.
- A held precommit Back is aborted when a push commits meanwhile: the
  router's `pushState` for that push aborts the pending traversal in the
  browser (probe 2 of the slice 5 review). The traversal is refused, not
  committed later.
- The WebKit proof's precommit branch did not run: no WebKit here has a
  precommit handler. On macOS 27 its Navigation-API branch runs, and a
  cancelable Back there is followed and reported, not stayed.
- A check sees `kind: "pop"` for both Back and Forward; the direction is not
  exposed.
- Firefox, Safari with the Navigation API (26.2+), and a headed Chrome
  toolbar were not run. The DevTools history entry command stands in for the
  toolbar button.
- The browser `Location` is private. The public `Location.browser` is
  unchanged and still follows `popstate` only.

## Open questions

- Scope §6: is the documented platform limit acceptable for unsaved work?
  Implemented now: the recommended answer, pending the owner.
- Scope §6 amendment: ask on stayed param or search changes as well as exits.
  Implemented now, pending the owner.
- Should the unprotected report become an inspection record? Chosen now: a
  log line, because the public types stay fixed in a private slice.
