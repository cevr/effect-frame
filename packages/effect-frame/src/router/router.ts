import { Source } from "effect-frame/actor/client";
import type { Host } from "effect-frame/view";
import { View } from "effect-frame/view";
import { read as readInspection, register as registerInspection } from "./route-inspection.js";
import type { Duration } from "effect";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Option,
  Predicate,
  Queue,
  Ref,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import type { AnyRoute, Entered, RouteInstance, RouteNavigation, UrlUpdater } from "./codec.js";
import {
  Runtime as UrlStateRuntime,
  makeRuntime as makeUrlStateRuntime,
} from "./url-state-runtime.js";
import * as Inspection from "../inspection.js";
import type { NavigationKind } from "./check.js";
import { CheckNavigation, RedirectCycle, read as readChecks, redirectLimit } from "./check.js";
import type { NavigationResult } from "./receipt.js";
import { Committed, Stayed, Unchanged, register as registerReceipts } from "./receipt.js";
import type { LeaveKind, LeaveVerdict, Question } from "./leave-registry.js";
import { Leave, read as readLeave } from "./leave-registry.js";
import type { Traversal } from "./traversal.js";
import { read as readTraversals } from "./traversal.js";
import type { Landing, Shell, WriteKind, Written } from "./landing.js";
import { readShell, readSurface, registerShell } from "./landing.js";
import * as LeafRoot from "./leaf-root.js";
import type { NavigationBehavior } from "./navigation-behavior.js";
import { Restore } from "./navigation-behavior.js";

/**
 * The router (#18 §7). The URL is the state: the router holds nothing about
 * "where we are" beyond what the location reports, so a reload, a link, and
 * a back navigation are one code path.
 */

/** One movement of the document, as the views may observe it. */
export interface Navigation {
  readonly url: URL;
  readonly kind: "initial" | "push" | "replace" | "pop";
}

/** The resolved name retained with one published navigation. */
interface NavigationSample extends Navigation {
  readonly routeName: string;
}

/**
 * Which route the document is on, and at what URL. Named `RouteMatch` so it
 * never meets the view's `Match` tag in one file.
 */
export interface RouteMatch {
  readonly name: string;
  readonly url: URL;
}

export interface RouterService {
  /**
   * Move to a printed href. It cannot fail: a URL no route matches shows
   * the not-found view. An href equal to the current one is not a move.
   * A typed move prints its href with `route.href`, or uses `link`.
   */
  readonly navigate: (href: string | UrlUpdater) => Effect.Effect<void>;
  /** Replace the current history entry with a printed href. */
  readonly replace: (href: string | UrlUpdater) => Effect.Effect<void>;
  /** Every navigation, the current one first. */
  readonly navigations: Source<Navigation>;
  /** The route the document is on, by name, with its URL. */
  readonly current: Source<RouteMatch>;
}

export class Router extends Context.Service<Router, RouterService>()(
  "effect-frame/src/router/router",
) {}

/**
 * Where the document is and how it moves. The browser has one; a server
 * render and a test each have their own. The router never touches the
 * platform directly, so this is the whole seam.
 */
export interface LocationService {
  readonly current: Effect.Effect<URL>;
  readonly push: (url: URL) => Effect.Effect<void>;
  readonly replace: (url: URL) => Effect.Effect<void>;
  /** URLs the platform moves to on its own: back and forward. */
  readonly pops: Stream.Stream<URL>;
}

export class Location extends Context.Service<Location, LocationService>()(
  "effect-frame/src/router/router/Location",
) {}

/** What the not-found view receives: the URL nothing matched. */
export interface NotFoundProps {
  readonly url: Source<URL>;
}

/**
 * `R` is what the routes' views require and `N` what the not-found view
 * requires. They are separate so neither has to widen to fit the other: a
 * not-found view that links home needs `Router` even when no route does.
 */
export interface MountOptions<R, HostNode, N = R> {
  readonly routes: ReadonlyArray<AnyRoute<R>>;
  readonly notFound: View.View<NotFoundProps, never, N>;
  readonly host: Host<HostNode>;
  readonly root: HostNode;
  /**
   * What a navigation does to scroll and focus at shell commit (#31), unless
   * the destination leaf names its own `landing`. Absent: `NavigationBehavior.Restore`.
   */
  readonly landing?: NavigationBehavior;
  /**
   * How long a traversal (Back, Forward, a history jump) waits for the
   * reads its page declared before it places the saved position. At the
   * limit it lands on the page as it is, so the scroll may clamp, and it
   * never places again when the reads settle later: a late jump after the
   * reader has been looking at the page is worse than a clamped one.
   * Absent: 3 seconds.
   */
  readonly traversalReadLimit?: Duration.Input;
}

/** How long a traversal waits for its declared reads when `mount` names no limit. */
const defaultTraversalReadLimit: Duration.Input = "3 seconds";

interface Mounted<R> {
  readonly route: AnyRoute<R>;
  readonly entered: Entered<R>;
  readonly scope: Scope.Closeable;
}

const newRouteInstance = (): RouteInstance => ({ _tag: "RouteInstance" });
const unavailableInspection = Symbol.for("effect-frame/frame/inspection-unavailable");

