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
root)` without change. A mode field is not added anywhere (acceptance row
"rendering mode is a constructor, not a field").

#### How a per-leaf mode will compose

#18 §6.2 also gives a leaf mode its own inputs: a prerendered leaf lists the
params to build at build time. That input belongs to the leaf, not to the
tree. The rule that keeps one way to set a mode:

1. The tree's mode constructor is the only place a mode is named. It sets
   the default for every leaf: `Route.client(name, root)`, and later for
   example `Route.ssr(name, root)`.
2. A later mode constructor may accept per-leaf overrides, but only from a
   set it declares, and only as an argument of that constructor. For
   example: `Route.ssr(name, root, { prerender: [Route.inputs(post,
listPosts)] })`. The override names a segment of the tree and carries
   that mode's inputs. The leaf value itself never carries a mode.
3. The constructor checks that every override names a leaf of this tree,
   and that the override is legal under the tree's mode (`client` declares
   none). An override for a segment outside the tree, or a mode the tree's
   constructor does not declare, does not compile.

So a mode is named once per tree, overrides are data of that one call, and
the same branch values mount under any mode. No leaf-level constructor
(`Route.prerenderLeaf`) and no mode field is added.

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
Route.actor: <C extends AnyContract>(
  contract: C,
  key: KeyOf<C>,
  options?: Route.ActorOptions<C>,
) => Route.ActorDeclaration<C>;
type Route.ActorOptions<C> = { readonly behavior?: Route.ActorBehavior<C> };
type Route.ActorBehavior<C> = Behavior<SnapshotOf<C>, MessageOf<C>, unknown, Refused>;

type Route.Declaration = QueryDeclaration<AnyQuery> | ActorDeclaration<AnyContract>;
type Route.Declarations = Readonly<Record<string, Declaration>>;
type Route.RouteData<Data extends Declarations> = {
  readonly [K in keyof Data]: /* Query: FollowedQuery<ResultOf<Q>, QueryFailure>; Actor: Source<RemoteActorRef<C>> */;
};
```

`NoDeclarations`, `BindingOf`, `Disjoint`, and `RecoveryFor` are not on the
`Route` namespace. They appear in the constructors' signatures (a default,
the binding of one entry, the child's name rule, the options tuple), and
they are emitted in the declaration files, but ordinary code never writes
them: a view names `RouteData` or `PropsOf`, and a constructor infers the
rest. A name that no application writes is surface without a user, and
removing it later would be a break (small-interface-deep-module).

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
  name: Name, options: SegmentOptions<P, S, Own, CheckR> & DataRequired<Own>,
) => Segment<Name, P["Type"], S["Type"], Own, Own, CheckR, true>;

Route.child: <ParentData extends Declarations, const Name extends string, P extends ParamsCodec,
  S extends SearchCodec = NoSearch, Own extends Declarations & Disjoint<ParentData> = NoDeclarations,
  CheckR = never>(
  parent: Segment<string, unknown, unknown, Declarations, ParentData, unknown>,
  name: Name, options: SegmentOptions<P, S, Own, CheckR> & DataRequired<Own>,
) => Segment<Name, P["Type"], S["Type"], Own, ParentData & Own, CheckR, false>;

