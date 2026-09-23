import { Effect, Option } from "effect";
import type { RouteInstance, UrlUpdater } from "./codec.js";
import type { RouterService } from "./router.js";

/**
 * PRIVATE (route slices 3 and 5). What one navigate or replace request did.
 * The public `navigate`/`replace` are this same path with the result
 * dropped, so there is one command path, not two. Not exported: the public
 * surface changes once, when the route surface is chosen.
 *
 * - `Committed`: the final branch is installed at `url`, after any redirect.
 * - `Unchanged`: nothing moved; `url` is the current URL. A same-URL request,
 *   a redirect back to the current URL, a stale route instance's request,
 *   and a request whose leave prompt a newer navigation superseded.
 * - `Stayed`: a leave check answered `Stay` before commit; `url` is the
 *   current URL, which did not move.
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
export const Stayed = (url: URL): NavigationResult => ({ _tag: "Stayed", url });

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