/** The not-found view as a route that matches everything, so one rule mounts both. */
const notFoundRoute = <R>(view: View.View<NotFoundProps, never, R>): AnyRoute<R> => ({
  name: "not-found",
  searchKeys: { known: true, keys: [] },
  enter: (url) =>
    Option.some(
      Effect.map(SubscriptionRef.make(url), (current): Entered<R> => {
        // Not-found is a page: its root takes focus when it enters, as a leaf's does.
        const cell = LeafRoot.makeCell();
        let entering = true;
        const entered: Entered<R> = {
          instance: { _tag: "RouteInstance" },
          setup: Effect.map(
            view({
              url: Source.fromSubscriptionRef(current),
            }),
            (node) => LeafRoot.mark(node, cell),
          ),
          update: (next) =>
            Effect.andThen(
              Effect.sync(() => {
                entering = false;
              }),
              Effect.as(SubscriptionRef.set(current, next), true),
            ),
        };
        registerInspection(entered, Effect.succeed({ params: {}, search: {} }));
        registerShell(
          entered,
          Effect.sync(() => ({
            entered: entering,
            behavior: Option.none(),
            root: Ref.get(cell),
            // Its view is mounted in place, not through an outlet: drawn once shown.
            drawn: Effect.void,
            settled: Effect.void,
          })),
        );
        return entered;
      }),
    ),
});

interface Resolved<R> {
  readonly route: AnyRoute<R>;
  readonly enter: Effect.Effect<Entered<R>, never, Scope.Scope>;
}

/** The first route that matches, or not-found. Total. */
const resolve = <R>(
  routes: ReadonlyArray<AnyRoute<R>>,
  fallback: AnyRoute<R>,
  url: URL,
  navigation?: RouteNavigation,
): Resolved<R> => {
  for (const route of routes) {
    const entered = route.enter(url, navigation);
    if (Option.isSome(entered)) {
      return { route, enter: entered.value };
    }
  }
  return {
    route: fallback,
    enter: Option.getOrElse(fallback.enter(url, navigation), () =>
      Effect.die("not-found did not match"),
    ),
  };
};

/** What a request ends with. None: the router closed before the request ran. */
type Outcome = Deferred.Deferred<Exit.Exit<Option.Option<NavigationResult>, never>>;

type Request =
  | {
      readonly operation: "push" | "replace";
      readonly href: string | UrlUpdater;
      readonly instance: Option.Option<RouteInstance>;
      readonly done: Outcome;
    }
  | {
      /** The platform already moved: a committed Back or Forward. */
      readonly operation: "pop";
      readonly done: Outcome;
    }
  | {
      /** The platform will move after the router answers: see `traversal.ts`. */
      readonly operation: "traverse";
      readonly traversal: Traversal;
      readonly done: Outcome;
    };

/** What a leave prompt ended with. `Superseded`: a newer request came first. */
type Decision = LeaveVerdict | { readonly _tag: "Superseded" };

const superseded: Decision = { _tag: "Superseded" };

/** Why a traversal went unprotected, for the diagnostic. */
type Unprotected = "committed" | "noncancelable";

/** A candidate URL after its checks, with the route that will show it. */
interface Settled<R> {
  readonly url: URL;
  readonly target: Resolved<R>;
}

/** Only the fragment differs: a native in-document move, which no check sees. */
const fragmentOnly = (next: URL, committed: URL): boolean =>
  next.origin === committed.origin &&
  next.pathname === committed.pathname &&
  next.search === committed.search;

/**
 * Mount a route tree on a host. The Scope owns the router; each shown route
 * lives in a child scope that closes when the route exits. A navigation to
 * the route already shown is a stayed transition: the view keeps its
 * identity and its scope, and the new values are published into its props.
 * Any other navigation enters the next route before it exits the previous
 * one, so the two are briefly both held.
 *
 * Navigations are applied one at a time on the router's own fiber, which is
 * what lets `navigate` require nothing: a view calls it from an event and
 * the route's own requirements are met where the router was mounted.
 * `Router` is provided to every route's view.
 */
export const mount: <R, HostNode, N = R>(
  options: MountOptions<R, HostNode, N>,
) => Effect.Effect<
  RouterService,
  never,
  Exclude<Exclude<Exclude<R | N, Router>, UrlStateRuntime>, Scope.Scope> | Location | Scope.Scope
