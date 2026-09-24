# Navigation behavior

This note records how #31 (scroll restoration and focus management on
navigation) is built, as part of #36. It lists the decisions that the ticket
left to the build and the places where the build differs from the ticket
text. The ticket's resolution comment stays the source of the design.

Sources:

- `packages/effect-frame/src/router/navigation-behavior.ts` — `NavigationBehavior` (public).
- `packages/effect-frame/src/router/landing.ts` — `Shell`, `Landing`, `Surface` (private).
- `packages/effect-frame/src/router/leaf-root.ts` — the leaf root mark (private).
- `packages/effect-frame/src/router/navigation.ts` — `browserLocation`, `followLinks`, and where a landing puts scroll and focus (browser only).
- `packages/effect-frame/src/router/browser-commit.ts` — `browserNavigation` (browser only).
- `packages/effect-frame/src/router/router.ts` — the landing at shell commit.
- `packages/effect-frame/src/router/branch.ts` — the drawn signal and the shell of a mounted tree.

Proofs: the #31 rows in [the acceptance matrix](acceptance.md).

## The rule

At shell commit, the router lands the navigation once. Under `Restore`, the
platform's default position (top, fragment, or the entry's saved position)
is placed through `event.scroll()`, and focus moves to the entering leaf.
Under `Preserve`, a push or replace moves nothing. A traversal (Back,
Forward, `navigation.traverseTo`) puts back the entry's saved position
under either behavior, and focus moves only under `Restore` (decision 9).
A traversal lands later than shell commit: once the reads the drawn
branch declared have settled and the drawing shows them (decision 10).
The router holds no scroll position, reads none, and never sets
`history.scrollRestoration`.

## Public surface

```ts
import {
  NavigationBehavior,
  Route,
  browserNavigation,
  followLinks,
  mount,
} from "effect-frame/router";

Route.leaf(tabs, TabsView, { behavior: NavigationBehavior.Preserve }); // per leaf
Route.client("flat", { path, params, search, view, behavior: NavigationBehavior.Preserve });
mount({ routes, notFound, host, root, behavior: NavigationBehavior.Restore }); // default: Restore
mount({ routes, notFound, host, root, traversalReadLimit: "3 seconds" }); // default: 3 seconds

const location = browserNavigation; // Effect<Location, never, Scope>: Navigation API, History fallback
```

- `NavigationBehavior` is a namespace with the type and two values,
  `Restore` and `Preserve`. It is a value, not a flag.
- `Route.layout` takes no `behavior`: its options type has no such field.
  A destination leaf decides for its navigation.
- `browserNavigation` is the browser `Location` for #31 and for leave checks
  on Back and Forward. It is `browserLocation` where the Navigation API is
  absent. `browserLocation` stays public: the History API `Location`, which
  now also scrolls and focuses at landing.

## Shell commit

A mounted tree reports a `Shell` for each commit (a private WeakMap on the
`Entered` value, as `traversal.ts` does for traversals):

- `entered`: the deepest instance changed in this commit. False when the
  leaf stayed (a search or param change on the same leaf).
- `behavior`: the destination leaf's own value, or none.
- `root`: the leaf's root host node, once it is in the document.
- `drawn`: completes when every instance down the branch built its view, or
  a pending fallback stands for the rest. Queries are not waited on: a
  `Loading` fallback is part of the shell.

An outlet row builds its nodes on its own fiber. So the router waits for
`drawn`, yields once, and flushes with `render` before it lands. The
landing runs on a fiber forked in the router's scope. The request queue
does not wait for it. Only the latest navigation lands. Each request records
how many requests that move were admitted up to and including itself. A
landing places only if that count has not changed when it is about to
place, with no yield between the check and the placement. So a newer
request supersedes it whether that request is still queued, already done,
or was admitted after the older shell drew (review round 1, finding 3). A
newer admission also ends the wait for `drawn` at once.

