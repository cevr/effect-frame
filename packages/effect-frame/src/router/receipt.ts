import { Effect, Option } from "effect";
import type { RouteInstance, UrlUpdater } from "./route.js";
import type { RouterService } from "./router.js";

/**
 * PRIVATE (route slice 3). What one navigate or replace request did. The
 * public `navigate`/`replace` are this same path with the result dropped, so
 * there is one command path, not two. Not exported until the leave slice
 * makes `Stayed` reachable and the public surface can change once.
 *
 * - `Committed`: the final branch is installed at `url`, after any redirect.
 * - `Unchanged`: nothing moved; `url` is the current URL. A same-URL request,
 *   a redirect back to the current URL, and a stale route instance's request.
 * - `Stayed`: a leave check canceled the candidate before commit. Reserved:
 *   nothing produces it before slice 5.
 *
 * A request that the router's close ends is interrupted; it never reports a
 * result it did not reach.
 */
export type NavigationResult =
  | { readonly _tag: "Committed"; readonly url: URL }
  | { readonly _tag: "Unchanged"; readonly url: URL }
  | { readonly _tag: "Stayed"; readonly url: URL };

export const Committed = (url: URL): NavigationResult => ({ _tag: "Committed", url });
export const Unchanged = (url: URL): NavigationResult => ({ _tag: "Unchanged", url });

/** The receipt-returning form of the router's commands. */
export interface Receipts {
  readonly navigate: (
    href: string | UrlUpdater,
    instance?: RouteInstance,
  ) => Effect.Effect<NavigationResult>;
  readonly replace: (
    href: string | UrlUpdater,
    instance?: RouteInstance,
  ) => Effect.Effect<NavigationResult>;
}

const registered = new WeakMap<RouterService, Receipts>();

export const register = (router: RouterService, receipts: Receipts): void => {
  registered.set(router, receipts);
};

/** The receipts of a mounted router service. Anything else is a defect. */
export const of = (router: RouterService): Receipts =>
  Option.getOrElse(Option.fromNullishOr(registered.get(router)), () => ({
    navigate: () => Effect.die("not a mounted router"),
    replace: () => Effect.die("not a mounted router"),
  }));
