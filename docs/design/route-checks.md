# Route checks and errors (private proof)

This note records route execution slice 3: typed route targets, `before`
checks, redirect traversal, navigation receipts, and typed route failures.
All of it is private. `src/router/check.ts`, `src/router/receipt.ts`, and
`src/router/branch.ts` are not exported from `effect-frame/router`, and no
`package.json` export changed. There is no Changeset. Issues #36, #55, and
#56 stay open. Leave checks are slice 5, not this slice.

Source: `packages/effect-frame/src/router/check.ts`,
`packages/effect-frame/src/router/receipt.ts`,
`packages/effect-frame/src/router/branch.ts`, and the private hooks in
`packages/effect-frame/src/router/router.ts`.
Proofs: `packages/effect-frame/tests/router/route-checks.test.tsx`.

Public surface: the package was built on `main` (702e4ad) and on this branch,
and every `dist/router/*.d.ts` was compared. `router.d.ts`, `route.d.ts`,
`link.d.ts`, `path.d.ts`, `url-state.d.ts`, `url-state-runtime.d.ts`, and
`route-inspection.d.ts` are byte-identical. `index.d.ts` has the same lines;
only the order of two import lines differs (the bundler emits a new chunk
order). `branch.d.ts` differs and `check.d.ts` and `receipt.d.ts` are new, but
`index.d.ts` does not re-export them.

## Shape

```ts
const tenant = Branch.segment("tenant", {
  path: "/app/:tenant",
  params: TenantParams,
  data: ({ params }) => ({ tenant: Branch.query(TenantInfo, params) }),
  // Services stay in R. The input is the candidate's decoded values.
  before: ({ params, url }) =>
    Effect.map(NavigationAccess.forTenant(params.tenant), (access) => {
      if (access._tag === "SignIn") {
        return Check.redirect(Check.target(LoginRoute, {}, { next: url.pathname }));
      }
      return Check.Continue;
    }),
});
const post = Branch.child(tenant, "post", { path: "posts/:postId", params: PostParams });

const tree = Branch.layout(tenant, [
  Branch.leaf(post, PostView, { errored: (failure) => <PostProblem failure={failure} /> }),
], LayoutView);
```

- `Check.target(to, params, search)` takes anything with a typed `href`: a
  flat `Route.client` route or a `Branch` segment. `NoInfer` keeps the
  destination in charge, so a wrong param or search field does not compile.
  A segment prints every ancestor's path from its own encoded params record,
  plus its own search.
- `before: (input: BeforeInput<P, S>) => Effect<Continue | Redirect, never, R>`.
  `BeforeInput` has `params`, `search`, `url`, and `kind`
  (`"initial" | "push" | "replace" | "pop"`). They are values, not Sources: one
  candidate transition. `R` becomes part of the branch's `DataR`, so it is part
  of the route's requirements.
- A leaf or layout view may fail with a typed `E`. It then must pass
  `{ errored: (failure: Source<RouteFailure<E>>) => Node }`. A view with
  `E = never` may omit it.
- `RouteFailure<E> = Setup { error: E } | Declaration { error: Exclude<TransportReadError, Unauthorized> }`.

`before` lives on the segment, beside `data`, because it is route metadata
that must be available before any view (and, in slice 4, before any lazy
import). `errored` lives on the leaf or layout, because it handles that view's
`E`.

## Contract

### Checks

1. The router settles a candidate URL before history moves. It resolves the
   route for the URL. If the route has checks (a private registry keyed by the
   route value, like the inspection projection), it runs them in the mount
   context, with `Router` provided and a temporary `Scope` that closes before
   the answer is used.
2. A tree's checks run parent first, for every matched segment: entering and
   stayed segments alike. A segment is asked only after its parent answered
   `Continue`. A `Redirect` stops the walk. No child check, declaration,
   import, or setup of the refused branch starts, because all of those happen
   in `enter`/`update`, after settling.
3. A `Redirect` is matched again from the top. It can leave the route that
   asked. Traversal is bounded. A URL that the chain has already visited is a
   `RedirectCycle { reason: "repeated" }` defect. A chain longer than
   `redirectLimit` (16) hops is `RedirectCycle { reason: "limit" }`. Both are
   defects of that navigation at the router boundary. Nothing is committed;
   the router keeps serving later navigations.
4. History moves once, to the settled URL. A push pushes once. A replace
   replaces once. An initial redirect replaces the entry the document already
   holds. A redirected pop replaces the popped entry. A settled URL equal to
   the current URL is `Unchanged`, with no history operation.
5. Checks do not run for a same-URL request (already a no-op) or a
   fragment-only move (same origin, path, and search as the committed URL).

### Receipts

`Receipt.of(router)` gives `navigate` and `replace` that return
`NavigationResult = Committed | Unchanged | Stayed`, each with a URL. The public
`navigate`/`replace` are the same queued path with the result dropped; there
is one command path. `Committed` carries the settled URL. `Unchanged` covers a
same-URL request, a redirect to the current URL, and a stale route instance's
request. `Stayed` is reserved for slice 5; nothing produces it yet. A request
that the router's close ends is interrupted; it never reports a result.