## Decisions and deviations

1. **`scroll: "manual"` and `focusReset: "manual"` on every intercept.** The
   ticket put `Preserve` on `manual` and `Restore` on the defaults. Both
   options are fixed when `intercept` is called, at dispatch, before the
   router has matched the destination. It does not know the leaf's behavior
   or whether the leaf stays. So the router always takes both, and at
   landing it calls `event.scroll()` and focuses by itself. Same position,
   same moment, one code path.
2. **No `autofocus` on the leaf root.** The ticket put `tabindex="-1"` and
   `autofocus` on the root, and left the move to `focusReset`. Two faults
   follow from that. A browser acts on `autofocus` at document load, so a
   server-rendered or hydrated page would steal focus on first paint. And
   `focusReset` would move focus on a stayed transition too, to the first
   `autofocus` in the document, which takes the caret out of a stayed
   search field. The build marks the leaf root with `tabindex="-1"`, and at
   landing focuses the first `[autofocus]` inside the leaf, else the root,
   with `preventScroll: true`. The author's `<h1 autofocus>` still wins, by
   one attribute, as the ticket says. The mark is skipped when the root is
   focusable already, and only then:
   - The view wrote a tab index in either spelling (`tabindex` or
     `tabIndex`), with any value.
   - It is an editing host: `contenteditable` is `""`, `"true"`,
     `"plaintext-only"` (any case), or `true`. `"false"`, `false`,
     `"inherit"`, and any other value get `-1`.
   - It is `button`, `input`, `select`, `textarea`, `iframe`, `embed`, or
     `summary`.
   - It is `a` or `area` with an `href` that is written and not `false`, or
     `audio` or `video` with `controls` written and not `false`.
     A value bound to a source is only known once drawn; it counts as
     focusable, so a control the author may enable keeps its Tab order. A
     native control keeps its place in the Tab order, and an authored tab
     index is written once, so the server, a hydration, and a fresh render
     agree (review round 1, finding 4; round 2, finding 4). A disabled
     control still counts as focusable: `disabled` is not read, so a
     disabled `button` root gets no `-1` and the router cannot focus it.
3. **Focus moves only when the deepest instance entered.** A stayed leaf
   keeps focus and the caret. A layout never claims focus. A leaf whose view
   returns no element, a leaf still pending (its fallback is showing), and a
   failed navigation give no focus target.
4. **The router's own push and replace are intercepted, one write at a
   time.** The router writes history with `pushState`/`replaceState`
   through its Location's private surface. With the Navigation API that
   fires a `navigate` event synchronously. Each write opens its own frame
   (its kind, its URL, and what it claimed). The listener claims an event
   for the frame only when the event has the frame's kind and destination
   URL, and the frame has claimed nothing yet. It hands the event back to
   that write as a private `Written` handle. The router lands each move
   through its own handle, so one write's landing can never place on, or
   release, another write's event (finding 2). A write the platform aborted
   (a newer navigation) is released and places nothing.

   Reentry (round 2, finding 2): another `navigate` listener may push or
   replace synchronously while the router's write dispatches. That nested
   event has another URL, or comes after the frame claimed its own, so it
   is not intercepted: the platform keeps it. Both listener orders are
   decided:
   - Ours runs first: the frame claims its event. The nested write aborts
     it, so it is released and the router's landing places nothing.
   - Another listener runs first: the nested event reaches ours first and
     is not claimed. The router's own event reaches ours already aborted,
     and the frame records it as lost. If it never reaches ours, the frame
     records nothing. Either way the write's handle places nothing.
     A nested write to the same URL and kind as the router's, from a listener
     that runs before ours, cannot be told apart from the router's own: the
     frame claims it. That landing puts the same URL's default position, and
     it releases that event. This is accepted. The public `push` and `replace` of the Location are not
     intercepted: nothing would land them. An app's own `pushState` and a
     fragment link are left alone. A redirect replace (on the first load,
     after a pop, or after a traversal) places nothing itself: the move it
     serves lands. Its handle is released as soon as the view is shown or has
     failed, so no `navigation.transition` is left open (finding 1).

