# Notes: one page in every rendering mode (#37)

Notes is the example that runs one list page in every rendering mode. It
builds the Notes section of #25 §1. Each acceptance row there is now a test
in `bun run gate`. The rows are in `acceptance.md`, under "Notes — every
rendering mode of one page". This document gives the tests, the mutation that
turns each one red, the decisions the build made, and what stays Open.

## The shape

| Route                | Mode (constructor) | Shell       | Data                                            |
| -------------------- | ------------------ | ----------- | ----------------------------------------------- |
| `/`                  | redirect           | none        | none; `before` sends the reader to `/lists`     |
| `/lists?q=`          | SSR (`Route.ssr`)  | `Shell`     | `ListIndex({})` on `lists`, `ListIndex(search)` |
| `/lists/:list`       | `Route.streamed`   | `Shell`     | `ListCounts({list, filter})`, `ListNotes`       |
| `/lists/:list/print` | `Route.awaitAll`   | `Shell`     | the same data as the list page                  |
| `/scratch`           | `Route.client`     | `BareShell` | none                                            |

The segments (`src/segments.ts`) are shared. Each page is its own tree in
`src/routes.tsx`, and its constructor is the only place that names a mode.
`ListView` in `src/page.tsx` is the leaf of both the list page and the
print page. `src/views.tsx` holds the shells, the index, the scratch page and
the fallbacks.

## Rows, tests and mutations

Each mutation was applied alone. The named test file was run from
`apps/notes` with `bun test --conditions=source`, and then the change was
reverted. The runner restores every file after each mutation.

