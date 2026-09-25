/**
 * The public `Route` namespace. It lists its exports, so a helper that an
 * implementation module exports for its neighbours never becomes public by
 * accident. See `docs/design/route-public.md`.
 *
 * One model: a segment is an address, a branch is a segment with its view
 * (`leaf`, `layout`), and a rendering-mode constructor (`client`, `ssr`,
 * `streamed`, `awaitAll`, `prerender`, `driven`) mounts a tree. There is no
 * other form: a one-page route is a tree of one leaf.
 */

// Addresses: templates, params, and search.
export {
  PathRecord,
  SearchRecord,
  TemplateRejected,
  UrlValueRejected,
  matchPath,
  parseTemplate,
  printSearch,
  readSearch,
  search,
  withDefault,
} from "./codec.js";
export type {
  AnyRoute,
  Entered,
  Current,
  Linkable,
  ParamsCodec,
  Part,
  RouteInstance,
  RouteNavigation,
  RouteProps,
  SearchCodec,
  SearchKeyInfo,
  SearchUpdater,
  UrlUpdater,
} from "./codec.js";

// Segments, branches, and the rendering modes.
export {
  BranchRejected,
  actor,
  commandRef,
  awaitAll,
  child,
  client,
  driven,
  drivenAt,
  inputs,
  layout,
  leaf,
  prerender,
  query,
  redirecting,
  segment,
  ssr,
  streamed,
} from "./branch.js";
export type {
  ActorBehavior,
  ActorDeclaration,
  ActorOptions,
  AnyBranch,
  AnySegment,
  Branch,
  Declaration,
  Declarations,
  DrivenAt,
  LayoutPropsOf,
  LeafOptions,
  CommandRefDeclaration,
  FollowedActor,
  FollowedCommands,
  ModeConstructor,
  NoParams,
  Pending,
  PrerenderConstructor,
  PrerenderOptions,
  Presentation,
  PropsOf,
  QueryDeclaration,
  Recovery,
  RouteData,
  Segment,
  SegmentOptions,
  Tree,
  Values,
} from "./branch.js";

// Checks, redirects, and route failures.
export { CheckNavigation, Continue, RedirectCycle, redirect } from "./check.js";
export { RouteNameRejected } from "./router.js";
export type {
  Before,
  BeforeInput,
  NavigationKind,
  Redirect,
  RouteFailure,
  Verdict,
} from "./check.js";

// Rendering modes.
export type { RenderingMode } from "./rendering-mode.js";

// Server-driven leaves and the op wire's client end (#18 §6, #22 §5).
export { WireFailed, drivenView } from "./driven.js";
export type {
  Connection,
  DrivenOptions,
  DrivenProps,
  DrivenServices,
  DrivenView,
  OpWireService,
} from "./driven.js";

// Prerender inputs and the definition-time refusal (#23).
export { PrerenderAncestorNotEnumerable, PrerenderInputsRejected } from "./prerender.js";
export type {
  AnyInputs,
  Enumerate,
  Inputs,
  OwnParams,
  PrerenderError,
  PrerenderServices,
  Prerendered,
} from "./prerender.js";