> = Effect.fn("Router.mount")(function* <R, HostNode, N = R>(
  options: MountOptions<R, HostNode, N>,
) {
  const location = yield* Location;
  const scope = yield* Effect.scope;
  const routes: ReadonlyArray<AnyRoute<R | N>> = options.routes;
  const fallback: AnyRoute<R | N> = notFoundRoute(options.notFound);
  const initial = yield* location.current;
  const navigations = yield* SubscriptionRef.make<NavigationSample>({
    url: initial,
    kind: "initial",
    routeName: fallback.name,
  });
  const requests = yield* Queue.unbounded<Request>();
  const surface = readSurface(location);
  const defaultBehavior = Option.getOrElse(Option.fromNullishOr(options.landing), () => Restore);
  const traversalReadLimit = Option.getOrElse(
    Option.fromNullishOr(options.traversalReadLimit),
    () => defaultTraversalReadLimit,
  );
  const drawing = drawingOf(options.host);
  const pending = new Set<Request>();
  let closed = false;
  let mounted: Option.Option<Mounted<R | N>> = Option.none();
  /** The leave prompt in progress. A newer request that moves supersedes it. */
  let prompt = Option.none<Deferred.Deferred<void>>();
  /** Admitted requests that would really move: only these supersede a prompt. */
  const movers = new Set<Request>();
  /** Landings waiting for their shell to draw. A newer request that moves supersedes each. */
  const drawings = new Set<Deferred.Deferred<void>>();
  /** How many requests that move were admitted: a landing places only if none came after it. */
  let admittedMovers = 0;
  /** The count each request saw at its admission, its own included. */
  const admittedAt = new WeakMap<Request, number>();
  const registry = yield* Effect.serviceOption(Inspection.Registry);
  let routerOwner = Option.none<Inspection.OwnerToken>();
  if (Option.isSome(registry)) {
    routerOwner = Option.some(yield* Inspection.ownerFor(registry.value));
  }

  /** A request from an instance that is no longer shown is stale. */
  const isLive = (request: Extract<Request, { readonly operation: "push" | "replace" }>) =>
    Option.isNone(request.instance) ||
    (Option.isSome(mounted) && mounted.value.entered.instance === request.instance.value);

  /** The URL a push or replace asks for, from the committed one. */
  const requested = (
    request: Extract<Request, { readonly operation: "push" | "replace" }>,
    base: URL,
  ): URL => {
    let href: string;
    if (isUrlUpdater(request.href)) {
      href = request.href(new URL(base.href));
    } else {
      href = request.href;
    }
    return new URL(href, base);
  };

  /**
   * Whether a request would really move. A platform move always does. A
   * push or replace does when it comes from the live instance (or from no
   * instance) and resolves to another URL than the committed one: a same-URL
   * request, a stale instance's request, or a url-state write that changes
   * nothing is not a newer intent, and must not end an open prompt.
   */
  const moves = (request: Request): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      if (request.operation !== "push" && request.operation !== "replace") {
        return true;
      }
      if (!isLive(request)) {
        return false;
      }
      const base = yield* location.current;
      return requested(request, base).href !== base.href;
    });

  /**
   * Queue a request. A leave prompt in progress is superseded when the
   * request would move: it is the latest intent, so an earlier prompt's
   * answer can never decide it. False when the router is closed.
   */
  const admit = (request: Request) =>
    Effect.gen(function* () {
      // A traversal never arrives here once the router closes: the
      // traversal source's consumer closes first and lets every held one
      // through (see `traversal.ts`).
      if (closed) {
        return false;
      }
      pending.add(request);
      const offered = yield* Queue.offer(requests, request);
      if (!offered) {
        pending.delete(request);
        yield* Deferred.succeed(request.done, Exit.succeed(Option.none()));
        return false;
      }
      if (!(yield* moves(request))) {
        admittedAt.set(request, admittedMovers);
        return true;
      }
      movers.add(request);
      admittedMovers += 1;
      admittedAt.set(request, admittedMovers);
      yield* Option.match(prompt, {
        onNone: () => Effect.void,
        onSome: (newer) => Effect.asVoid(Deferred.succeed(newer, void 0)),
      });
      for (const waiting of drawings) {
        yield* Deferred.succeed(waiting, void 0);
      }
      return true;
    });

  const submit = (request: Request) =>
    Effect.gen(function* () {
      if (!(yield* admit(request))) {
        return Option.none<NavigationResult>();
      }
      const outcome = yield* Deferred.await(request.done);
      return yield* Exit.match(outcome, {
        onFailure: (cause) => Effect.failCause(cause),
        onSuccess: (result) => Effect.succeed(result),
      });
    });

  const enqueue = (
    operation: "push" | "replace",
    href: string | UrlUpdater,
    instance?: RouteInstance,
  ) =>
    Effect.gen(function* () {
      const done = yield* Deferred.make<Exit.Exit<Option.Option<NavigationResult>, never>>();
      return yield* submit({ operation, href, instance: Option.fromNullishOr(instance), done });
    });

  // Platform moves are queued without waiting, so a later one can
  // supersede an earlier one's leave prompt.
  const enqueuePop = () =>
    Effect.gen(function* () {
      const done = yield* Deferred.make<Exit.Exit<Option.Option<NavigationResult>, never>>();
      yield* admit({ operation: "pop", done });
    });

  const enqueueTraversal = (traversal: Traversal) =>
    Effect.gen(function* () {
      const done = yield* Deferred.make<Exit.Exit<Option.Option<NavigationResult>, never>>();
      yield* admit({ operation: "traverse", traversal, done });
    });

  /** A request the router's close ended has no result: it is interrupted. */
  const received = (result: Option.Option<NavigationResult>): Effect.Effect<NavigationResult> =>
    Option.match(result, {
      onNone: () => Effect.interrupt,
      onSome: Effect.succeed,
    });

  const service: RouterService = {
    navigate: (href) => Effect.asVoid(enqueue("push", href)),
    replace: (href) => Effect.asVoid(enqueue("replace", href)),
    navigations: {
      get: Effect.map(SubscriptionRef.get(navigations), navigationOf),
      changes: Stream.map(SubscriptionRef.changes(navigations), navigationOf),
    },
    current: {
      get: Effect.map(SubscriptionRef.get(navigations), (moved) => ({
        name: moved.routeName,
        url: moved.url,
      })),
      changes: Stream.map(SubscriptionRef.changes(navigations), (moved) => ({
        name: moved.routeName,
        url: moved.url,
      })),
    },
  };

  const navigation: RouteNavigation = {
    navigate: (href, instance) => Effect.asVoid(enqueue("push", href, instance)),
    replace: (href, instance) => Effect.asVoid(enqueue("replace", href, instance)),
  };
  registerReceipts(service, {
    navigate: (href, instance) => Effect.flatMap(enqueue("push", href, instance), received),
    replace: (href, instance) => Effect.flatMap(enqueue("replace", href, instance), received),
  });

  /**
   * The Router a check sees: it reads where the document is, but it cannot
   * move. The queue fiber runs the check, so a move would wait on itself.
   */
  const refuse = (href: string | UrlUpdater) =>
    Effect.die(
      CheckNavigation.make({
        href: Option.getOrElse(Option.liftPredicate(href, Predicate.isString), () => "<updater>"),
      }),
    );
  const checkService: RouterService = { ...service, navigate: refuse, replace: refuse };

  /**
   * Run the candidate route's checks and follow redirects before history
   * moves, so a denied URL never becomes an entry. Each hop is matched
   * again from the top: a redirect may leave the route that asked for it.
   * A repeated URL or too many hops is a defect of this navigation.
   */
  const settleFrom = (
    candidate: URL,
    kind: NavigationKind,
    chain: ReadonlyArray<string>,
  ): Effect.Effect<
    Settled<R | N>,
    never,
    Exclude<Exclude<Exclude<R | N, Router>, UrlStateRuntime>, Scope.Scope>
  > =>
    Effect.gen(function* () {
      const target = resolve(routes, fallback, candidate, navigation);
      const checks = readChecks(target.route);
      if (Option.isNone(checks)) {
        return { url: candidate, target };
      }
      // Each check runs in its own temporary Scope, closed before the answer is used.
      const verdict = yield* checks
        .value(candidate, kind)
        .pipe(Effect.provideService(Router, checkService), Effect.scoped);
      if (verdict._tag === "Continue") {
        return { url: candidate, target };
      }
      const next = new URL(verdict.href, candidate);
      const visited = [...chain, next.href];
      if (chain.includes(next.href)) {
        return yield* Effect.die(RedirectCycle.make({ chain: visited, reason: "repeated" }));
      }
      if (chain.length > redirectLimit) {
        return yield* Effect.die(RedirectCycle.make({ chain: visited, reason: "limit" }));
      }
      return yield* settleFrom(next, kind, visited);
    });

  /** The route a server settlement chose, as this mount's own target. */
  const presettled = (given: SettledRoute): Settled<R | N> => {
    const route = Option.getOrElse(
      Option.flatMap(given.route, (chosen) =>
        Option.fromNullishOr(routes.find((candidate) => candidate === chosen)),
      ),
      () => fallback,
    );
    return {
      url: given.url,
      target: {
        route,
        enter: Option.getOrElse(route.enter(given.url, navigation), () =>
          Effect.die("the settled route does not match its URL"),
        ),
      },
    };
  };

  const settle = (url: URL, kind: NavigationKind) =>
    Effect.gen(function* () {
      const committed = yield* SubscriptionRef.get(navigations);
      if (kind !== "initial" && fragmentOnly(url, committed.url)) {
        const settled: Settled<R | N> = {
          url,
          target: resolve(routes, fallback, url, navigation),
        };
        return settled;
      }
      return yield* settleFrom(url, kind, [url.href]);
    });

  const show = (url: URL, resolved?: Resolved<R | N>) =>
    Effect.gen(function* () {
      const target = resolved ?? resolve(routes, fallback, url, navigation);
      // A stayed route publishes the URL into its instance. An instance that
      // answers false cannot stay, so the route is entered again below.
      if (Option.isSome(mounted) && mounted.value.route === target.route) {
        const stayed = mounted.value.entered;
        const kept = yield* stayed.update(url);
        if (kept) {
          return yield* shellOf(stayed, false);
        }
      }
      const child = yield* Scope.fork(scope);
      const outcome = yield* Effect.exit(
        Scope.provide(
          Effect.gen(function* () {
            const entered = yield* target.enter;
            const enteredInstance = Option.fromNullishOr(entered.instance);
            const instance = Option.getOrElse(enteredInstance, newRouteInstance);
            const mountedEntered = Option.match(enteredInstance, {
              onNone: () => ({ ...entered, instance }),
              onSome: () => entered,
            });
            const phase = yield* Ref.make<"entering" | "mounted">("entering");
            let routeOwner = Option.none<Inspection.OwnerToken>();
            if (Option.isSome(registry)) {
              routeOwner = Option.some(registry.value.makeOwner(routerOwner));
            }
            let routeInstanceId = Option.none<string>();
            if (Option.isSome(registry) && Option.isSome(routeOwner)) {
              const registration = yield* registry.value.register(routeOwner.value, (id) =>
                Effect.gen(function* () {
                  const mountedPhase = yield* Ref.get(phase);
                  const decoded = yield* Option.match(readInspection(mountedEntered), {
                    onNone: () =>
                      Effect.succeed({
                        params: unavailableInspection,
                        search: unavailableInspection,
                      }),
                    onSome: (read) => read,
                  });
                  const canonical = yield* SubscriptionRef.get(navigations);
                  return {
                    _tag: "Route",
                    id,
                    ownerId: routeOwner.value.id,
                    parentOwnerId: routeOwner.value.parentId,
                    routerId: Option.getOrThrow(Option.map(routerOwner, (owner) => owner.id)),
                    routeInstanceId: id,
                    routeName: target.route.name,
                    phase: mountedPhase,
                    params: decoded.params,
                    search: decoded.search,
                    canonicalRouteName: canonical.routeName,
                    canonicalUrl: canonical.url.href,
                  };
                }),
              );
              routeInstanceId = Option.some(registration);
            }
            const urlStateRuntime = makeUrlStateRuntime(
              service,
              navigation,
              target.route.searchKeys,
              instance,
              routeInstanceId,
              Effect.map(SubscriptionRef.get(navigations), (current) => current.url),
            );
            const page = () =>
              Effect.provideService(
                Effect.provideService(entered.setup, Router, service),
                UrlStateRuntime,
                urlStateRuntime,
              );
            let mountedPage = View.mount(page, {}, drawing.host, options.root);
            if (Option.isSome(routeOwner)) {
              mountedPage = Effect.provideService(mountedPage, Inspection.Owner, routeOwner.value);
            }
            yield* mountedPage;
            yield* Ref.set(phase, "mounted");
            return { route: target.route, entered: mountedEntered };
          }),
          child,
        ).pipe(
          Effect.onExit((exit) =>
            Exit.match(exit, {
              onFailure: (cause) => Scope.close(child, Exit.failCause(cause)),
              onSuccess: () => Effect.void,
            }),
          ),
        ),
      );
      return yield* Exit.match(outcome, {
        onFailure: (cause) => Effect.failCause(cause),
        onSuccess: (next) => {
          const previous = mounted;
          mounted = Option.some({ ...next, scope: child });
          return Effect.andThen(
            Option.match(previous, {
              onNone: () => Effect.void,
              onSome: (shown) => Scope.close(shown.scope, Exit.void),
            }),
            shellOf(next.entered, true),
          );
        },
      });
    });

  /** Publish the move and show it. The result is the committed shell. */
  const move = (settled: Settled<R | N>, kind: Navigation["kind"]) =>
    Effect.gen(function* () {
      yield* SubscriptionRef.set(navigations, {
        url: settled.url,
        kind,
        routeName: settled.target.route.name,
      });
      return yield* show(settled.url, settled.target);
    });

  /**
   * Wait for the shell to be drawn (shell commit), then resolve it against
   * the router's default. Focus is offered only when the deepest segment
   * entered: a stayed leaf keeps focus. None: a newer request that moves
   * arrived first, and this move places nothing.
   *
   * A traversal waits for its declared reads as well (`until` is
   * `"settled"`): it returns to a saved position in the content, which a
   * shell still waiting for that content cannot reach. A push or replace
   * lands at shell commit.
   */
  const landingOf = (shell: Shell, self: Request, until: LandingPoint) =>
    Effect.gen(function* () {
      // Any request that moves admitted after this one, whether it is still
      // queued, already done, or admitted after the shell drew, changes the
      // count this one saw at its admission.
      const seen = Option.getOrElse(
        Option.fromNullishOr(admittedAt.get(self)),
        () => admittedMovers,
      );
      const newer = yield* Deferred.make<void>();
      drawings.add(newer);
      if (admittedMovers !== seen) {
        yield* Deferred.succeed(newer, void 0);
      }
      const reached = Effect.andThen(
        shell.drawn,
        reachedAfterDrawn(shell, until, traversalReadLimit, drawing.catchUp),
      );
      const drew = yield* Effect.raceFirst(
        Effect.as(reached, true),
        Effect.as(Deferred.await(newer), false),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            drawings.delete(newer);
          }),
        ),
      );
      if (!drew) {
        return Option.none<Landing>();
      }
      // The row that drew the last view builds its nodes on its own fiber
      // right after its setup returned: let it finish, then flush.
      yield* Effect.yieldNow;
      yield* View.flush;
      let focus = Effect.succeed(Option.none<unknown>());
      if (shell.entered) {
        focus = shell.root;
      }
      const landing: Landing = {
        behavior: Option.getOrElse(shell.behavior, () => defaultBehavior),
        focus: yield* focus,
      };
      // Checked at placement: a request admitted while this one drew,
      // yielded, or flushed is the latest navigation, and this one places
      // nothing. No yield separates this check from the placement.
      if (admittedMovers !== seen) {
        return Option.none<Landing>();
      }
      return Option.some(landing);
    });

  /**
   * At shell commit, place the landing and release the move. It runs beside
   * the queue, on the router's Scope: the next request never waits for a
   * view to draw, and a move that never draws is released when a newer one
   * arrives, or when the router closes.
   */
  const landAfter = (
    shell: Shell,
    self: Request,
    landOn: (landing: Option.Option<Landing>) => Effect.Effect<void>,
    until: LandingPoint = "drawn",
  ) =>
    Effect.asVoid(
      Effect.forkIn(
        Effect.flatMap(landingOf(shell, self, until), landOn).pipe(
          Effect.onExit((exit) => {
            if (Exit.isSuccess(exit)) {
              return Effect.void;
            }
            return landOn(Option.none());
          }),
        ),
        scope,
      ),
    );

  /** Write history for the router's own move, and get that write's handle. */
  const write = (kind: WriteKind, url: URL): Effect.Effect<Written> =>
    Option.match(surface, {
      onNone: () => Effect.as(location[kind](url), unplaced),
      onSome: (one) => one.write(kind, url),
    });

  /**
   * A redirect replaces the entry another move already committed. It places
   * nothing itself (the move it serves lands), and is released once that
   * move's view is shown or failed.
   */
  const redirected = (from: URL, settled: Settled<R | N>): Effect.Effect<Written> => {
    if (settled.url.href === from.href) {
      return Effect.succeed(unplaced);
    }
    return write("replace", settled.url);
  };

  const released = (written: Written) => written.land(Option.none());

  /** Place a followed pop. A Location without a surface places nothing. */
  const landPop = (landing: Option.Option<Landing>) =>
    Option.match(surface, {
      onNone: () => Effect.void,
      onSome: (one) => one.pop(landing),
    });

  /**
   * The leave checks the mounted route would ask for `url`, deepest first.
   * Collecting them asks nothing.
   */
  const questionsFor = (url: URL, route: AnyRoute<R | N>, kind: LeaveKind) =>
    Option.match(mounted, {
      onNone: () => Effect.succeed<ReadonlyArray<Question>>([]),
      onSome: (shown) =>
        Option.match(readLeave(shown.entered), {
          onNone: () => Effect.succeed<ReadonlyArray<Question>>([]),
          onSome: (asker) => asker({ destination: url, kind, stays: shown.route === route }),
        }),
    });

  /** Ask in order and stop at the first `Stay`. */
  const ask = (questions: ReadonlyArray<Question>) =>
    Effect.gen(function* () {
      for (const question of questions) {
        const verdict = yield* question(checkService);
        if (verdict._tag === "Stay") {
          return verdict;
        }
      }
      return Leave;
    });

  /**
   * Ask the old page whether it may leave for a settled candidate, before
   * any destination data opens and before history moves. Each check runs in
   * its own temporary Scope. A newer request, or the platform abandoning
   * the traversal, interrupts the prompt: its Scope closes, and its answer,
   * if it ever comes, decides nothing.
   */
  const decide = (
    settled: Settled<R | N>,
    kind: LeaveKind,
    abandoned: Effect.Effect<void>,
    self: Request,
  ) =>
    Effect.gen(function* () {
      const questions = yield* questionsFor(settled.url, settled.target.route, kind);
      if (questions.length === 0) {
        const leave: Decision = Leave;
        return leave;
      }
      const newer = yield* Deferred.make<void>();
      prompt = Option.some(newer);
      if (Array.from(movers).some((other) => other !== self)) {
        // A request that moves is already waiting behind this one.
        yield* Deferred.succeed(newer, void 0);
      }
      return yield* Effect.raceFirst(
        Effect.map(ask(questions), (verdict): Decision => verdict),
        Effect.as(Effect.raceFirst(Deferred.await(newer), abandoned), superseded),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            prompt = Option.none();
          }),
        ),
      );
    });

  /**
   * The platform moved, or will move whatever the router answers: no check
   * can keep the page. Follow it, and report when a registered check would
   * have been asked. There is no `history.go` compensation.
   */
  const reportUnprotected = (settled: Settled<R | N>, reason: Unprotected) =>
    Effect.gen(function* () {
      const questions = yield* questionsFor(settled.url, settled.target.route, "pop");
      if (questions.length > 0) {
        yield* Effect.logWarning(
          `route.leave.unprotected url=${settled.url.href} kind=pop checks=${String(questions.length)} reason=${reason}`,
        );
      }
    });

  const committedPop = (
    self: Request,
    reason: Unprotected,
    landOn: (landing: Option.Option<Landing>) => Effect.Effect<void>,
    until: LandingPoint,
  ) =>
    Effect.gen(function* () {
      const url = yield* location.current;
      const settled = yield* settle(url, "pop");
      yield* reportUnprotected(settled, reason);
      // A redirected pop has already moved, so its denied entry is replaced.
      const redirect = yield* redirected(url, settled);
      const shell = yield* move(settled, "pop").pipe(Effect.ensuring(released(redirect)));
      yield* landAfter(shell, self, landOn, until);
      return Committed(settled.url);
    });

  /**
   * A traversal before commit. With protection, the checks settle and the
   * page is asked first; `Stay` refuses the platform move. Without it, the
   * platform commits and the router follows.
   */
  const traverse = (request: Extract<Request, { readonly operation: "traverse" }>) => {
    const traversal = request.traversal;
    /** True once a committed shell's landing owns `finish`. */
    let handed = false;
    /** Place the landing, then let the platform finish: its handler fulfills. */
    const landThenFinish = (landing: Option.Option<Landing>) =>
      Effect.andThen(
        Option.match(landing, { onNone: () => Effect.void, onSome: traversal.land }),
        traversal.finish,
      );
    const handOver = (shell: Shell) =>
      Effect.andThen(
        Effect.sync(() => {
          handed = true;
        }),
        landAfter(shell, request, landThenFinish, "settled"),
      );
    return Effect.gen(function* () {
      const committed = (yield* SubscriptionRef.get(navigations)).url;
      if (traversal.protection === "none") {
        if (!(yield* traversal.leave)) {
          return Unchanged(committed);
        }
        const followed = yield* committedPop(request, "noncancelable", landThenFinish, "settled");
        handed = true;
        return followed;
      }
      const url = traversal.destination;
      const settled = yield* settle(url, "pop");
      const decision = yield* decide(settled, "pop", traversal.abandoned, request);
      if (decision._tag !== "Leave") {
        yield* traversal.stay;
        if (decision._tag === "Stay") {
          return Stayed(committed);
        }
        return Unchanged(committed);
      }
      if (!(yield* traversal.leave)) {
        return Unchanged(committed);
      }
      const redirect = yield* redirected(url, settled);
      yield* handOver(yield* move(settled, "pop").pipe(Effect.ensuring(released(redirect))));
      return Committed(settled.url);
    }).pipe(
      // A failure or a defect refuses a protected move before it is let
      // through: the platform must not commit a URL the router never showed.
      // `stay` after a `leave` changes nothing, so an unprotected traversal,
      // let through first, is unaffected. Interruption is root close:
      // the traversal source's consumer, which closes first, lets it through.
      // A committed shell's landing finishes it instead, after placing.
      Effect.onExit((exit) => {
        if (Exit.isSuccess(exit)) {
          if (handed) {
            return Effect.void;
          }
          return traversal.finish;
        }
        if (Cause.hasInterruptsOnly(exit.cause)) {
          return Effect.void;
        }
        return Effect.andThen(traversal.stay, traversal.finish);
      }),
    );
  };

  const controlled = (request: Extract<Request, { readonly operation: "push" | "replace" }>) =>
    Effect.gen(function* () {
      const base = yield* location.current;
      if (!isLive(request)) {
        return Unchanged(base);
      }
      const url = requested(request, base);
      if (url.href === base.href) {
        return Unchanged(base);
      }
      const settled = yield* settle(url, request.operation);
      if (settled.url.href === base.href) {
        return Unchanged(base);
      }
      const decision = yield* decide(settled, request.operation, Effect.never, request);
      if (decision._tag === "Stay") {
        return Stayed(base);
      }
      if (decision._tag === "Superseded") {
        return Unchanged(base);
      }
      // History moves once, to the settled URL. This write, and no other,
      // lands this move.
      const written = yield* write(request.operation, settled.url);
      // A failed show still releases the move: the Location places nothing.
      const shell = yield* Effect.onError(move(settled, request.operation), () =>
        released(written),
      );
      yield* landAfter(shell, request, written.land);
      return Committed(settled.url);
    });

  type MountServices = Exclude<Exclude<Exclude<R | N, Router>, UrlStateRuntime>, Scope.Scope>;
  const run = (request: Request): Effect.Effect<NavigationResult, never, MountServices> => {
    if (request.operation === "pop") {
      // The browser restored this pop's position at `popstate`: only focus is left.
      return committedPop(request, "committed", landPop, "drawn");
    }
    if (request.operation === "traverse") {
      return traverse(request);
    }
    return controlled(request);
  };

  const process = (request: Request) =>
    run(request).pipe(
      Effect.exit,
      Effect.flatMap((outcome) =>
        Effect.andThen(
          Deferred.succeed(request.done, Exit.map(outcome, Option.some)),
          Effect.sync(() => {
            pending.delete(request);
            movers.delete(request);
          }),
        ),
      ),
    );

  // A server document settled the request already, checks included: the
  // router shows that route, and runs no check twice.
  const initialSettled = yield* Option.match(yield* SettledRequest, {
    onNone: () => settle(initial, "initial"),
    onSome: (given) => Effect.sync(() => presettled(given)),
  });
  // The document already holds the initial entry: a redirect replaces it.
  // A first load places nothing (the browser's own load did), so the
  // replace is released once the view is shown or failed.
  const initialRedirect = yield* redirected(initial, initialSettled);
  const initialNavigation: NavigationSample = {
    url: initialSettled.url,
    kind: "initial",
    routeName: initialSettled.target.route.name,
  };
  yield* SubscriptionRef.set(navigations, initialNavigation);
  yield* show(initialSettled.url, initialSettled.target).pipe(
    Effect.ensuring(released(initialRedirect)),
  );
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closed = true;
      const waiting = Array.from(pending);
      pending.clear();
      movers.clear();
      yield* Effect.forEach(
        waiting,
        (request) => Deferred.succeed(request.done, Exit.succeed(Option.none())),
        {
          discard: true,
        },
      );
      yield* Queue.shutdown(requests);
    }),
  );
  yield* Effect.forkScoped(
    Stream.runForEach(Stream.fromQueue(requests), (request) => process(request)),
  );
  yield* Effect.forkScoped(Stream.runForEach(location.pops, () => enqueuePop()));
  // The one consumer of this Location's traversals, for this router's
  // lifetime. Its close lets through every traversal still held.
  yield* Option.match(readTraversals(location), {
    onNone: () => Effect.void,
    onSome: (source) =>
      Effect.flatMap(source.consume, (traversals) =>
        Effect.asVoid(
          Effect.forkScoped(
            Stream.runForEach(traversals, (traversal) => enqueueTraversal(traversal)),
          ),
        ),
      ),
  });
  return service;
});