interface Route.AnySegment {
  readonly _tag: "Segment";
  readonly [SegmentBrand]: "Segment"; // a module-private symbol
  readonly name: string;
  readonly parent: Option<AnySegment>;
}
interface Route.Segment<Name, Params, Search, Own, Data, CheckR = never, Root extends boolean = boolean>
  extends AnySegment {
  readonly name: Name;
  readonly searchKeys: SearchKeyInfo;
  href(params: Params, search: Search): string;
  hrefAt(current: URL, params: Params, search: Search): string;
  searchAt(current: URL): Search;
  currentAt(current: RouteMatch): Route.Current;
  readonly "~data": (_: never) => Data;    // phantoms
  readonly "~check": (_: never) => CheckR;
  readonly "~root": (_: never) => Root;
}
```

A segment prints itself (`href`, `hrefAt`), so it is a typed `Route.target`
destination and a `link` destination. Nothing else is on its type. What the
transition reads (the path parts, `decode`, `signature`, `declare`,
`searchUpdate`, and the `before` check) lives in a module-private runtime
keyed by the segment, as a branch's matcher does. A check's services are
held only by the `~check` phantom, which reaches the tree's `R`; a public
`check` member would hand out an Effect whose `R` was erased, so a caller
could run it without its services.

`DataRequired<Own>` makes `data` required whenever `Own` is not empty, so a
segment given its declaration type explicitly must say how to build it.
The brand symbol is not exported, so neither a segment nor a branch can be
written as a literal; only the constructors make them.

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
type RecoveryFor<E> = [E] extends [never] // not on `Route`; see Declarations
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

`Branch<Seg, ViewR, DataR>` is opaque: `_tag`, a module-private brand,
`segment`, and two phantom type members. The transition's matcher is not
part of its type. `leaf` and `layout` carry the segment's `Root` flag into
the branch type.

### Mount

```ts
// New: a tree, from a branch of a root segment.
Route.client<const Name extends string, Seg extends RootSegment, ViewR, DataR>(
  name: Name, root: Branch<Seg, ViewR, DataR>,
): Route.Tree<Name, ViewR | DataR>;
// Unchanged signature: the one-leaf shorthand. Declared last.
Route.client<const Name extends string, Params extends ParamsCodec, Search extends SearchCodec, R>(
  name: Name, definition: RouteDefinition<Params, Search, R>,
): Route<Name, Params, Search, R>;

interface Route.Tree<Name extends string, R> extends AnyRoute<R> { readonly name: Name }
```

A child segment matches only below its ancestors' path, so a tree mounted
from one would never match. `RootSegment` requires `~root` to be `true`,
which only `Route.segment` gives. Construction also refuses a child root
with `BranchRejected` ("a tree is mounted from a root segment, not a
child"), for a value that reached `client` around the type.

#### One mode constructor, two overloads, flat declared last

`client` keeps both forms under one name: the mode is one constructor
whatever the tree's size, which is the model. Two names (for example
`client` and `clientTree`) would be a second way to name the same mode.

An overloaded call that matches no overload reports the error of the last
overload. The flat form is the one applications write by hand as an object
literal, so it is declared last: a wrong flat definition reports the flat
form's own elaborated error, on the wrong property (a view's props, a
missing `path`), under TS2769. The cost is the rare wrong branch: a child
root reports that a `Branch` is missing `path`, `params`, `search`, and
`view`. The construction check above names that mistake at run time, and a
type fixture pins both.

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
type Route.Current = "page" | "ancestor" | "none";
interface Linkable<Params, Search> {
  readonly hrefAt: (current: URL, params: Params, search: Search) => string;
  readonly searchAt: (current: URL) => Search; // the current decoded search, or the empty one
  readonly currentAt: (current: RouteMatch) => Current;
}
interface Link {
  readonly href: Source<string>;
  readonly current: Source<Route.Current>; // new
  readonly active: Source<boolean>;        // current !== "none"
  readonly go: Effect.Effect<void>;
  readonly replace: Effect.Effect<void>;
}
link: <Params, Search>(
  to: Linkable<Params, Search>,
  params: NoInfer<Params>,
  search: LinkSearch<NoInfer<Search>>,
) => Effect.Effect<Link, never, Router>;
```

A flat `Route` and a `Segment` are both `Linkable`.

- A flat route is `"page"` when the router resolved the document to it (by
  name, as before), and `"none"` otherwise. It has no ancestors.
- A segment is `"none"` unless the current match is a tree that holds it.
  `client(name, root)` records the tree's name on each of its segments.
  This rule keeps a `"/"` root, whose path is a prefix of every URL, from
  being current on not-found or on another route.
