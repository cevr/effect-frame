# Nested transition (private proof)

This note records route execution slice 2: the explicit outlet, the nested
branch diff, typed route data bindings, and declaration overlap. All of it is
private. `src/router/branch.ts` is not exported from `effect-frame/router`. No
public route constructor, route field, or public type changed. There is no
Changeset. Issue #36 stays open.

Source: `packages/effect-frame/src/router/branch.ts`, plus `matchPrefix` and
`pathSegments` in `packages/effect-frame/src/router/route.ts`.
Proofs: `packages/effect-frame/tests/router/nested-transition.test.tsx`.

## Shape

```ts
const tenant = Branch.segment("tenant", {
  path: "/app/:tenant",
  params: TenantParams,
  data: ({ params }) => ({ tenant: Branch.query(TenantInfo, { tenant: params.tenant }) }),
});
const post = Branch.child(tenant, "post", {
  path: "posts/:postId",
  params: PostParams,
  data: ({ params }) => ({
    draft: Branch.actor(Draft, { tenant: params.tenant, postId: params.postId }),
    post: Branch.query(PostBody, params),
  }),
});
const tree = Branch.layout(tenant, [Branch.leaf(post, PostView)], (props) =>
  Effect.gen(function* () {
    const body = yield* Loading({ fallback, children: props.outlet });
    return <section>{body}</section>;
  }),
);
const app = Branch.route("app", tree); // one AnyRoute for mountRouter
```

- A child's `data` type is its parent's data type and its own. A name that the
  parent already declares does not compile (`Disjoint`).
- A query declaration binds to `FollowedQuery<ResultOf<Q>, QueryFailure>`.
- An actor declaration binds to `Source<RemoteActorRef<C>>`. The Source emits
  the current real ref. One ref is never mutated.
- `props.outlet` is an `Effect<Node, never, ChildR>`. It is a delayed setup.
  The layout yields it where the child must be owned. If the layout yields it
  inside `Loading`, the child's `ready` reads register with that Loading. If
  the layout yields it outside `Loading`, `LoadingScope` stays in the route's
  requirements and the route does not mount (type fixture).
- The route's requirement type is the union of every view's requirements and
  `QueryCache | ActorTransport` for the declarations. `Scope` is removed.

The whole tree is one router route. The router keeps history, the no-op rule,
stale-instance rejection, and not-found. It calls `enter` for a new tree and
`update` for a URL that the same tree matches.

## Lifetime model

Each mounted segment is one instance. The instance scope is forked from the
parent's children scope (the root: from the mount scope). Inside it, three
scopes are forked in this order: bindings, view, children. Scopes close in
reverse order, so a close runs the children, then the view, then the bindings.

Declarations are not held by the bindings scope. Each declaration interest is
one scope forked from the tree's declarations scope. The transition releases
it explicitly. This lets an interest outlive the view that read it.

A navigation computes a plan for the whole matched branch before anything is
published:

1. For each stayed segment, compute its declarations from the new values. A
   changed set of names is a defect. Only a changed key is acquired.
2. For each entered segment, acquire all declarations.
3. All acquisitions at all levels run in parallel. The concurrency is the
   number of parts. If one fails, every acquired part is released and the
   failure propagates. Nothing was published.
4. Commit, top down. For each stayed segment: install moved bindings, then
   publish the new values and refs in one `SubscriptionRef.set`, then commit
   the child, then release the replaced interests.
5. A child commit is one of three cases:
   - Stay: recurse.
   - Enter: create the new instance, set the outlet to it, close the exited
     instance's scopes, then release the exited interests.
   - None: set an empty outlet, close the exited instance, then release its
     interests.

The consequences:

- An entering interest is acquired before any exited interest is released. A
  key that both declare is shared by the `QueryCache` RcMap and is not
  refetched.
- An unchanged key is not acquired again. An unchanged ancestor does not
  refetch.
- An exited view closes while its interests are still held.
- A moved query binding keeps its output `SubscriptionRef`. The old follow is
  closed and the last value is carried as stale until the new key is ready.
- A moved actor binding publishes a new ref with the new values in one set. A
  control that reads `props.data.draft` sends to the new address. A control
  that captured the old ref at setup still sends to the old address.
- The view setup runs through the private `attempt` helper, owned by the view
  scope. An instance closed during setup does not return a node.

## Evidence

All proofs use a real `QueryCache`, a real actor host and transport, `ViewTest`,
`TestClock`, and one `Frame` over one root. Waits use `Deferred` receipts and
`page.waitFor` conditions. No proof sleeps or counts yields.