// ---------------------------------------------------------------------------
// Server settlement (#18 §3.3; see docs/design/route-data.md)
// ---------------------------------------------------------------------------

/** A request's route, after its checks. None: not-found. */
export interface SettledRoute {
  readonly url: URL;
  readonly route: Option.Option<AnyRoute<unknown>>;
}

/**
 * Internal: the server document provides the settlement it made, so the
 * router it mounts shows that route and runs no check again.
 */
export const SettledRequest = Context.Reference<Option.Option<SettledRoute>>(
  "effect-frame/router/router/SettledRequest",
  { defaultValue: () => Option.none() },
);

/** How a server request settles: show a route, or answer with a redirect. */
export type Settlement<R> =
  | {
      readonly _tag: "Continue";
      readonly url: URL;
      /** None: no route matched, and not-found shows. */
      readonly route: Option.Option<AnyRoute<R>>;
    }
  | { readonly _tag: "Redirect"; readonly location: URL };

/** The Router a server check sees: the request URL, and no move. */
const serverRouter = (url: URL): RouterService => {
  const refuse = (href: string | UrlUpdater) =>
    Effect.die(
      CheckNavigation.make({
        href: Option.getOrElse(Option.liftPredicate(href, Predicate.isString), () => "<updater>"),
      }),
    );
  const navigation: Navigation = { url, kind: "initial" };
  const match: RouteMatch = { name: "not-found", url };
  return {
    navigate: refuse,
    replace: refuse,
    navigations: { get: Effect.succeed(navigation), changes: Stream.make(navigation) },
    current: { get: Effect.succeed(match), changes: Stream.make(match) },
  };
};