- Inside its tree, a segment is `"page"` when the URL ends at it (its full
  path parses), and `"ancestor"` when the URL continues below it.

`Link` draws `"page"` as `aria-current="page"` and `"ancestor"` as
`aria-current="true"`, and removes the attribute for `"none"`. ARIA defines
`true` as "the current item within a set", which is what a section link in
a navigation is while a page below it is shown; `page` stays reserved for
the one link that is the current page. A data attribute was not chosen: it
tells assistive technology nothing.

### View

```ts
View.lazy: <P, E, R>(load: () => Promise<LazyModule<P, E, R>>) =>
  View.View<P, E | View.LazyImportFailed, R>;
interface LazyModule<P, E, R> { readonly default: View.View<P, E, R> }
class View.LazyImportFailed // { message: string }
```

`View.attempt` is already public (0.10.0). It does not change.

## Private to public names

| Private                                                                              | Public                                                           |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `Branch.segment`, `Branch.child`                                                     | `Route.segment`, `Route.child`                                   |
| `Branch.leaf`, `Branch.layout`                                                       | `Route.leaf`, `Route.layout`                                     |
| `Branch.route(name, tree)`                                                           | `Route.client(name, tree)`                                       |
| `Branch.query`, `Branch.actor`                                                       | `Route.query`, `Route.actor`                                     |
| `Branch.SegmentProps`, `LayoutProps`, `PropsOf`, `LayoutPropsOf`, `RouteData`        | the same names in `Route`                                        |
| `Branch.Pending`, `Recovery`, `Presentation`, `BranchRejected`                       | the same names in `Route`                                        |
| `Check.target`, `Check.redirect`, `Check.Continue`                                   | `Route.target`, `Route.redirect`, `Route.Continue`               |
| `Check.BeforeInput`, `Before`, `Verdict`, `Target`, `RouteFailure`, `NavigationKind` | the same names in `Route`                                        |
| `Check.RedirectCycle`, `Check.CheckNavigation`                                       | `Route.RedirectCycle`, `Route.CheckNavigation`                   |
| `Lazy.lazy`, `Lazy.LazyImportFailed`, `Lazy.Module`                                  | `View.lazy`, `View.LazyImportFailed`, `LazyModule` (a flat type) |

## What stays private, and why

| Private                                                                           | Why                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `leave.ts` (`onLeave`, `MountedRoute`, `Stay`, `Leave`), `leave-registry.ts`      | #56 is open. The owner has not accepted the platform limit or the stayed-change amendment (`route-leave.md`).                                                                                                                                                                                                                           |
| `browser-commit.ts`, `traversal.ts`                                               | They exist only to honor a leave answer before a traversal commits. Same reason.                                                                                                                                                                                                                                                        |
| `receipt.ts` (`NavigationResult`, `Committed`, `Unchanged`, `Stayed`)             | `Stayed` is produced only by leave checks, so it is not needed without leave. A public result without it would gain a case when #56 lands, which breaks every exhaustive match. The public `navigate` and `replace` keep `Effect<void>`; one command path stays.                                                                        |
| `check.ts` `register`, `read`, `Checker`, `redirectLimit`                         | The router's registry of a tree's checks. An application writes `before`; it never registers a checker.                                                                                                                                                                                                                                 |
| `lazy.ts` `definitionOf`, `withTicket`, `Ticket`, `Definition`                    | The transition's handle on an import attempt. An application calls `View.lazy` only.                                                                                                                                                                                                                                                    |
| The leave-capable `leaf` and `layout` (`src/router/leave-branch.ts`)              | The public `leaf` and `layout` remove only `Scope` from a view's services. The private variants also remove `MountedRoute`, so a private test view can call `onLeave`. Both build the same branch; only the phantom service type differs. When #56 lands, the public type removes `MountedRoute` too, which only removes a requirement. |
| A segment's path parts, `decode`, `signature`, `declare`, `searchUpdate`, `check` | What the transition reads. `check` would hand out an Effect whose services were erased to the phantom, so it is not on the type (see Segments).                                                                                                                                                                                         |
| The transition's matcher, instances, plans, and outlines                          | `Branch` is opaque. Its type names no leave question, instance, or plan, so the public declaration files name nothing from the leave modules.                                                                                                                                                                                           |