| Row                                             | Test (file: name)                                                                                                          | Mutation                                                                                        | Result                                                                      |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| One tree, every mode, no mode branch in a view  | `modes.test.tsx`: "no view module names a rendering mode"                                                                  | A comment naming `Route.streamed` in `page.tsx`                                                 | Killed                                                                      |
| (same row)                                      | `modes.test.tsx`: "the app's trees name their modes by constructor"                                                        | `List` built with `Route.ssr` instead of `Route.streamed`                                       | Killed                                                                      |
| A route prints what it parses                   | `routes.test.tsx`: "the router parses {list, print}'s href back to the same values, or href refuses"; the home/domain test | `codec.ts` prints path segments with `encodeURI` instead of `encodeURIComponent`                | Killed (3 tests)                                                            |
| A search change is `stayed`, one key refetched  | `routes.test.tsx`: "re-derives ListCounts only: …, and ListNotes is not read again"                                        | `ListNotes` args take the filter, and the list data passes it (two files)                       | Killed, after the test counted `ListNotes` reads under any args             |
| (same row)                                      | (same test)                                                                                                                | The list data passes the filter to `ListNotes`, but its args schema has no `filter`             | Survived: equivalent. The args schema drops the key, so the key is the same |
| A regexp group is refused at definition         | `routes.test.tsx`: "a regexp group throws at definition"                                                                   | `codec.ts` skips the `(` check                                                                  | Killed                                                                      |
| A bare `*` is refused at definition             | `routes.test.tsx`: "a bare * throws at definition"                                                                         | `codec.ts` skips the bare `*` check                                                             | Killed                                                                      |
| The shell arrives before a held query           | `streaming.test.tsx`: "the shell and its skeleton arrive while ListCounts is still held"                                   | `List` built with `Route.awaitAll`                                                              | Killed (3 tests)                                                            |
| A `Patch` ahead of hydration is `resolvedAhead` | `streaming.test.tsx`: "a stream that settled before hydration is reported as resolvedAhead"                                | `List` built with `Route.ssr`                                                                   | Killed (3 tests)                                                            |
| `AwaitAll` writes no record channel             | `streaming.test.tsx`: "the AwaitAll print page writes no record channel and hydrates clean"                                | `Print` built with `Route.streamed`                                                             | Killed                                                                      |
| A cut stream fails `StreamEnded`, then `/query` | `streaming.test.tsx`: "a stream cut before Closed fails ListCounts StreamEnded, then /query settles it"                    | `query-client.ts` `end` leaves open seeds open instead of failing them                          | Killed                                                                      |
| One add refreshes both dependents               | `query.test.tsx`: "an Add from /lists/inbox refreshes both dependent queries in its reply"                                 | `ListCounts` without `depends: [Notes]`                                                         | Killed                                                                      |
| The same add from `/scratch` refreshes nothing  | `query.test.tsx`: "the same Add from /scratch refreshes nothing, and declares nothing"                                     | `scratch` declares `ListIndex({})`                                                              | Killed (2 tests)                                                            |
| An exited segment releases, a shared key stays  | `query.test.tsx`: "leaving /lists/inbox for /scratch releases …", "leaving /lists/inbox for /lists keeps …"                | `ListIndex({})` declared by no segment (the `lists` data removed)                               | Killed (3 tests)                                                            |
| One fallback: `Errored` outside `Loading`       | `readiness.test.tsx`: "a failing ListCounts shows one fallback: Errored outside Loading (the app's shell)"                 | `Shell` swaps the two fallbacks                                                                 | Killed (2 tests)                                                            |
| One fallback: `Loading` outside `Errored`       | `readiness.test.tsx`: "… : Loading outside Errored"                                                                        | `readiness.tsx`: a `Failed` query does not settle its `Loading`                                 | Killed                                                                      |
| A refetch never draws the fallback twice        | `readiness.test.tsx`: "a refetch holds the counts it has, and never draws the skeleton again"                              | `readiness.tsx`: a stale `Ready` does not settle its `Loading`                                  | Killed                                                                      |
| (same row)                                      | (same test)                                                                                                                | `query.ts` `markStale` gives `Loading`; separately, `query-client.ts` `display` gives `Loading` | Survived both: see the note below                                           |
| `send` reads `Sent`; the add is on screen       | `command.test.tsx`: "a held add reads Sent, and its row is on screen before the reply"                                     | `ListBody` opens its reference with no `behavior`                                               | Killed (2 tests)                                                            |
| A rejection rolls the predicted row back        | `command.test.tsx`: "a rejected add rolls its predicted row back, and the list is as it was"                               | `provisional.ts` keeps every overlay when a command is released                                 | Killed                                                                      |
| Dependents stay stale until the last add (HTTP) | `command.test.tsx`: "over HTTP, the counts stay stale from the first send until the last add settles"                      | `query-client.ts` `display` never marks a pending entry stale                                   | Killed                                                                      |
| (same row)                                      | (same test)                                                                                                                | `query.ts` `markStale` returns the state unchanged                                              | Survived: this path is the refresh read, not command ownership              |
| A push lands at the top at shell commit         | `navigation.test.ts`: "a push lands at the top at shell commit even when the page is still tall" (WebKit, Chrome)          | `navigation.ts` `placeIntercepted` does not call `event.scroll()`                               | Killed (3 tests), after the tall-page test was added                        |
| Back restores the position                      | `navigation.test.ts`: "a push scrolls to the top at shell commit; Back restores the list's position in Chrome"             | `navigation.ts` `placeTraversal` does not call `event.scroll()`                                 | Killed (Chrome)                                                             |
| A `stayed` keeps focus and the caret            | `navigation.test.ts`: "a search typed into /lists is a stayed transition that keeps focus and the caret"                   | `branch.ts` `prepareSlot` never stays: every slot enters again                                  | Killed (3 tests, both engines)                                              |
| A browser entry reaching a server module fails  | `boundary.test.ts`: "an import of queries.server.js in page.tsx is refused with its path chain"                            | `tooling/checks/src/boundary.ts` matches `.srv.` instead of `.server.`                          | Killed                                                                      |

Notes on the survivors:

- The first `push` mutation (no `event.scroll()`) survived the first
  navigation test. The errands page is short while its counts are held, so
  the browser clamps the scroll to 0 by itself. The new tall-page test keeps
  the page taller than the viewport, and it kills that mutation in both
  engines.
- The first filter mutation survived because it is equivalent: the
  `ListNotes` args schema drops the `filter` key, so the key does not
  change. The two-file mutation moves the key, and the test now counts
  `ListNotes` reads under any args, so it is killed.
