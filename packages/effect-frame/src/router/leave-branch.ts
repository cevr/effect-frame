import type { Effect, Scope } from "effect";
import type { Node } from "effect-frame/view";
import type {
  AnyBranch,
  Branch,
  DataROf,
  Declarations,
  LayoutProps,
  OwnServices,
  RecoveryFor,
  Segment,
  SegmentProps,
  ViewROf,
} from "./branch.js";
import { buildLayout, buildLeaf } from "./branch.js";
import type { MountedRoute } from "./leave.js";

/**
 * PRIVATE. A leaf and a layout whose views may register
 * leave checks with `Leave.onLeave`. See `docs/design/route-leave.md`.
 *
 * They build the same branch as the public `Route.leaf` and `Route.layout`.
 * Only the phantom view services differ: these also remove `MountedRoute`,
 * which every instance provides to its view. The public constructors remove
 * only `Scope`, so no public type names a leave service while #56 is open.
 */

/** A view's services minus the `Scope` and `MountedRoute` every instance provides. */
type ViewServices<R> = Exclude<Exclude<R, MountedRoute>, Scope.Scope>;

export const leaf = <
  Name extends string,
  Params,
  Search,
  Own extends Declarations,
  Data extends Declarations,
  R,
  CheckR = never,
  E = never,
  Root extends boolean = boolean,
>(
  seg: Segment<Name, Params, Search, Own, Data, CheckR, Root>,
  view: (props: SegmentProps<Params, Search, Data>) => Effect.Effect<Node, E, R>,
  ...recovery: RecoveryFor<E>
): Branch<
  Segment<Name, Params, Search, Own, Data, CheckR, Root>,
  ViewServices<R>,
  OwnServices<Segment<Name, Params, Search, Own, Data, CheckR, Root>>
> =>
  buildLeaf<ViewServices<R>, Name, Params, Search, Own, Data, R, CheckR, E, Root>(
    seg,
    view,
    recovery,
  );

export const layout = <
  Name extends string,
  Params,
  Search,
  Own extends Declarations,
  Data extends Declarations,
  const Children extends ReadonlyArray<AnyBranch<unknown>>,
  R,
  CheckR = never,
  E = never,
  Root extends boolean = boolean,
>(
  seg: Segment<Name, Params, Search, Own, Data, CheckR, Root>,
  children: Children,
  view: (
    props: LayoutProps<Params, Search, Data, ViewROf<Children[number]>>,
  ) => Effect.Effect<Node, E, R>,
  ...recovery: RecoveryFor<E>
): Branch<
  Segment<Name, Params, Search, Own, Data, CheckR, Root>,
  ViewServices<R>,
  OwnServices<Segment<Name, Params, Search, Own, Data, CheckR, Root>> | DataROf<Children[number]>
> =>
  buildLayout<ViewServices<R>, Name, Params, Search, Own, Data, Children, R, CheckR, E, Root>(
    seg,
    children,
    view,
    recovery,
  );
