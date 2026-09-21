export * as Route from "./route.js";
export { Link, isActive, link, type LinkProps, type LinkSearch } from "./link.js";
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
  type NotFoundProps,
  type RouterService,
} from "./router.js";
export type {
  AnyRoute,
  Entered,
  ParamsCodec,
  Part,
  PathRecord,
  RouteNavigation,
  RouteDefinition,
  RouteProps,
  Route as RouteOf,
  SearchCodec,
  SearchRecord,
  SearchUpdater,
  TemplateRejected,
  UrlUpdater,
} from "./route.js";