- `markStale` in `query.ts` is the slot's own refresh read. In Notes, an add
  refreshes its dependents inside the reply (#28), so that read does not
  happen, and those mutations cannot show on this page. The `display` mutation
  to `Loading` also survives the readiness test: no skeleton is drawn again.
  This build did not trace which path keeps the route's `Loading` settled
  there. The HTTP command test kills both `display` mutations, and the
  `hasSettled` mutation above kills the readiness row.

The two framework fixes this ticket made carry their own mutations:
`route-data.md` decision 15 (the outlet) and the "Who predicts" section of
`optimistic.md` (the minted ID, M1 to M5, all killed).

## Decisions

1. **One tree per page, one set of segments.** `Route.ssr`, `streamed`,
   `awaitAll` and `client` each wrap their own tree over the shared segments.
   A mode is a constructor, so `modes.test.tsx` builds four trees around one
   `ListView` and requires an empty hydration report for each.
2. **The shell's key is `ListIndex({})`.** The `lists` segment declares it for
   every page under `/lists`. The index with no `q` reads the same key, so a
   move from a list to `/lists` keeps it, unread (#28).
3. **`ListNotes` is resume route data.** This is a deviation from #25 §1,
   which says "Two queries and no more." The #22 design leaves actor resume
   payloads to the caller, and a route actor is not seeded. So the list page
   declares `ListNotes`, and its body opens the `Notes` reference from it.
   The first frame then holds the notes on the server and on the client, and
   the reference reads nothing more. `ListNotes` has no `depends`, so the #28
   claim that one add refreshes two keys stays exact.
4. **The view owns the `Notes` reference.** `Route.actor` cannot carry a
   behavior, and the page needs one to predict. The list body opens the
   reference with `ref(Notes, key, {resume, behavior: notesBehavior})`. The
   body is keyed by the list's name: a new list opens a new body, and a filter
   change keeps it.
5. **The reducer is in `src/behavior.ts`.** The server hosts it and the
   client predicts with it. It is browser safe, so `notes.server.ts` imports
   it and not the reverse.
6. **`reject-me` is refused on the wire.** #25 §1 says the behavior refuses
   it. A reducer cannot refuse: in #19 a rejection comes only from the
   framework (policy, admission, the transport). So the test wiretap refuses
   the text with `Unauthorized` before the host sees it. That is a gap in
   #19, not in Notes: an app cannot yet reject a command from its own rules.
7. **`returnTo` is the page's pathname.** The compose form reads it from the
   router's current location, so a plain post from `/lists/errands` or
   `/lists/errands/print` returns to that page.
8. **`/scratch` uses `BareShell`.** A `Loading` with nothing registered
   waits for ever (#16). The scratch page reads nothing, so its shell has no
   `Loading`.
9. **The client marks the document hydrated.** `client.tsx` sets
   `data-hydrated="true"` on `<html>` when hydration finishes. The browser
   tests wait on it.
10. **The plain-form and e2e tests use the print page.** A no-script post
    needs a whole document; the print page is `AwaitAll`, so the test reads
    one complete body.
11. **A settled outlet draws on the first frame.** A layout that puts its
    outlet inside `Loading` drew the fallback on the server and the leaf only
    on the client. The framework fix is `11978e2` (`route-data.md` decision
    15; changeset `outlet-first-frame`, patch).
12. **A framework-minted ID predicts at once.** A form the client drew
    minted its ID but sent it as a supplied one, so its send waited for
    receipt evidence. The fix is `2c048bc`. It implements #67 §3 ("Let the
    framework mint fresh IDs for immediate prediction. Supplied or recovered
    IDs wait for real receipt evidence.") and does not change it. Changeset
    `fresh-id-ownership`, patch, not breaking.
13. **The Notes leak test is in the app.** `tooling/checks` exports
    `./boundary`, and `apps/notes/tests/boundary.test.ts` checks the real
    browser entry. The tooling test keeps its own synthetic cases.
14. **`settle` fails loudly.** The app fixture's `settle` dies with
    "settle: … never held" when its check never holds, so a wait cannot pass
    by timing out quietly.

## Open

- **A `Loading` around an outlet whose child reads nothing never settles.**
  It sits next to #16 and #55. This ticket does not decide it; `BareShell`
  (decision 8) keeps Notes clear of it.
- **WebKit Back lands clamped.** The list's notes are read again after the
  shell commits, so WebKit places the saved position on a short page and
  lands at 0. This is the #31 accepted limit ("A traversal to a saved
  position that the shell cannot reach yet lands clamped"). The navigation
  test pins it: a fix turns the WebKit case red.
- **`currentAt` ignores the link's params.** Every list link in `#names`
  gets `aria-current="page"` on a list page. `route-public.md` says "page
  stays reserved for the one link that is the current page". This is a
  framework defect outside this ticket; it is reported, not fixed.
- **`NOTES_UPSTREAM` placement.** The swap to a celld host is still untested
  (`acceptance.md`, Open rows).