/**
 * Settle one server request: match the URL as `mount` does, then run the
 * matched route's checks, parent first, as `mount` does for its first
 * navigation. A redirect is the server's answer, not a hop to follow: the
 * browser asks for the target in its own request, and that request runs
 * the target's checks. A redirect to the request URL itself is the
 * `RedirectCycle` defect. The checks run in the caller's Scope, which the
 * server document closes once the drawing has declared its own data.
 */
export const settleRequest = <R>(
  routes: ReadonlyArray<AnyRoute<R>>,
  url: URL,
): Effect.Effect<
  Settlement<R>,
  never,
  Exclude<Exclude<Exclude<R, Router>, UrlStateRuntime>, Scope.Scope> | Scope.Scope
> =>
  Effect.gen(function* () {
    const route = Option.fromNullishOr(
      routes.find((candidate) => Option.isSome(candidate.enter(url))),
    );
    const checks = Option.flatMap(route, readChecks);
    if (Option.isNone(checks)) {
      return { _tag: "Continue", url, route };
    }
    // The check's interests live in the caller's Scope: a query it read
    // stays in the request cache until the drawing has declared its own.
    const verdict = yield* checks
      .value(url, "initial")
      .pipe(Effect.provideService(Router, serverRouter(url)));
    if (verdict._tag === "Continue") {
      return { _tag: "Continue", url, route };
    }
    const location = new URL(verdict.href, url);
    if (location.href === url.href) {
      return yield* Effect.die(
        RedirectCycle.make({ chain: [url.href, location.href], reason: "repeated" }),
      );
    }
    return { _tag: "Redirect", location };
  });

