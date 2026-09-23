/**
 * The public `Route` namespace. It lists its exports, so a helper that an
 * implementation module exports for its neighbours never becomes public by
 * accident. See `docs/design/route-public.md`.
 *
 * One model: a segment is an address, a branch is a segment with its view
 * (`leaf`, `layout`), and a rendering-mode constructor (`client`) mounts a
 * tree. `client(name, definition)` is the one-leaf shorthand of that model.
 */

// Addresses: templates, params, and search.
export {
  PathRecord,
  SearchRecord,
  SearchSchemaRejected,
  TemplateRejected,
  matchPath,
  mergeSearchRecord,
  parseTemplate,
  printPath,
  printSearch,
  readSearch,
  search,
  searchKeysOf,
  withDefault,
} from "./codec.js";
export type {
  AnyRoute,
  Entered,
  Current,
  Linkable,
  ParamsCodec,
  Part,
  Route,
  RouteDefinition,
  RouteInstance,
  RouteNavigation,
  RouteProps,
  SearchCodec,
  SearchKeyInfo,
  SearchUpdater,
  UrlUpdater,
} from "./codec.js";

// Segments, branches, and the client mode.
export { BranchRejected, actor, child, client, layout, leaf, query, segment } from "./branch.js";
export type {
  ActorDeclaration,
  AnyBranch,
  AnySegment,
  Branch,
  Declaration,
  Declarations,
  LayoutProps,
  LayoutPropsOf,
  LeafOptions,
  Pending,
  Presentation,
  PropsOf,
  QueryDeclaration,
  Recovery,
  RouteData,
  Segment,
  SegmentOptions,
  SegmentProps,
  Tree,
  Values,
} from "./branch.js";

// Checks, typed targets, and route failures.
export { CheckNavigation, Continue, RedirectCycle, redirect, target } from "./check.js";
export type {
  Before,
  BeforeInput,
  NavigationKind,
  Printable,
  Redirect,
  RouteFailure,
  Target,
  Verdict,
} from "./check.js";