### Typed setup recovery

1. A view's setup runs in the private `attempt` owned by the instance's view
   Scope. A typed failure closes the failed setup child (its finalizers
   included) before the fallback starts. Defects and interruption propagate.
2. The fallback takes the tree lock, marks the instance failed, closes and
   releases its current child, and releases its own declaration interests.
   Then it builds `errored` with `Setup { error }`.
3. An own declaration acquisition failure (enter or stayed move) that is not
   `Unauthorized`, on a segment with a handler, becomes a failed instance that
   shows `errored` with `Declaration { error }`. Its sibling acquisitions and
   its descendants' preparations are aborted. On a stayed segment, the failed
   instance replaces the old one: the old view closes, then its interests are
   released. A descendant's failure is not the parent's to handle.
4. A failed instance is never stayed. The next navigation that matches it
   enters it again. A failed root makes `update` answer false; the router then
   enters the whole tree again before it closes the old one (a new internal
   use of the existing `update` boolean, which the router now honors).
5. A failed segment has settled. Its errored node registers one settled read
   with the nearest `Loading`, so the Loading presents it instead of its
   fallback.
6. Query failures after setup, event failures, and child fibers are not route
   failures. `View.event` handlers cannot carry a typed `E` (type fixture).

## Evidence

All proofs use a real `QueryTest` host, the real actor transport, `ViewTest`,
`TestClock`, and one `Frame` over one root. Waits are `Deferred` receipts (held
decisions, held queries, view finalizers) and `page.waitFor` conditions. No
proof sleeps or counts yields. The history is the fixture `Location` that the
router itself calls.

| Proof                                                                                          | What it shows                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0. "keeps exact check, target, and failure types"                                              | An unannotated check: `Effect.Services` is exactly `Access`, `Effect.Error` is `never`, success is `Redirect \| Continue`. The route's services are exactly `QueryCache \| ActorTransport \| Access`. `@ts-expect-error`: a missing target param, a wrong search type, a failing view with no `errored`, a handler for another `E`, and a typed event failure. A segment target prints `/app/t1/posts/7?tab=edit`. |
| 1. "gives every matched segment its decoded target values, parent first, on every branch move" | Initial: tenant then post, with decoded params, search, URL, and `initial`. A post-ID push and a search-only replace ask both again, the stayed layout included. A same-URL request is `Unchanged` and a fragment move is `Committed`; neither asks. History has exactly the three moves.                                                                                                                          |
| 2. "a layout redirect starts no child check, declaration, or setup, and history moves once"    | While the t2 decision is held: no history, no t2 query call, one question. After a refusal: exactly `push /login?next=…`, receipt `Committed /login…`, no post check, no t2 query or actor, no post setup. A redirected replace replaces once.                                                                                                                                                                     |
| 2b. "an initial redirect replaces the entry the document already holds"                        | One `replace /login…`, only the tenant was asked, no layout setup, the published navigation is `initial /login`.                                                                                                                                                                                                                                                                                                   |
| 3. "rechecks a stayed protected layout when the tenant or the principal changes"               | t1 to t2: the same layout element, actor, and setup count, and the tenant check was asked with t2. After t2 is revoked, the stayed layout is asked again and refuses: one login entry, no post:t2/2 call.                                                                                                                                                                                                          |
| 4. "reports a redirect cycle and a runaway chain at the router, and commits nothing"           | `loop-a → loop-b → loop-a` fails with `RedirectCycle { repeated }` and the full chain. `step-0 → …` fails with `{ limit }` and 18 URLs. No history, no declaration, same page; the next navigation commits.                                                                                                                                                                                                        |
| 5. "a failed setup closes before errored shows its typed error; the Frame stays alive"         | `Setup:PostFailed` is shown. `setup-closed` precedes `errored-built`. The failed setup's local actor, the segment's post and comments queries, and its actor subscription are gone. The layout actor and tenant query keep their IDs; mounts and routes stay. The next move enters the post again.                                                                                                                 |
| 5b. "a failed root layout shows errored, and the next move enters the tree again"              | `Setup:LayoutFailed` at the root; its tenant query is released. `/app/t1` re-enters the tree: layout setups `broken, t1`, one mount, one route.                                                                                                                                                                                                                                                                    |
| 6. "an own declaration failure takes the Declaration branch; siblings are released"            | A stayed post whose actor read fails shows `Declaration:ActorStopped`; the receipt is `Committed`. The post view closed, no setup ran for `b`, `errored` was built once, both `b` queries and both subscriptions are gone, the layout is the same element. The next move enters the post again.                                                                                                                    |
| 7. "a later query failure and an event failure are not route setup failures"                   | A held comments query fails after setup: the `Query` failed branch shows and `errored` is never built. A dying event leaves the same element; the next event still sends to t1/1.                                                                                                                                                                                                                                  |
| 8. "a root close during a held check interrupts the receipt and leaks nothing"                 | With the t3 decision held, the page closes. The receipt fiber is interrupted, not `Committed`. No history, no t3 call, and no local actor, query, mount, or route is left.                                                                                                                                                                                                                                         |

