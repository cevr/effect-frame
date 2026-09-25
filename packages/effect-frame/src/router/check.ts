import type { TransportReadError, Unauthorized } from "effect-frame/actor";
import { Option, Schema } from "effect";
import type { Effect, Scope } from "effect";
import type { AnyRoute } from "./codec.js";
import type { Router } from "./router.js";
import type { Runtime as UrlStateRuntime } from "./url-state-runtime.js";

/**
 * Route checks, typed targets, and the typed route failure (route slice 3,
 * `docs/design/route-checks.md`). The `Route` namespace exports the check
 * vocabulary; the registry (`register`, `read`, `Checker`) and
 * `redirectLimit` stay internal. See `docs/design/route-public.md`.
 *
 * A check describes one candidate transition. It runs before history,
 * declarations, and setup, so its answer is a value, not a side effect:
 * `Continue` or `Redirect` to a typed target. The router owns the traversal
 * because a redirect can leave the route that asked for it.
 */

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/** A printed destination that a typed constructor produced. */
export interface Target {
  readonly _tag: "Target";
  readonly href: string;
}

/** Anything that prints its own params and search: a route or a segment. */
export interface Printable<Params, Search> {
  readonly href: (params: Params, search: Search) => string;
}

/**
 * A typed target. `NoInfer` keeps the destination's types in charge, so a
 * wrong param is an error here rather than a widened type.
 */
export const target = <Params, Search>(
  to: Printable<Params, Search>,
  params: NoInfer<Params>,
  search: NoInfer<Search>,
): Target => ({ _tag: "Target", href: to.href(params, search) });

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

export interface Continue {
  readonly _tag: "Continue";
}

export interface Redirect {
  readonly _tag: "Redirect";
  readonly target: Target;
}

/** What a check answers. A union, so no check can answer both or neither. */
export type Verdict = Continue | Redirect;

export const Continue: Continue = { _tag: "Continue" };

export const redirect = (to: Target): Redirect => ({ _tag: "Redirect", target: to });

/** How the document is moving. The same kinds the router publishes. */
export type NavigationKind = "initial" | "push" | "replace" | "pop";

/**
 * One candidate transition, as the segment that is asked sees it. These are
 * values, not Sources: they describe this candidate only.
 */
export interface BeforeInput<Params, Search> {
  readonly params: Params;
  readonly search: Search;
  readonly url: URL;
  readonly kind: NavigationKind;
}

/** A check. Its services stay in `R`; it cannot fail. */
export type Before<Params, Search, R> = (
  next: BeforeInput<Params, Search>,
) => Effect.Effect<Verdict, never, R>;

/**
 * A route's checks for one URL: parent first, stopping at the first
 * `Redirect`. The router runs it before history moves.
 */
export type Checker<R> = (url: URL, kind: NavigationKind) => Effect.Effect<Verdict, never, R>;

const checkers = new WeakMap<object, Checker<unknown>>();

/** Attach checks to a route value without changing the public route type. */
export const register = <R>(route: AnyRoute<R>, checker: Checker<R>): void => {
  checkers.set(route, checker);
};

/**
 * The checks of one route, with the services the mount context supplies.
 * A route without checks always continues. The router provides `Router`
 * and a temporary `Scope`. A check runs before any route instance exists,
 * so it never has an instance's url-state runtime; the one registrar,
 * `Branch.route`, lists only the checks' own services.
 */
export const read = <R>(route: AnyRoute<R>): Option.Option<Checker<MountServices<R>>> =>
  Option.map(
    Option.fromNullishOr(checkers.get(route)),
    // oxlint-disable-next-line effect/noAs -- register stored a Checker<R> under this same route value; see above for what is removed.
    (checker) => checker as Checker<MountServices<R>>,
  );

/** What `mount` requires of a route's services, in its own order. */
type MountServices<R> = Exclude<Exclude<Exclude<R, Router>, UrlStateRuntime>, Scope.Scope>;

/** Hops a navigation may take before the router refuses it. */
export const redirectLimit = 16;

/**
 * A redirect traversal the router refused: it named a URL it had already
 * visited, or it exceeded `redirectLimit`. Reported at the router boundary
 * as a defect of that navigation; nothing is committed.
 */
export class RedirectCycle extends Schema.TaggedError<RedirectCycle>()("RedirectCycle", {
  chain: Schema.Array(Schema.String),
  reason: Schema.Literals(["repeated", "limit"]),
}) {}

/**
 * A check asked the router to move. A check answers with `Redirect`
 * instead: the router is busy settling this navigation, so a move from
 * inside a check could never be served. Reported as a defect of the check.
 */
export class CheckNavigation extends Schema.TaggedError<CheckNavigation>()("CheckNavigation", {
  href: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/**
 * Why a segment shows its `errored` node. `Setup` is the view's own typed
 * error. `Declaration` is an acquisition error of the segment's own declared
 * data. `Unauthorized` is not here: an authorization refusal is a check's
 * job, and a host refusal after a passing check stays a navigation failure.
 */
export type RouteFailure<E> =
  | { readonly _tag: "Setup"; readonly error: E }
  | {
      readonly _tag: "Declaration";
      readonly error: Exclude<TransportReadError, Unauthorized>;
    };
