/**
 * What one push or replace request did: `RouterService.push` and
 * `replace` answer it, and so does a mounted route's own navigation.
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