### Mutations

Each mutation was applied to the source and the proof file was run. The
original was restored after each run. The runs were scripted in the session
scratchpad; this table is the record.

| Mutation                                                          | Killed by         | First failure                                                                 |
| ----------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------- |
| M1: push the requested URL, then the redirect                     | 2, 3              | history received an extra `push /app/t2/posts/9`                              |
| M2: ask the child even after a parent redirect                    | 2, 2b, 3, 4       | questions received `post:/app/t2/posts/9:push`                                |
| M3: skip checks when the route is already mounted (stayed layout) | 1, 2, 3, 4, 8     | questions missed `tenant:/app/t1/posts/2:push`                                |
| M4: no repeated-destination detection                             | 4                 | `RedirectCycle` was `limit`, not `repeated`                                   |
| M5: a setup failure keeps its descendants and own interests       | 5, 5b             | the `bad` post query record was still present                                 |
| M6: recover in the view Scope, without the owned attempt          | 5                 | order lacked `setup-closed` before `errored-built`                            |
| M7: errored registers nothing with the enclosing Loading          | 5                 | `ConditionNotObserved`: "the post's errored node"                             |
| M8: an own declaration failure ignores `errored`                  | 6                 | the navigation died with `ActorStopped`                                       |
| M9: a failed instance is stayed, not entered again                | 5, 6              | "post t1/1 content" not observed; "segment post did not create this instance" |
| M10: the router ignores an update that cannot stay                | 5b                | "the t1 layout" not observed                                                  |
| M11: a request ended by close reports `Unchanged`                 | 8                 | the receipt was not interrupted                                               |
| M12: fragment-only moves are checked                              | 1                 | 8 questions, expected 6                                                       |
| M13: every check sees kind `push`                                 | 1, 2b             | `kind: "push"` where `initial` was expected                                   |
| M14: start the target's setup before its checks                   | 1, 2, 3, 5, 5b, 6 | an extra layout setup `t1`; `tenant:t2` was called                            |

## Limits

- **Server boundary: not proved, because it does not exist.** This repository
  has no server route mount. The only HTML response path is
  `apps/notes/src/server.ts`, which renders one view with
  `Html.renderToString` and never runs the router. There is no route HTML
  handler and no streaming route adapter (#22). The actor HTTP server maps `Unauthorized` to 403
  (`packages/effect-frame/src/actor/http/wire.ts`, `statusOf`), but that is an
  actor endpoint, not a route response, and there is no 303 anywhere in
  `src/` or `apps/`. So "303 for anonymous, 403 for an authenticated refusal,
  selected before body bytes" (#20, #21) is not implemented or claimed here.
  The client half is complete: checks settle before history, declarations,
  and setup. A server adapter must call the same settling step before it
  writes a status or a byte, and must map a redirect to 303 and a policy
  refusal to 403. That needs a request `Principal` (#20, #39) and named
  policies; a client `before` is navigation convenience, not authorization,
  and every actor, query, and form endpoint must still check its own authority.
- The auth acceptance rows stay open while #20 is unimplemented.
- A check that needs the route instance's url-state runtime cannot run: a
  check runs before any instance exists. The registrar requires only the
  checks' own services; this is the one cast in `check.ts`.
- A check's services are erased to `never` inside the tree (one cast in
  `branch.ts`, `erase`) and carried by the segment's phantom `CheckR` into the
  route's `DataR`. The type fixtures prove the route's services are exact.
- `Unauthorized` from a declaration is not a `RouteFailure`. It stays a
  navigation failure (defect, nothing published), as in slice 2.
- A declaration failure on a segment without `errored` still fails the
  navigation with nothing published. It does not bubble to an ancestor's
  handler.
- The router pushes history before `update`. If an acquisition that no
  segment handles fails, the URL has moved while nothing is published (the
  slice 2 limit, narrowed but not removed).
- A redirected root re-entry acquires the replacement tree fresh. When a
  stayed root's own move fails into `errored`, the prepared failure is
  aborted and the router's re-entry acquires once more.
- The `errored` Source holds one value. A later slice may replace attempts
  through it; nothing does yet.
- A stayed segment whose view already succeeded never reruns setup. A failed
  one is entered again on any matching navigation; there is no in-place
  retry control.
- Redirect targets print the target segment's own search only. Ancestor
  search values are not carried.
- No browser proof: pop and fragment behavior use the fixture `Location`.
  Real Back/Forward, precommit cancellation, and focus are slice 5.
- Nested routes still have no url-state, `updateSearch`, pending state, or
  lazy views (slice 4).

## Open questions

- Should a declaration `Unauthorized` after a passing check become a typed
  refusal outcome (a redirect or a route-level 403 view) instead of a defect?
  Chosen now: defect, per the scope's rule that authorization refusal takes
  the check path, not `errored`.
- Should an unhandled descendant declaration failure bubble to the nearest
  ancestor `errored`? Chosen now: no (the scope forbids silent widening).
