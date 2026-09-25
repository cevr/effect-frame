export * as View from "./namespace.js";
export {
  For,
  Match,
  Portal,
  Show,
  type ForProps,
  type ListOptions,
  type MatchProps,
  type MatchSetups,
  type PortalProps,
  type ShowOptions,
  type ShowProps,
  type Tagged,
} from "./control.js";
export type {
  BoundaryMarks,
  Cleanup,
  EventHandler,
  Host,
  HostEvent,
  PropertyValue,
  StaticProps,
} from "./host.js";
export type { Attached, Bind, Bound, Handler, PlainPost, Prepared, PreparedKind } from "./view.js";
export type { PortalHost, PortalTarget } from "./portal-target.js";
// The HTML tags and their props: what JSX checks an element against.
export type { Attr, HtmlElements } from "./intrinsics.js";
export type { CommandForm, FormBinding } from "./form.js";
export type { LazyView, Module as LazyModule } from "./lazy.js";
// The interpreter's node model stays inside the package: an author needs
// only `Node`, `Child`, and the props of the tags it wraps.
export type { Child, Node } from "./jsx-runtime.js";
export * as Dom from "./hosts/dom.js";
export * as Html from "./hosts/html-public.js";
// The streamed host-operation wire (#15), client half. The server half is `effect-frame/view/driven`.
export * as Remote from "./hosts/remote.js";

// Readiness through context (#16): the boundaries and `View.ready` are
// members of `View`; the tag and the props types are flat.
export {
  Await,
  type AwaitProps,
  type ErroredProps,
  type LoadingProps,
  type ReadyValue,
  type ScopesClosed,
} from "./readiness.js";