/**
 * Where a landing is placed: at shell commit (`drawn`), or once the drawn
 * branch's declared reads settled as well (`settled`, a traversal).
 */
type LandingPoint = "drawn" | "settled";

/**
 * After shell commit. A traversal waits for the branch's declared reads,
 * or for `limit`, whichever is first, then brings the drawing to its
 * sources: a value travels from a source to the drawing on a fiber, so
 * without the catch-up the saved position would be placed against a page
 * that has not drawn what its reads hold. At the limit the reads are not
 * waited on again: the landing is placed once.
 */
const reachedAfterDrawn = (
  shell: Shell,
  until: LandingPoint,
  limit: Duration.Input,
  catchUp: Effect.Effect<void>,
): Effect.Effect<void> => {
  if (until === "settled") {
    return Effect.andThen(Effect.raceFirst(shell.settled, Effect.sleep(limit)), catchUp);
  }
  return Effect.void;
};

/**
 * The router's host, and a way to bring its drawing to its sources now.
 * Every source the mounted pages bind reports itself through the host's
 * `sourceBound`; `catchUp` writes each one's current value where the
 * drawing shows another, and flushes. A host that counts its own bindings
 * (the server drawing) still hears each one.
 */
interface Drawing<HostNode> {
  readonly host: Host<HostNode>;
  readonly catchUp: Effect.Effect<void>;
}

