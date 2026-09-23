# Public route surface

This note records the public nested-route surface for issue #55 and the
layout part of #36. It promotes the private route slices 2, 3, and 4
(`nested-transition.md`, `route-checks.md`, `route-pending.md`) to one
public model in `effect-frame/router` and `effect-frame/view`. Slice 5
(`route-leave.md`) stays private: the owner has not answered #56.

## The model

There is one route model. It has three layers, and each layer is a value:

1. A **segment** is an address: a path relative to its parent, params and
   search codecs, declared data, and an optional `before` check. It has no
   view, so a child can name its parent, and a lazy module can name its
   segment, before any view exists.
2. A **branch** is a segment with its view. A `leaf` has no outlet. A
   `layout` has children and receives its `outlet`. Each takes the view's
   own `errored` and `pending` options.
3. A **mount** selects the rendering mode for a whole branch tree.
   `Route.client(name, root)` is the one mode that exists. The result is an
   ordinary route for `mount({ routes })`.

`Route.client(name, definition)` (the flat form that exists today) is the
one-leaf shorthand of this model. It is defined as exactly this
composition, and the implementation runs through it:

```ts
Route.client(name, definition);
// is
Route.client(name, Route.leaf(Route.segment(name, definition), definition.view));
```

### Why one model, with the flat form as its shorthand

- **Two runtimes would drift** (derive-dont-sync). The flat route had its
  own enter, update, props, `href`, `updateSearch`, retention, and search
  keys. The nested transition had its own identity, checks, failures, and
  pending. A flat route that needed a check would have had to change
  runtimes. Now the flat route is a one-leaf tree, so every capability of
  the model (checks, data, `errored`, `pending`, `lazy`) is one rewrite of
  the constructor call away, with the same runtime and the same identity
  rules.
- **Primitives first, a thin wrapper for the common case**
  (composition-over-flags). The segment, the branch, and the mode are the
  primitives. The flat definition is the one combination that every app
  starts with, so it stays as a wrapper. It takes the same fields as
  before and no more: a flat route that needs `before`, `data`, `errored`,
  or `pending` is written in the segment form. There is no second place to
  put those fields.
- **The segment form needed the flat route's search behavior anyway.**
  Nested segments had no `href` prop, `updateSearch`, `replaceSearch`,
  `retain`, or search keys, so nested routes could not use `UrlState` or
  typed links. The shorthand forced these into the segment. They are
  now part of every segment.
- **No break.** The flat form keeps its signature, its `Route` value, its
  props, and its behavior (see Migration).

### Mode belongs to the mount, not to each leaf

