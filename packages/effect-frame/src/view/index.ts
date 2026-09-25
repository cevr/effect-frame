export * as View from "./namespace.js";
export {
  For,
  Match,
  Portal,
  Show,
  type ForProps,
  type ListOptions,
  type MatchCases,
  type MatchProps,
  type PortalProps,
  type ShowIfProps,
  type ShowProps,
  type ShowWhenProps,
  type Tagged,
} from "./control.js";
export { mount, render } from "./runtime.js";
export type {
  BoundaryMarks,
  Cleanup,
  EventHandler,
  Host,
  HostEvent,
  PropertyValue,
  StaticProps,
} from "./host.js";
export type { Attached, Bind, Bound, Handler, PlainPost, Prepared } from "./view.js";
export type { CommandForm, FormBinding } from "./form.js";
export type { Module as LazyModule } from "./lazy.js";
export type {
  BoundaryKind,
  Child,
  Component,
  ControlNode,
  ElementNode,
  ElementProps,
  ForNode,
  MatchNode,
  Node,
  PortalNode,
  PropValue,
  ShowNode,
  Tag,
} from "./jsx-runtime.js";
export * as Dom from "./hosts/dom.js";
export * as Html from "./hosts/html-public.js";
// The streamed host-operation wire (#15), client half. The server half is `effect-frame/view/driven`.
export * as Remote from "./hosts/remote.js";

// Readiness through context (#16).
export {
  Await,
  Errored,
  ErroredScope,
  Loading,
  LoadingScope,
  Query,
  orErrored,
  ready,
  readyWithStale,
  type AwaitProps,
  type ErroredProps,
  type LoadingProps,
  type QueryProps,
  type ReadyValue,
} from "./readiness.js";
