/**
 * The public `Route` namespace. It lists its exports, so a helper that an
 * implementation module exports for its neighbours never becomes public by
 * accident. See `docs/design/route-public.md`.
 *
 * One model: a segment is an address, a branch is a segment with its view
 * (`leaf`, `layout`), and a rendering-mode constructor (`client`, `ssr`,
 * `streamed`, `awaitAll`, `prerender`) mounts a tree. `client(name, definition)` is the
 * one-leaf shorthand of that model, and so is each other mode's.
 */

// Addresses: templates, params, and search.
export {
  PathRecord,
  SearchRecord,
  SearchSchemaRejected,
  TemplateRejected,
  UrlValueRejected,
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

// Segments, branches, and the rendering modes.
export {
  BranchRejected,
  actor,
  awaitAll,
  child,
  client,
  inputs,
  layout,
  leaf,
  prerender,
  query,
  segment,
  ssr,
  streamed,
} from "./branch.js";
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
  ModeConstructor,
  NoParams,
  Pending,
  PrerenderConstructor,
  PrerenderDefinition,
  PrerenderOptions,
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

// Rendering modes.
export type { RenderingMode } from "./rendering-mode.js";

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