#18 §6.2 puts the mode on the leaf so that one branch cannot mix modes.
With one mode, that rule has nothing to decide. Here the mode is chosen
where a tree becomes mountable, and it applies to the whole tree, so one
branch still cannot mix modes. The branch values carry no mode, so the same
segments, leaves, and layouts can be mounted by a later `Route.ssr(name,
root)` without change. If a later mode needs per-leaf selection, that
ticket decides it; nothing here fixes the leaf as mode-free forever. A mode
field is not added anywhere (acceptance row "rendering mode is a
constructor, not a field").

## Exact public exports

All route construction is in the existing `Route` namespace
(`export * as Route from "./route.js"`). `src/router/route.ts` becomes the
namespace module. It lists its exports explicitly, so an internal helper
cannot leak by being exported from an implementation module. The template
and search codec code moves to `src/router/codec.ts`. Every name the `Route`
namespace exported before is still exported.

### Declarations

```ts
Route.query: <Q extends AnyQuery>(contract: Q, args: ArgsOf<Q>) => Route.QueryDeclaration<Q>;
Route.actor: <C extends AnyContract>(contract: C, key: KeyOf<C>) => Route.ActorDeclaration<C>;

type Route.Declaration = QueryDeclaration<AnyQuery> | ActorDeclaration<AnyContract>;
type Route.Declarations = Readonly<Record<string, Declaration>>;
type Route.NoDeclarations = Readonly<Record<never, never>>;
type Route.BindingOf<D> = /* Query: FollowedQuery<ResultOf<Q>, QueryFailure>; Actor: Source<RemoteActorRef<C>> */;
type Route.RouteData<Data extends Declarations> = { readonly [K in keyof Data]: BindingOf<Data[K]> };
type Route.Disjoint<Inherited> = { readonly [K in keyof Inherited]?: never };
```

### Segments

```ts
interface Route.SegmentOptions<P extends ParamsCodec, S extends SearchCodec, Own, CheckR> {
  readonly path: string; // relative to the parent
  readonly params: P; // decodes the path record accumulated from the root
  readonly search?: S;
  readonly searchKeys?: ReadonlyArray<string>; // for an opaque search codec
  readonly retain?: ReadonlyArray<Extract<keyof S["Type"], string>>;
  readonly data?: (values: Values<P["Type"], S["Type"]>) => Own;
  readonly before?: Before<P["Type"], S["Type"], CheckR>;
}

Route.segment: <const Name extends string, P extends ParamsCodec, S extends SearchCodec = NoSearch,
  Own extends Declarations = NoDeclarations, CheckR = never>(
  name: Name, options: SegmentOptions<P, S, Own, CheckR>,
) => Segment<Name, P["Type"], S["Type"], Own, Own, CheckR>;

Route.child: <ParentData extends Declarations, const Name extends string, P extends ParamsCodec,
  S extends SearchCodec = NoSearch, Own extends Declarations & Disjoint<ParentData> = NoDeclarations,
  CheckR = never>(
  parent: Segment<string, unknown, unknown, Declarations, ParentData, unknown>,
  name: Name, options: SegmentOptions<P, S, Own, CheckR>,
) => Segment<Name, P["Type"], S["Type"], Own, ParentData & Own, CheckR>;
```

A `Segment<Name, Params, Search, Own, Data, CheckR>` prints itself
(`href`, `hrefAt`), so it is a typed `Route.target` destination and a
`link` destination. Its other members are what the transition reads.

### Branches

```ts
interface Route.SegmentProps<Params, Search, Data extends Declarations>
  extends RouteProps<Params, Search> {
  readonly data: RouteData<Data>;
}
interface Route.LayoutProps<Params, Search, Data extends Declarations, ChildR>
  extends SegmentProps<Params, Search, Data> {
  readonly outlet: Effect.Effect<Node, never, ChildR>;
}
type Route.PropsOf<Seg>;             // SegmentProps of a segment
type Route.LayoutPropsOf<Seg, ChildR>;

interface Route.Pending {
  readonly fallback: Node;
  readonly after: Duration.Input;
  readonly atLeast: Duration.Input;
}
type Route.RouteFailure<E> =
  | { readonly _tag: "Setup"; readonly error: E }
  | { readonly _tag: "Declaration"; readonly error: Exclude<TransportReadError, Unauthorized> };
interface Route.Recovery<E> {
  readonly errored: (failure: Source<RouteFailure<E>>) => Node;
  readonly pending?: Pending;
}
interface Route.Presentation {
  readonly errored?: (failure: Source<RouteFailure<never>>) => Node;
  readonly pending?: Pending;
}
type Route.RecoveryFor<E> = [E] extends [never]
  ? readonly [] | readonly [options: Presentation]
  : readonly [options: Recovery<E>];

Route.leaf: <Name extends string, Params, Search, Own extends Declarations, Data extends Declarations,
  R, CheckR = never, E = never>(
  segment: Segment<Name, Params, Search, Own, Data, CheckR>,
  view: (props: SegmentProps<Params, Search, Data>) => Effect.Effect<Node, E, R>,
  ...options: RecoveryFor<E>
) => Branch<Segment<Name, Params, Search, Own, Data, CheckR>, Exclude<R, Scope.Scope>,
  /* the segment's declaration services | CheckR */>;

Route.layout: <Name extends string, Params, Search, Own extends Declarations, Data extends Declarations,
  const Children extends ReadonlyArray<AnyBranch<unknown>>, R, CheckR = never, E = never>(
  segment: Segment<Name, Params, Search, Own, Data, CheckR>,
  children: Children,
  view: (props: LayoutProps<Params, Search, Data, /* the children's view services */>) =>
    Effect.Effect<Node, E, R>,
  ...options: RecoveryFor<E>
) => Branch<Segment<...>, Exclude<R, Scope.Scope>, /* own services | the children's DataR */>;
```

`Branch<Seg, ViewR, DataR>` is opaque: `_tag`, `segment`, and two phantom
type members. The transition's matcher is not part of its type.

### Mount

```ts
// Unchanged: the one-leaf shorthand.
Route.client<const Name extends string, Params extends ParamsCodec, Search extends SearchCodec, R>(
  name: Name, definition: RouteDefinition<Params, Search, R>,
): Route<Name, Params, Search, R>;
// New: a tree.
Route.client<const Name extends string, Seg extends AnySegment, ViewR, DataR>(
  name: Name, root: Branch<Seg, ViewR, DataR>,
): Route.Tree<Name, ViewR | DataR>;

interface Route.Tree<Name extends string, R> extends AnyRoute<R> { readonly name: Name }
```

### Checks

```ts
interface Route.Target { readonly _tag: "Target"; readonly href: string }
interface Route.Printable<Params, Search> { readonly href: (params: Params, search: Search) => string }
Route.target: <Params, Search>(to: Printable<Params, Search>, params: NoInfer<Params>,
  search: NoInfer<Search>) => Target;

interface Route.Continue { readonly _tag: "Continue" }
interface Route.Redirect { readonly _tag: "Redirect"; readonly target: Target }
type Route.Verdict = Continue | Redirect;
Route.Continue: Continue;
Route.redirect: (to: Target) => Redirect;

type Route.NavigationKind = "initial" | "push" | "replace" | "pop";
interface Route.BeforeInput<Params, Search> {
  readonly params: Params; readonly search: Search; readonly url: URL; readonly kind: NavigationKind;
}
type Route.Before<Params, Search, R> = (next: BeforeInput<Params, Search>) =>
  Effect.Effect<Verdict, never, R>;

class Route.RedirectCycle   // { chain: ReadonlyArray<string>; reason: "repeated" | "limit" }
class Route.CheckNavigation // { href: string }
class Route.BranchRejected  // { segment: string; reason: string }
```

### Links

```ts
interface Linkable<Params, Search> {
  readonly hrefAt: (current: URL, params: Params, search: Search) => string;
  readonly searchAt: (current: URL) => Search; // the current decoded search, or the empty one
  readonly activeAt: (current: Match) => boolean;
}
link: <Params, Search>(
  to: Linkable<Params, Search>,
  params: NoInfer<Params>,
  search: LinkSearch<NoInfer<Search>>,
) => Effect.Effect<Link, never, Router>;
```

A flat `Route` and a `Segment` are both `Linkable`. A flat route is active
when the router resolved the document to it (by name, as before). A segment
is active when the current URL starts with its path and decodes.

### View

```ts
View.lazy: <P, E, R>(load: () => Promise<View.LazyModule<P, E, R>>) =>
  View.View<P, E | View.LazyImportFailed, R>;
interface View.LazyModule<P, E, R> { readonly default: View.View<P, E, R> }
class View.LazyImportFailed // { message: string }
```

`View.attempt` is already public (0.10.0). It does not change.

## Private to public names

| Private                                                                              | Public                                                  |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `Branch.segment`, `Branch.child`                                                     | `Route.segment`, `Route.child`                          |
| `Branch.leaf`, `Branch.layout`                                                       | `Route.leaf`, `Route.layout`                            |
| `Branch.route(name, tree)`                                                           | `Route.client(name, tree)`                              |
| `Branch.query`, `Branch.actor`                                                       | `Route.query`, `Route.actor`                            |
| `Branch.SegmentProps`, `LayoutProps`, `PropsOf`, `LayoutPropsOf`, `RouteData`        | the same names in `Route`                               |
| `Branch.Pending`, `Recovery`, `Presentation`, `RecoveryFor`, `BranchRejected`        | the same names in `Route`                               |
| `Check.target`, `Check.redirect`, `Check.Continue`                                   | `Route.target`, `Route.redirect`, `Route.Continue`      |
| `Check.BeforeInput`, `Before`, `Verdict`, `Target`, `RouteFailure`, `NavigationKind` | the same names in `Route`                               |
| `Check.RedirectCycle`, `Check.CheckNavigation`                                       | `Route.RedirectCycle`, `Route.CheckNavigation`          |
| `Lazy.lazy`, `Lazy.LazyImportFailed`, `Lazy.Module`                                  | `View.lazy`, `View.LazyImportFailed`, `View.LazyModule` |

## What stays private, and why

| Private                                                                      | Why                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `leave.ts` (`onLeave`, `MountedRoute`, `Stay`, `Leave`), `leave-registry.ts` | #56 is open. The owner has not accepted the platform limit or the stayed-change amendment (`route-leave.md`).                                                                                                                                                                                                                           |
| `browser-commit.ts`, `traversal.ts`                                          | They exist only to honor a leave answer before a traversal commits. Same reason.                                                                                                                                                                                                                                                        |
| `receipt.ts` (`NavigationResult`, `Committed`, `Unchanged`, `Stayed`)        | `Stayed` is produced only by leave checks, so it is not needed without leave. A public result without it would gain a case when #56 lands, which breaks every exhaustive match. The public `navigate` and `replace` keep `Effect<void>`; one command path stays.                                                                        |
| `check.ts` `register`, `read`, `Checker`, `redirectLimit`                    | The router's registry of a tree's checks. An application writes `before`; it never registers a checker.                                                                                                                                                                                                                                 |
| `lazy.ts` `definitionOf`, `withTicket`, `Ticket`, `Definition`               | The transition's handle on an import attempt. An application calls `View.lazy` only.                                                                                                                                                                                                                                                    |
| The leave-capable `leaf` and `layout` (`src/router/leave-branch.ts`)         | The public `leaf` and `layout` remove only `Scope` from a view's services. The private variants also remove `MountedRoute`, so a private test view can call `onLeave`. Both build the same branch; only the phantom service type differs. When #56 lands, the public type removes `MountedRoute` too, which only removes a requirement. |
| The transition's matcher, instances, plans, and outlines                     | `Branch` is opaque. Its type names no leave question, instance, or plan, so the public declaration files name nothing from the leave modules.                                                                                                                                                                                           |

## Migration for flat routes

No source change is required. The flat constructor keeps its signature and
its `Route` value (`name`, `params`, `search`, `searchKeys`, `href`,
`hrefAt`, `enter`), and its view keeps `RouteProps`. Two observable changes
follow from running a flat route as a one-leaf tree:

- The view's `params` and `search` Sources publish only when the matched
  values change (by their encoded form). A navigation that changes only the
  hash, or that decodes to the same values, no longer publishes an equal
  value again.
- The view's setup runs in an owned attempt, so a setup defect also
  settles an enclosing `Loading` (route slice 4). A flat route has no
  enclosing `Loading`, so nothing changes for it.

`link` changes its type parameters from `<Name, Params extends ParamsCodec,
Search extends SearchCodec, R>` to `<Params, Search>` (decoded types). A call
that passes explicit type arguments must drop them. Inferred calls do not
change.

Proof against EGW (`bible-tools/apps/egw-search`): its router use is
`Route.client` with `Route.search(Schema.Struct({}))`, `mount`,
`followLinks`, `browserLocation`, `Location`, `link(search, {}, {})`,
`Link`, `UrlState.make`, and `Route.SearchRecord`, `Route.readSearch`,
`Route.printSearch`. The EGW sources are type-checked unchanged against this
package's built output, from a copy in the session scratchpad (the EGW
checkout is not touched). The router tests that cover flat behavior
(`router.test.tsx`, `route.test.tsx`, `url-state.test.tsx`,
`inspection.test.tsx`, `mount-types.test.tsx`) pass unchanged.