| Claim                                                 | Proof                                                                                              | What it observes                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Route data types are exact                            | 0. "keeps exact route data and requirement types"                                                  | The route's services equal `QueryCache \| ActorTransport`. The inherited binding is a `FollowedQuery`. The actor binding is `Source<RemoteActorRef<typeof Draft>>`. A leaky outlet keeps `LoadingScope`. A name collision, a missing binding, and a ref used as a function do not compile.                                                                  |
| Starts are parallel and precede every view            | 1. "starts every declaration in parallel, then starts the unseeded child under the layout Loading" | With the actor snapshot held, all queries have started and no view setup ran. After the gate, the layout shows and the child starts under the Loading fallback.                                                                                                                                                                                             |
| A replaced child keeps its layout; ownership overlaps | 2. "replaces the child under a retained layout and overlaps a shared key"                          | Post to edit: the same layout element, outlet element, local actor ID, and one layout setup. The shared post key has one call and the same record ID. The post view closed while its draft subscription and comments query were held. After it, both were released.                                                                                         |
| A post ID change keeps the view and moves bindings    | 3. "moves query and actor bindings on a post-ID change while the view stays"                       | While the new snapshot is held, params still show 1 and the current control sends to t1/1. After the move, params show 2, the title carries the old value marked stale, the subscription moved from t1/1 to t1/2, and the tenant has one call. The retained control sends to t1/1, and the current control sends to t1/2. A search change acquires nothing. |
| One child closes, then the root                       | 4. "closes one child, then the root, with records removed in order"                                | After navigating to `/app/t1`, the post actor and its queries are gone and the tenant record keeps its ID. After the root closes, the layout view closed while the tenant query was held, and no local actor, query, mount, or route record is left.                                                                                                        |
| The first HTML frame                                  | 5. "serializes the retained layout and its Loading fallback in the first HTML frame"               | With the post query held, the serialized HTML has the layout and the child fallback, and no post. After close, inspection is empty.                                                                                                                                                                                                                         |
| A root close orders views before interests            | 6. "closes the root with a child mounted: views close child first, before any interest"            | Close order is post, then layout. The post view closed while its three queries and its subscription were held. Inspection is empty after.                                                                                                                                                                                                                   |
| A root close during a held acquisition leaks nothing  | 7. "closes the root during a held stay acquisition: nothing is published or leaked"                | The post view ran once. No subscription is left on t1/1 or t1/2. Inspection is empty after.                                                                                                                                                                                                                                                                 |

### Mutations

Each mutation was applied to `branch.ts` and the file was run. The original
file was restored after each run.

| Mutation                                                                   | Result                           |
| -------------------------------------------------------------------------- | -------------------------------- |
| M1: sequential acquisition (`concurrency: 1`)                              | Killed by 1 and 3                |
| M2: release the exited interests before its view closes                    | Killed by 2                      |
| M3: release a stayed segment's replaced interests before its child commits | Survives (equivalent, see below) |
| M4: publish values before acquisition                                      | Killed by 3                      |
| M5: close the exited child before the entering child is created            | Survives (equivalent, see below) |
| M6: run the view in the instance scope, not the view scope                 | Killed by 6                      |
| M7: never move a binding                                                   | Killed by 3                      |

M3 and M5 do not break a stated invariant. All acquisitions finish before any
commit, so a shared key is held by the entering side in both orders. Bindings
are installed before either release, so no view reads a released interest.
M5 changes only whether the exited view closes before or after the outlet
swap. No view sees that difference without a render in between.

## Limits and counterexamples

- The router pushes the URL before it calls `update`. If an acquisition
  fails, the failure is a defect: nothing is published, but the URL has moved.
  A typed transition failure is slice 3.
- The exited view closes before `View.list` removes the exited row's DOM,
  because the list closes a row with a fork.
- Two segments that declare the same actor key hold two refs. Queries are
  shared through the cache RcMap; actor refs are not.
- An empty outlet, or a child whose `ready` read fails, under a layout
  `Loading` shows the fallback. This follows the accepted readiness rule.
- Publish is atomic per segment, not across levels. A child can briefly see a
  moved parent binding with its own old values inside one commit.
- A layout that yields `outlet` twice runs the child setup twice.
- A retained old ref still commands its old address after its interest is
  released. It is not refused.
- Only the first HTML frame is proved. There is no streaming.
- Nested routes have no url-state, `href`, `updateSearch`, `before`, pending
  state, lazy views, or leave checks yet.