5. **`followLinks` leaves a fragment-only link to the browser.** A link that
   only changes the fragment of the current document is not followed:
   no transition runs, the browser scrolls, and `:target` holds. A link that
   changes the path and has a fragment is followed, and the landing scrolls
   to the fragment.
6. **Restore scrolls a stayed push to the top too.** The ticket: a tab strip
   "without `Preserve` would still scroll to top". `Preserve` is the opt-out.
7. **Without the Navigation API**, a push or replace scrolls to the
   fragment's indicated part, or to the top, then focuses. The indicated
   part follows the HTML steps: an element whose `id` is the raw fragment,
   or an `<a name>` with it; then the same for the percent-decoded fragment
   (UTF-8, no BOM, a decode failure skips it); then `top` in any case as
   the top of the document. With none of them, the push scrolls to the top,
   as the Navigation API's own push does (finding 5). A followed `popstate`
   only focuses: the browser already restored the entry's position.
8. **WebKit and a canceled traversal.** WebKit with the Navigation API and
   no precommit handler keeps the document but moves its back-forward list
   on a canceled traversal. The adapter cancels a traversal only on an
   engine with precommit handlers. See `route-leave.md`, "WebKit and a
   canceled traversal".

9. **A traversal restores the saved position under `Preserve` too.** EGW
   search found it: on a phone, scroll to 430, push a new search, scroll
   to 0, Back. `browserLocation` put the page at 430 and
   `browserNavigation` left it at 0. The History API has no hold on a pop:
   the browser restores the entry's position when it fires `popstate`. The
   Navigation API intercept takes `scroll: "manual"` (decision 1), and
   `Preserve` did not call `event.scroll()`, so nothing restored it.
   `Preserve` is for workspace state: a push or replace on the same page
   must not jump the reader to the top. A Back or Forward returns to an
   entry, and the entry's position is part of it; the platform restores
   it with no router. So a traversal the router held calls
   `event.scroll()` under either behavior (`placeTraversal`), and both
   Locations put the same landing at the same place. Focus under
   `Preserve` stays where it is on a traversal too.

   The parity holds while the intercepted event is still committed and
   can scroll. `event.scroll()` throws once the navigation finished or was
   aborted (a newer navigation); the landing then places nothing and has
   no other way to restore the position.