## Type fixtures to prove

In `tests/router/route-public.test.tsx`, with public imports only:

1. Exact `E` and `R`: the tree's services are exactly the declarations'
   `QueryCache | ActorTransport` and the checks' services. A lazy view's
   `E` is exactly the module's `E | LazyImportFailed`; its props and `R` are
   the module's.
2. An invalid target: a missing param, a wrong param type, and a wrong
   search field in `Route.target` do not compile.
3. Lazy module props: a module whose view takes other props does not
   compile as a leaf's view.
4. Missing services: `mount` of a tree whose view needs a service the
   layers do not provide does not compile when run; a layout that yields its
   outlet outside `Loading` keeps `LoadingScope` in the route's services.
5. Missing typed fallback: a leaf whose view can fail, a lazy view
   included, does not compile without `errored`; a handler for another `E`
   does not compile.
6. The flat shorthand: `Route.client(name, definition)` keeps its exact
   `Route<Name, Params, Search, R>` type; a flat route and a segment are
   both `link` and `Route.target` destinations.

And one end-to-end example with public imports only: a two-level
tenant/post app with a `before` redirect, `errored`, `pending`, and a lazy
leaf.

## Limits

Every limit of route slices 2, 3, and 4 stays. In particular: there is no
server route adapter (no 303 or 403), declared actor acquisition is not
under `pending`, a client cold start shows no pending, and a client
`before` is navigation convenience, not authorization. A tree's search
keys are the union of every segment's keys in the tree, not only the
matched branch's, so `UrlState` cannot claim a key that any segment of the
tree decodes.
