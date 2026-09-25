# Route pending and lazy views

This note records route execution slice 4: timed route setup presentation
and lazy views on the same transition owner as slices 2 and 3. The slice was
private when it landed. `Route.Pending` and `View.lazy` are now public (see
`docs/design/route-public.md`). Leave checks and browser commit are slice 5
and stay private. Streaming records (#22) are not part
of this slice.

Source: `packages/effect-frame/src/router/branch.ts` (`Pending`,
`Presentation`, `presentWith`, the ticket and timer in
`enterWith`, and `Tree.present`) and `packages/effect-frame/src/view/lazy.ts`.
Proofs: `packages/effect-frame/tests/router/route-pending.test.tsx`.

## Shape

```ts
const PostView = Lazy.lazy(() => import("./post-view.js"));

const tree = Branch.layout(tenant, [
  Branch.leaf(post, PostView, {
    errored: (failure) => <PostProblem failure={failure} />,
    pending: { fallback: <p>Opening post…</p>, after: "150 millis", atLeast: "200 millis" },
  }),
], LayoutView);
```

- `Lazy.lazy(load: () => Promise<{ default: View<P, E, R> }>)` returns a
  `View<P, E | LazyImportFailed, R>`. Props and R are the imported view's,
  exactly. `LazyImportFailed` is a `Schema.TaggedError` with a `message`.
- `pending: { fallback: Node; after: Duration.Input; atLeast: Duration.Input }`
  is an option of a leaf or a layout, beside `errored`. It has no defaults.
  The durations above are an example, not a contract.
- A view that cannot fail may pass `{ pending }` alone (`Presentation`). A
  view that can fail, a lazy view included, must pass `errored` for its
  whole `E`. A handler for the view's own `E` without `LazyImportFailed`
  does not compile.
- `after` and `atLeast` are decoded once, when the leaf or layout is
  defined, not on each presentation.
- `before`, `data`, matching, and `href` stay on the segment. They are
  available before the import, so nothing about a lazy view can start
  before the checks.

## Contract

### Pending has two owners

1. Route pending covers the preparation of an entered instance before its
   view can be drawn: its lazy import and its own suspended setup (a local
   actor it spawns, an actor ref it opens, any Effect it waits on). Query
   readiness is not preparation. `Loading` and the reads below it own it. A
   declared query that the view never reads blocks nothing, and there is no
   synthetic query registration for an import or for setup.
2. Timing starts when the transition enters the segment. That is after
   every check continued, parent first. Until then the current page stays.
   The transition records the start time with the Effect `Clock` in
   `enterWith`, not when the row happens to run, so the timer does not
   depend on scheduling.
3. With `pending`, the instance's setup returns at once. The owned attempt
   runs on a fiber in the view Scope. The presentation is a keyed list with
   at most one row: nothing, then `fallback`, then the view's node.
4. The fallback is drawn at `begin + after`, unless the setup already
   finished. `begin` is the later of the transition's start time and the
   `Clock` read when the instance's presentation starts. A child under a
   parent that is still preparing starts its presentation only when the
   parent's view draws its outlet. Its `after` counts from then, so a child
   whose work lands soon after its parent does not flash its fallback. A
   result that is already there wins over a deadline that has already
   passed. Work that finishes sooner never draws the fallback.
5. Once drawn, a successful setup's node replaces it at `shown + atLeast` at
   the earliest. `shown` is the `Clock` read after the fallback was set, not
   a deadline. So a late fallback still holds for the whole `atLeast`.
6. A typed setup failure, `LazyImportFailed` included, draws `errored` at
   once. The minimum never holds a failed owner. A defect removes the
   fallback at once and fails the presenting fiber.
   A setup defect registers nothing with the nearest `Loading`: a
   `Loading` with no registration shows its content, so it never holds a
   defect's region.
7. Route exit, a redirect away, and root close close the view Scope. That
   interrupts the setup fiber and the timer fiber. Nothing waits for
   `atLeast`, and nothing is drawn late. The owned attempt also refuses a
   result that completes after its owner closed.
8. A stayed segment never presents pending. Its successful setup and local
   state stay. A param move of a stayed post is not a new preparation.
9. While the instance prepares, its region registers nothing with the
   nearest `Loading`. So a layout that yields its outlet inside `Loading`
   presents the route's fallback, not its own, when the setup makes no read
   before it suspends. Once the view's node is drawn, the view's own reads
   decide that `Loading`. This is not a full guarantee: the
   setup's reads register with that same `Loading` while it prepares. A
   read that is not ready, made before a later suspension, keeps that
   `Loading` pending, so its fallback covers the route's fallback until the
   read settles. See the limits.

### Lazy lifetime

1. One definition keeps one state: `Idle`, `Loading` (one in-flight
   attempt), or `Loaded` (the module's default view). It keeps nothing
   else: no request context, no props, no view result, no Scope, and no
   error.
2. The transition takes an attempt (a ticket) when it enters the segment,
   beside declaration acquisition, after checks. The instance's setup waits
   on that same attempt, so one navigation never imports twice.
3. Every waiter joins the in-flight attempt. A loaded module is reused. Each
   live instance runs the imported view's own setup, with its own props and
   Scope.
4. A rejected import returns the definition to `Idle` before any waiter
   resumes. The failure lives only in the attempt its waiters hold. The next
   attempt imports again. This does not promise that a platform with a
   cached module evaluation failure will succeed on the second import.
5. The platform import runs on a detached fiber with an empty context. It
   does not keep the first waiter's services, Scope, or fiber references
   alive after that waiter leaves. An interrupted waiter loses
   its right to continue; the import is not canceled. If it succeeds after
   every waiter left, the module is kept for the next instance, and nothing
   is set up or drawn.
6. Two roots may share a module. They never share an instance.

### Server first frame

The rule of slices 2 and 3 stays: a first frame holds the route's own setup.
The tree's first mount on the initial navigation (`Router.navigations` kind
`initial`, or no `Router` at all) never presents pending, and it waits for
every entered segment's import before it creates an instance. So the first
frame holds the imported views' setups and never a pending fallback. A
failed import there reaches `errored` through the same attempt (by
construction; no separate proof). Query reads
under `Loading` still present that Loading's fallback in the first frame
(slice 2, proof 5); that is query readiness, not route preparation.

## Evidence

All proofs use a real local `ActorHost.layer`, `ViewTest` over the DOM host (proof 7
uses the HTML host), `TestClock`, and one `Frame`. Waits are receipts: the
import's own start and settle queues, setup and close queues, held queries,
an `attach` on the fallback that records each time it reaches the document,
and `page.waitFor` conditions. No proof sleeps or counts yields. Each lazy
definition is made per proof, so no module state crosses proofs.

| Proof                                                                                     | What it shows                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0. "keeps exact lazy Props, E, and R, and typed pending options"                          | The lazy view's props equal the imported view's; its `E` is exactly `PostFailed \| LazyImportFailed`; its R equals the imported view's (`LoadingScope \| Scope`). The route's services stay `QueryCache \| ActorTransport \| Access`. A never-failing view takes `{ pending }` alone. `@ts-expect-error`: a lazy view without `errored`, a handler without `LazyImportFailed`, a module whose view takes other props, and a non-duration `after`.                  |
| 1. "imports after checks, shows pending only after `after`, and keeps it `atLeast`"       | The event log is `check:tenant`, `check:post`, `import:1`. The receipt is `Committed` while the import is held. At 99ms the region is live and the fallback never reached the document; at 100ms it shows. The import lands and setup completes at 100ms; at 399ms the fallback still shows and the view does not; at 400ms the view shows. A stayed param move runs no setup. A new instance with the loaded module never shows the fallback and imports nothing. |
| 2. "one import serves two roots; each instance runs its own setup, Scope, and state"      | Two routers on two roots enter the post while one import is in flight: one import call, two setups, two local actors with distinct ids. Bumping root A's actor leaves root B's value. Closing root A closes only its instance. A new instance in root B reuses the module with a fresh setup.                                                                                                                                                                      |
| 3. "a typed import rejection shows errored at once, and a later attempt imports again"    | With the fallback shown, the chunk fails: `Setup:LazyImportFailed` shows without any clock movement, and no setup ran. The next navigation enters the failed instance again and imports a second time, then shows the view. Then a post whose own setup fails with `PostFailed` while its fallback shows draws `Setup:PostFailed` with no clock movement.                                                                                                          |
| 4. "exit, redirect, and root close remove the fallback at once and mount nothing late"    | Exit to `/login` with the import in flight: login shows with no clock movement; the import settles later, and no setup runs and nothing is drawn; no query is left. A redirect away from a post whose own setup is suspended: login shows, the post's finalizer ran, its local actor is gone. A root close with the fallback shown: after the setup's gate opens, nothing is drawn; no local actor, query, mount, or route remains.                                |
| 5. "an unread held query blocks neither the route nor the removal of its fallback"        | The declared post query is held and never read. The view shows at `after + atLeast` and the fallback is gone; the query was called once and is still in flight.                                                                                                                                                                                                                                                                                                    |
| 6. "a protected lazy child's import never starts when its parent check redirects"         | A denied initial URL and a denied push: two tenant questions, no post question, no import, no setup. A permitted navigation then imports once.                                                                                                                                                                                                                                                                                                                     |
| 7. "the initial first frame waits for the import and setup, and never shows pending"      | The HTML mount does not return while the import is held, even after one second of test clock. After the import, the post's setup has run when the mount returns. The serialized frame contains `<section id="layout"><p id="post-first">post 1</p></section>`, so the post's output is in the first frame, and it has no pending fallback. Close leaks nothing.                                                                                                    |
| 8. "a setup defect removes the fallback at once and leaves the enclosing Loading settled" | A post whose setup dies while its fallback shows: with no clock movement the fallback goes, the layout's `Loading` does not show its fallback, `errored` is not built, and the instance closed. A later navigation sets up a new post.                                                                                                                                                                                                                             |
| 8b. "without pending, a setup defect still leaves the enclosing Loading settled"          | The same defect in a plain leaf with no `pending`. The layout's `Loading` shows its fallback while the setup waits, then settles after the defect.                                                                                                                                                                                                                                                                                                                 |
| 9a / 9b. "under a lazy parent that lands late, the child …"                               | A lazy layout and a lazy leaf, both with `pending`. Both imports start on entry. The parent's fallback shows at 100ms, and its import lands at 500ms. 9a: the child's import then lands with no clock movement, and the child's fallback never reaches the document. 9b: at 99ms after the parent drew, the child's fallback is not shown; at 100ms it shows; its import lands; 299ms later it still shows and the child view does not; 1ms later the view shows.  |
| 10a / 10b. "under a slow parent setup, the child …"                                       | The same two scenarios, with a plain parent whose own setup waits on a gate, opened late, in place of a lazy parent.                                                                                                                                                                                                                                                                                                                                               |

### Mutations

Each mutation was applied to the source and the proof file was run. The
original was restored after each run. The runs were scripted in the session
scratchpad; this table is the record.

| Mutation                                                                                        | Killed by        | First failure                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1: ignore `after` (draw the fallback at the start)                                             | 1, 2, 8, 9, 10   | the fallback was in the document at 99ms                                                                                                                                                                                             |
| M2: ignore `atLeast`                                                                            | 1, 9b, 10a, 10b  | the fallback was gone at 399ms                                                                                                                                                                                                       |
| M3: hold `atLeast` after a typed failure too                                                    | 3                | `ConditionNotObserved`: the typed import failure                                                                                                                                                                                     |
| M4: start the import when the URL matches, before checks                                        | 6                | one import call where none was expected                                                                                                                                                                                              |
| M5: do not wait for the import on the initial first mount                                       | 7                | the mount returned while the import was held                                                                                                                                                                                         |
| M6: keep a failed import as the in-flight attempt                                               | 3                | the second navigation never imported again (timeout)                                                                                                                                                                                 |
| M7: do not settle the enclosing `Loading` while preparing                                       | 1, 2, 3, 4, 5, 8 | `ConditionNotObserved`: the presentation region                                                                                                                                                                                      |
| M8: present pending during the first mount                                                      | 7                | the mount returned while the import was held                                                                                                                                                                                         |
| M9: run the setup on a fiber the instance does not own                                          | 4                | a setup ran after the route exited                                                                                                                                                                                                   |
| M10: count `after` from the transition start only (`begin = startedAt`)                         | 9a, 9b, 10a, 10b | the child's fallback was already recorded when the parent drew                                                                                                                                                                       |
| M11: count `atLeast` from the `after` deadline, not the `Clock` read after the fallback was set | not killed       | equivalent under `TestClock`: a sleeping presenter wakes exactly at its deadline, so the two reads are equal. The difference is scheduler latency on a real clock. The deadline fix (M10) carries the observable part of the defect. |
| M12: do not settle `Loading` on a setup defect                                                  | 8b               | `ConditionNotObserved`: the settled region after a defect                                                                                                                                                                            |

## Limits

- **Declared actor acquisition is not under pending.** The scope lists
  actor initial acquisition as route preparation. A declared actor is
  acquired by the transition before it publishes anything (slice 2's
  entering-before-exited rule and its all-or-nothing failure). During that
  wait the current page stays, as it does during a check; the fallback
  cannot show, because showing it would publish the entered instance first.
  An actor that the view itself opens or spawns in setup is under pending.
  A stayed segment whose declaration key moves has the same gap: it
  acquires the new key above presentation too. See the planned follow-up.
- **A setup read before a suspension can hide the route fallback.** The
  setup's reads register with the nearest `Loading` while the instance
  prepares. A read that is not ready keeps that `Loading` pending, so its
  fallback covers the route's fallback until the read settles. A setup that
  reads after it suspends, or reads in its returned node, does not show
  this. A correct fix needs a Loading boundary owned by the presentation,
  which would change how the view's reads decide the enclosing `Loading`
  after the view draws. It is not in this slice.
- **Cold client start shows no pending.** The first mount on the initial
  navigation waits for imports and setup on every host, because the tree
  cannot tell a server render from a client cold start. A slow chunk on a
  cold client start shows the previous document state (nothing) until it
  loads.
- **Server boundary: not proved, because it does not exist.** As in slice 3,
  there is no server route adapter. Proof 7 uses the HTML host under the
  real router, which is the permitted first-frame behavior. A child whose
  own setup suspends for another reason (a local actor it waits on) still
  lands after the first frame, as a suspended row does today; only its
  import is awaited before the shell. #22 streaming records, late setup
  error records, and `AwaitAll` are not implemented.
- The detached import's empty context has no proof. Context retention is
  not observable from load order or receipts in a test.
- A defect in a presented setup fails the presenting fiber after the shell.
  It cannot fail the navigation that already committed. Without `pending`,
  the setup runs in place, as before.
- A presented instance's setup Effect is not in the router's first-frame
  wait. `Committed` means the instance is installed and presenting, not that
  its view is drawn.
- The attempt a transition takes is not shared with a direct mount of the
  same lazy view outside the router; that mount starts or joins its own
  attempt through the definition.
- No browser proof: the module import is a test Promise, not a bundler
  chunk. Real chunk caching and evaluation failure are platform behavior.
- Leave checks, `Stayed`, and precommit browser behavior are slice 5. They
  stay private.

## Planned follow-up: declared acquisition under pending

For a segment that declares `errored`, declared actor acquisition moves
inside the pending window with this transition:

1. Commit after the checks continue.
2. Close the old view.
3. Keep the old interests until the new acquisition settles.
4. Install an acquiring instance that presents `pending`. An acquisition
   failure goes to `errored` as `Declaration`.

A segment without `errored` keeps today's rule: acquisition stays above
presentation and the old page stays. A stayed segment whose declaration key
moves has the same gap and gets the same transition.

## Open questions

- Should a client cold start present pending? That needs a host or mount
  signal that separates a server first frame from a client one. Chosen now:
  no; every initial first mount waits.
- Should the presenting fiber's defect reach an inspection record instead
  of the fiber's reporter? Chosen now: it follows a suspended row's defect.