## Migration for flat routes

No source change is required for a route written with `Route.client`. The
flat constructor keeps its signature and its `Route` value (`name`,
`params`, `search`, `searchKeys`, `href`, `hrefAt`, `enter`), and its view
keeps `RouteProps`. The observable changes:

- **The publish rule.** A stayed navigation publishes the view's `params`
  and `search` Sources together, and only when the route's signature
  changes. The signature is the raw path record (the matched path strings,
  before decoding) and this route's search, decoded and encoded again. So
  these publish nothing: a hash-only move, a write of a key the route does
  not decode (an unrelated query key, or a `UrlState` key), a reordered
  query string, and a value that decodes and encodes to the same search
  (`?q=` and no `q` when `q` defaults to `""`). These publish both Sources:
  a raw path change that decodes to the same params (`/books/05` after
  `/books/5`), and any change of the encoded search, even when the params
  are equal. `tests/router/route-flat-publish.test.tsx` pins each case.
- **`Route.Route` is wider.** The flat `Route` interface now extends
  `Linkable`, so it also has `searchAt` and `currentAt`. Code that only
  reads a `Route` does not change. Code that writes a `Route` object by hand
  (not through `Route.client`) must add both.
- **`client` is overloaded.** A wrong flat definition is now reported as
  TS2769 ("No overload matches this call"), with the flat form's own error
  below it, on the same property as before.
- **`Link` gains `current`.** `aria-current` is unchanged for a flat route.
- The view's setup runs in an owned attempt, so a setup defect also
  settles an enclosing `Loading` (route slice 4). A flat route has no
  enclosing `Loading`, so nothing changes for it.

`link` changes its type parameters from `<Name, Params extends ParamsCodec,
Search extends SearchCodec, R>` to `<Params, Search>` (decoded types). A call
that passes explicit type arguments must drop them, for example
`link<"book", typeof BookParams, typeof BookSearch, never>(book, ...)`
becomes `link(book, ...)`. Inferred calls do not change.

Proof against EGW (`bible-tools/apps/egw-search`): its router use is
`Route.client` with `Route.search(Schema.Struct({}))`, `mount`,
`followLinks`, `browserLocation`, `Location`, `link(search, {}, {})`,
`Link`, `UrlState.make`, and `Route.SearchRecord`, `Route.readSearch`,
`Route.printSearch`. The EGW sources were checked unchanged against this
package's packed output (`npm pack`), from a copy outside the EGW checkout.
The packed package sat in the same store layout Bun uses, beside the same
`effect` (4.0.0-rc.115), `effect-machine`, and `@solidjs/signals`. Result:
`tsc --noEmit` exits 0 with the Effect language service on (the 0.12.0
baseline also exits 0), and `bun test src server` passes 28 of 28. The router tests that cover flat behavior
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
   outlet outside `View.loading` keeps `View.LoadingScope` in the route's services.
5. Missing typed fallback: a leaf whose view can fail, a lazy view
   included, does not compile without `errored`; a handler for another `E`
   does not compile.
6. The flat shorthand: `Route.client(name, definition)` keeps its exact
   `Route<Name, Params, Search, R>` type; a flat route and a segment are
   both `link` and `Route.target` destinations.
7. Construction: a wrong flat view errors on the `view` property; a child
   root does not compile and is refused at construction; an explicit `Own`
   without `data` does not compile; a branch literal does not compile; a
   segment has no `check`.
8. Current links (run): a `"/"` root layout and its child are `"page"`,
   `"ancestor"`, or `"none"`, with the matching `aria-current`, and neither
   is current on not-found or on a flat route.

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
