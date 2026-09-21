export * as Route from "./route.js";
export { Link, isActive, link, type LinkProps } from "./link.js";
export type { Link as RouteLink } from "./link.js";
export {
  Location,
  Router,
  browserLocation,
  followLinks,
  mount,
  type LocationService,
  type Match,
  type MountOptions,
  type Navigation,
  type NavigateOptions,
  type NotFoundProps,
  type RouterService,
} from "./router.js";
export type {
  AnyRoute,
  Entered,
  ParamsCodec,
  Part,
  PathRecord,
  RouteDefinition,
  RouteProps,
  Route as RouteOf,
  SearchCodec,
  SearchRecord,
  TemplateRejected,
} from "./route.js";