const drawingOf = <HostNode>(host: Host<HostNode>): Drawing<HostNode> => {
  const live = new Set<{ readonly catchUp: () => void }>();
  const own = (catchUp: () => void): (() => void) => {
    const one = { catchUp };
    live.add(one);
    return () => void live.delete(one);
  };
  const sourceBound = Option.match(Option.fromNullishOr(host.sourceBound), {
    onNone: () => own,
    onSome:
      (theirs) =>
      (catchUp: () => void): (() => void) => {
        const ours = own(catchUp);
        const their = theirs(catchUp);
        return () => {
          ours();
          their();
        };
      },
  });
  return {
    host: { ...host, sourceBound },
    catchUp: Effect.andThen(
      Effect.sync(() => {
        // A catch-up may draw a branch that binds more sources: those read
        // their current value when they bind.
        for (const one of Array.from(live)) {
          one.catchUp();
        }
      }),
      View.flush,
    ),
  };
};

/** A write nothing waits on: landing it places nothing. */
const unplaced: Written = { land: () => Effect.void };

const isUrlUpdater = (href: string | UrlUpdater): href is UrlUpdater => Predicate.isFunction(href);

/** What a mounted route reports; a route the framework did not build reports only whether it is new. */
const shellOf = <R>(entered: Entered<R>, fresh: boolean): Effect.Effect<Shell> =>
  Option.getOrElse(readShell(entered), () =>
    Effect.succeed<Shell>({
      entered: fresh,
      behavior: Option.none(),
      root: Effect.succeed(Option.none()),
      drawn: Effect.void,
      settled: Effect.void,
    }),
  );

const navigationOf = ({ url, kind }: NavigationSample): Navigation => ({ url, kind });