10. **A traversal lands once its declared reads are drawn.** Notes found
    it: Back from `/lists/errands` to `/lists/inbox` read the inbox's
    notes again (the key was released on exit), and the router called
    `event.scroll()` at shell commit, 5 ms before the 80 notes were drawn,
    against a 513 px page. Chrome sometimes scrolled again when the notes
    arrived and sometimes did not (1 run in 3 failed); WebKit never did.
    The saved position is a place in the page's content, so a traversal
    now waits for two more things after `drawn`: `Shell.settled` (every
    query the drawn branch declared left `Loading`, `Ready` or `Failed`;
    an actor binding holds its snapshot when it binds), and a catch-up
    that brings every bound source of the router's mount to its current
    value and flushes. A value travels from a source to the drawing on a
    fiber, so without the catch-up the settled read is not drawn yet. The
    router wraps its host's `sourceBound` to hear each binding, and still
    forwards to a host that counts its own. A push or replace still lands
    at shell commit (#31: the top while the counts are held). The
    Navigation API holds the traversal's handler until it lands, as a
    platform traversal with `scroll: "after-transition"` does. A read a
    view makes itself, not declared, is not waited on. A History API pop
    is unchanged: the browser restored its position at `popstate`.
11. **A traversal waits for its declared reads for a bounded time.**
    Decision 10 had no limit: a traversal whose declared read hangs held
    the Navigation API's handler for ever and never placed the scroll. A
    traversal now lands when its declared reads settle or when
    `mount`'s `traversalReadLimit` expires after shell commit, whichever
    is first (a `Duration.Input`, default 3 seconds). At the limit it
    brings the drawing to its sources and lands on the page as it is: the
    scroll may clamp against a page still waiting for its content. It never
    places again when the reads settle later. A late jump after the reader
    has been looking at the page is worse than a clamped placement. A newer
    navigation still supersedes the landing, before or after the limit, as
    before. The option is named for what it bounds: the reads a traversal
    waits for, not the navigation.

## Server

`navigation.ts` and `browser-commit.ts` are browser-only. Their top-level
values carry `/* @__PURE__ */` annotations, so a server bundle that imports
`effect-frame/router` drops them. A server render of a branch still marks
the leaf root with `tabindex="-1"` (under the same rules as the client):
the attribute is harmless and keeps hydration in agreement.

## Evidence

Browser proofs run in real Chrome and WebKit through `Bun.WebView`
(`packages/effect-frame/tests/router/navigation-browser.test.ts`, fixture
`tests/router/browser/navigation-app.tsx`). The fixture mounts the public
`browserNavigation` and `followLinks`. Each test runs once per engine.

| Test                                                                                                       | What it shows                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "a push scrolls to the top when the shell commits, while the query is still open"                          | `scrollY` is 0 while the `Loading` fallback shows and the fake query never settles.                                                                                                                                                                                                               |
| "a push to a URL with a fragment scrolls to the fragment, not to the top"                                  | `#usage` is in the viewport and `scrollY` is not 0.                                                                                                                                                                                                                                               |
| "Back restores the browser's saved position"                                                               | Scroll to 2500, push (page 2 at the top), Back: 2500 again.                                                                                                                                                                                                                                       |
| "Back waits for the declared read the page's height needs, then restores its position"                     | Rows page at 2500, push, hold `Rows`, Back: the fallback shows; release: 2500. Killed by landing at `drawn`, and by no catch-up.                                                                                                                                                                  |
| "Back whose declared read never settles lands at the limit, releases the traversal, and never moves later" | `traversalReadLimit` 400 ms. Rows page at 2500, push, hold `Rows`, Back: the fallback shows and `navigation.transition` is open; at the limit it is `null` and `scrollY` is below 2500 with the fallback still shown; release `Rows`: the content grows and `scrollY` is unchanged (decision 11). |
| "history.scrollRestoration stays auto after mount and after ten navigations"                               | `"auto"` throughout.                                                                                                                                                                                                                                                                              |
| "a late settle fills content in place and does not move the viewport"                                      | A below-the-fold `Loading` settles; `scrollY` is unchanged.                                                                                                                                                                                                                                       |
| "a fragment-only click is left to the browser: no transition, the browser scrolls"                         | `navigate` saw one `push:true`; no view ran again; the page scrolled; `:target` holds.                                                                                                                                                                                                            |
| "focus moves to the entering leaf's root on a push"                                                        | `activeElement` is the leaf root; it has `tabindex="-1"`.                                                                                                                                                                                                                                         |
| "a leaf's own autofocus element wins over the leaf root"                                                   | Focus lands on the `<h1 autofocus>`.                                                                                                                                                                                                                                                              |
| "a stayed segment keeps focus and the caret across a search or param change"                               | The layout's search field keeps focus and selection over `?q=a` to `?q=b` and a param change.                                                                                                                                                                                                     |
| "a form's failed validation keeps focus in the field"                                                      | No `navigate` event; `activeElement` is the field.                                                                                                                                                                                                                                                |
| "the router adds no aria-live region"                                                                      | No `[aria-live]` after navigations.                                                                                                                                                                                                                                                               |
| "Preserve leaves scroll and focus alone, entering and stayed"                                              | Entering and stayed `Preserve` navigations keep `scrollY` and `activeElement`.                                                                                                                                                                                                                    |
| "Back and Forward to a Preserve entry restore its saved position" (with and without the API)               | Stayed: 430, push, 0, Back gives 430, Forward gives 0. Entering: Back from a `Restore` page gives 1500. Focus stays.                                                                                                                                                                              |
| "an initial redirect's replace finishes once the page is shown"                                            | A first load of `/site/old` redirects; `navigation.transition` becomes `null` (finding 1).                                                                                                                                                                                                        |
| "each write lands only on its own event: a newer push is not released early"                               | Two pushes admitted at once; the held second push keeps its transition open until its own shell draws.                                                                                                                                                                                            |
| "a fragment push finds the raw id, then the decoded id, then a named anchor" (no API)                      | `#part%20one` finds `id="part%20one"`, `#part%20two` finds `id="part two"`, `#legacy` an `<a name>`.                                                                                                                                                                                              |
| "a push scrolls to the top and focuses the leaf root with preventScroll" (no API)                          | `navigation` deleted: top, then the fragment; one `focus` call with `preventScroll: true`.                                                                                                                                                                                                        |

Non-browser proofs (`packages/effect-frame/tests/router/navigation-behavior.test.tsx`):

| Test                                                                       | What it shows                                                                                              |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| type assertions at the top of the file                                     | `@ts-expect-error` on a layout `behavior`, a boolean leaf `behavior`, a flat-route flag, a string default. |
| "no router module reads or writes a scroll position or a storage"          | No `src/router` file names a scroll offset, a storage, or `scrollRestoration`, outside comments.           |
| "a server render of a branch installs no navigation listener"              | A recording `navigation` global sees no `addEventListener`; the HTML is the branch with `tabindex="-1"`.   |
| "a server bundle of a routed tree excludes the browser navigation modules" | `Bun.build` of `tests/router/fixtures/server-entry.tsx` has none of the browser module markers.            |

Round 1 proofs outside that file:

| Test                                                                                                                                                        | What it shows                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/router/browser-commit.test.ts` — "each own write lands on its own event, once, and never on a newer one"                                             | With a fake `navigation`: the first write's landing leaves the second alone; the second scrolls once (finding 2).                                                                                                             |
| `tests/router/navigation-landing.test.tsx` — "a newer request admitted before a landing places supersedes that landing"                                     | A recording surface logs `land /site/first none`, then `land /site/second placed` (finding 3).                                                                                                                                |
| `tests/router/leaf-root.test.tsx` — the three "leaf root" tests                                                                                             | `tabIndex={0}` stays one `0`, a `<button>` root gets no `tabindex`, a plain root gets `-1`: server, hydration, and fresh render (finding 4).                                                                                  |
| `tests/router/navigation-behavior.test.tsx` — `restoreExact` and `preserveExact`                                                                            | `NavigationBehavior.Restore` has the type `Restore`, and `Preserve` has `Preserve` (finding 6).                                                                                                                               |
| `tests/router/browser-commit.test.ts` — "a nested push from another listener is never the router's (ours first)" and "(another listener first)"             | A listener pushes `/nested` inside the router's push: `/nested` is not intercepted or placed, `/outer` places nothing, and no intercepted event is left waiting (round 2, finding 2).                                         |
| `tests/router/leaf-root.test.tsx` — "…: an attribute that does not make it focusable still gets -1" (5 cases) and "an editing host keeps its own Tab order" | `contenteditable="false"`, `contentEditable={false}`, `"inherit"`, `controls={false}`, and an `<a>` with no `href` get `-1`, and `contenteditable="true"` does not: server, hydration, and fresh render (round 2, finding 4). |

### Mutation checks

Each mutation was applied alone and the named tests ran against it.

| Mutation                                                    | Failed                                                                       |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `querySelector("[autofocus]")` finds nothing                | "a leaf's own autofocus element wins …" (both engines)                       |
| `event.scroll()` removed                                    | top, fragment, and Back tests (both engines, 6 of 8)                         |
| `fragmentOnly` always false                                 | "a fragment-only click is left to the browser …" (both engines)              |
| focus on a stayed transition too                            | "a stayed segment keeps focus and the caret …" (both engines)                |
| `Preserve` treated as `Restore`                             | "Preserve leaves scroll and focus alone …" (both engines)                    |
| leaf root without `tabindex`                                | "focus moves to the entering leaf's root on a push" (both engines)           |
| `cancelSafe = true` (the old `cancel` path in WebKit)       | both WebKit Back proofs in `route-leave-browser.test.ts`                     |
| `history.scrollRestoration = "manual"` in `navigation.ts`   | "no router module reads or writes a scroll position or a storage"            |
| the initial redirect's handle is not released               | "an initial redirect's replace finishes …" (both engines)                    |
| one write's landing places on and releases the newest write | "each own write lands on its own event …"                                    |
| the admission count is read when the landing starts         | "a newer request admitted before a landing places …"                         |
| `tabIndex` not read as a tab index                          | "an authored tabIndex is kept …"                                             |
| `button` not treated as focusable                           | "a natively focusable root keeps its place in the Tab order"                 |
| the raw fragment not looked up                              | "a fragment push finds the raw id …" (both engines)                          |
| `<a name>` not looked up                                    | "a fragment push finds the raw id …" (both engines)                          |
| a frame claims any event of its kind (the shared slot)      | "a nested push … (ours first)" and "(another listener first)"                |
| a frame does not match the destination URL                  | "a nested push … (another listener first)"                                   |
| an event that arrives aborted is still claimed              | "a nested push … (another listener first)"                                   |
| any `contenteditable` value counts as focusable             | the three `editable-*` cases of "… still gets -1"                            |
| any `controls` value counts as focusable                    | "/site/controls-off: … still gets -1"                                        |
| `""` and `"true"` not read as editing hosts                 | "an editing host keeps its own Tab order"                                    |
| a traversal calls `event.scroll()` only under `Restore`     | "Back and Forward to a Preserve entry …" (both engines, with the API)        |
| a traversal focuses under `Preserve` too                    | "Back and Forward to a Preserve entry …" (both engines, with the API)        |
| a traversal waits for its declared reads with no limit      | "Back whose declared read never settles lands at the limit …" (both engines) |

The browser test "each write lands only on its own event …" also passes on
the code before round 1. There the fault needs the older landing to start
after the newer write, and the browser test cannot force that order. The
fake `navigation` test above proves finding 2.

## Limits

- The late-settle proof here uses a client `Loading` settle, the same
  `Show` swap in place. The streamed `Patch` is proven by its own fixture,
  `packages/effect-frame/tests/view/streaming-browser.test.ts` — "a late
  patch fills content in place and does not move the viewport", in Chrome
  and WebKit.
- `renderToStream` is not in this tree either. The server proof uses the
  server host render and a server bundle. The same test should render
  through `renderToStream` once #22 lands.
- A traversal waits only for declared reads (decision 10). A saved
  position below content that a view reads itself, or below a `pending`
  fallback, still lands clamped: the browser does not scroll again when
  that content arrives.
- Without the Navigation API, Back restores early, at `popstate`, before
  the branch re-resolves. This is the ticket's accepted cost.
- The WebKit suite needs `Bun.WebView` WebKit, which is macOS only. On Linux
  CI the WebKit rows are skipped.
- Firefox and a headed Safari were not run.
- Safe cancellation is inferred once from the global
  `NavigationPrecommitController` name. A future WebKit that has the name
  but rejects a precommit intercept would fall through to
  `preventDefault()`, and could repeat the back-forward fault in
  `route-leave.md`. A capability proved on each event before the cancel
  fallback would close this (review round 1, finding 7, not built).
