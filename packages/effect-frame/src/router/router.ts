import type { Source } from "effect-frame/actor";
import type { Host, View } from "effect-frame/view";
import { mount as mountView } from "effect-frame/view";
import { read as readInspection, register as registerInspection } from "./route-inspection.js";
import {
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
import type { AnyRoute, Entered, RouteInstance, RouteNavigation, UrlUpdater } from "./route.js";
import {
  Runtime as UrlStateRuntime,
  makeRuntime as makeUrlStateRuntime,
} from "./url-state-runtime.js";
import * as Inspection from "../inspection.js";
import type { NavigationKind } from "./check.js";
import { CheckNavigation, RedirectCycle, read as readChecks, redirectLimit } from "./check.js";
import type { NavigationResult } from "./receipt.js";
import { Committed, Unchanged, register as registerReceipts } from "./receipt.js";

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

/** Which route the document is on, and at what URL. */
export interface Match {
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
  readonly current: Source<Match>;
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
}

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
        const entered: Entered<R> = {
          instance: { _tag: "RouteInstance" },
          setup: view({
            url: { get: SubscriptionRef.get(current), changes: SubscriptionRef.changes(current) },
          }),
          update: (next) => Effect.as(SubscriptionRef.set(current, next), true),
        };
        registerInspection(entered, Effect.succeed({ params: {}, search: {} }));
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
      readonly operation: "pop";
      readonly done: Outcome;
    };

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
  const pending = new Set<Request>();
  let closed = false;
  let mounted: Option.Option<Mounted<R | N>> = Option.none();
  const registry = yield* Effect.serviceOption(Inspection.Registry);
  let routerOwner = Option.none<Inspection.OwnerToken>();
  if (Option.isSome(registry)) {
    routerOwner = Option.some(yield* Inspection.ownerFor(registry.value));
  }

  const submit = (request: Request) =>
    Effect.gen(function* () {
      if (closed) {
        return Option.none<NavigationResult>();
      }
      pending.add(request);
      const offered = yield* Queue.offer(requests, request);
      if (!offered) {
        pending.delete(request);
        yield* Deferred.succeed(request.done, Exit.succeed(Option.none()));
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

  const enqueuePop = () =>
    Effect.gen(function* () {
      const done = yield* Deferred.make<Exit.Exit<Option.Option<NavigationResult>, never>>();
      yield* submit({ operation: "pop", done });
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
      const next = new URL(verdict.target.href, candidate);
      const visited = [...chain, next.href];
      if (chain.includes(next.href)) {
        return yield* Effect.die(RedirectCycle.make({ chain: visited, reason: "repeated" }));
      }
      if (chain.length > redirectLimit) {
        return yield* Effect.die(RedirectCycle.make({ chain: visited, reason: "limit" }));
      }
      return yield* settleFrom(next, kind, visited);
    });

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
        const kept = yield* mounted.value.entered.update(url);
        if (kept) {
          return;
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
            let mountedPage = mountView(page, {}, options.host, options.root);
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
      yield* Exit.match(outcome, {
        onFailure: (cause) => Effect.failCause(cause),
        onSuccess: (next) => {
          const previous = mounted;
          mounted = Option.some({ ...next, scope: child });
          return Option.match(previous, {
            onNone: () => Effect.void,
            onSome: (shown) => Scope.close(shown.scope, Exit.void),
          });
        },
      });
    });

  const move = (settled: Settled<R | N>, kind: Navigation["kind"]) =>
    Effect.gen(function* () {
      yield* SubscriptionRef.set(navigations, {
        url: settled.url,
        kind,
        routeName: settled.target.route.name,
      });
      yield* show(settled.url, settled.target);
    });

  const process = (request: Request) =>
    Effect.gen(function* () {
      const base = yield* location.current;
      if (
        request.operation !== "pop" &&
        Option.isSome(request.instance) &&
        (Option.isNone(mounted) || mounted.value.entered.instance !== request.instance.value)
      ) {
        return Unchanged(base);
      }
      const current = new URL(base.href);
      let href: string;
      if (request.operation === "pop") {
        href = current.href;
      } else if (isUrlUpdater(request.href)) {
        href = request.href(current);
      } else {
        href = request.href;
      }
      const url = new URL(href, base);
      if (request.operation !== "pop" && url.href === base.href) {
        return Unchanged(base);
      }
      const settled = yield* settle(url, request.operation);
      if (request.operation !== "pop" && settled.url.href === base.href) {
        return Unchanged(base);
      }
      // History moves once, to the settled URL. A redirected pop has already
      // moved, so its denied entry is replaced rather than kept.
      if (request.operation === "push") {
        yield* location.push(settled.url);
      } else if (request.operation === "replace" || settled.url.href !== url.href) {
        yield* location.replace(settled.url);
      }
      yield* move(settled, request.operation);
      return Committed(settled.url);
    }).pipe(
      Effect.exit,
      Effect.flatMap((outcome) =>
        Effect.andThen(
          Deferred.succeed(request.done, Exit.map(outcome, Option.some)),
          Effect.sync(() => {
            pending.delete(request);
          }),
        ),
      ),
    );

  const initialSettled = yield* settle(initial, "initial");
  if (initialSettled.url.href !== initial.href) {
    // The document already holds the initial entry: a redirect replaces it.
    yield* location.replace(initialSettled.url);
  }
  const initialNavigation: NavigationSample = {
    url: initialSettled.url,
    kind: "initial",
    routeName: initialSettled.target.route.name,
  };
  yield* SubscriptionRef.set(navigations, initialNavigation);
  yield* show(initialSettled.url, initialSettled.target);
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closed = true;
      const waiting = Array.from(pending);
      pending.clear();
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
  return service;
});

const isUrlUpdater = (href: string | UrlUpdater): href is UrlUpdater => Predicate.isFunction(href);

const navigationOf = ({ url, kind }: NavigationSample): Navigation => ({ url, kind });

// ---------------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------------

/** The document's own location and history. */
export const browserLocation: LocationService = {
  current: Effect.sync(() => new URL(window.location.href)),
  push: (url) =>
    Effect.sync(() => {
      window.history.pushState({}, "", url.href);
    }),
  replace: (url) =>
    Effect.sync(() => {
      window.history.replaceState({}, "", url.href);
    }),
  // Suspended so that importing the module needs no window.
  pops: Stream.suspend(() =>
    Stream.map(Stream.fromEventListener(window, "popstate"), () => new URL(window.location.href)),
  ),
};

/** The anchor a click landed on, when it is one the router should follow. */
const followable = (event: MouseEvent): Option.Option<HTMLAnchorElement> => {
  if (event.defaultPrevented || event.button !== 0) {
    return Option.none();
  }
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return Option.none();
  }
  const target = event.target;
  if (!(target instanceof Element)) {
    return Option.none();
  }
  const anchor = target.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) {
    return Option.none();
  }
  if (anchor.target === "_blank" || anchor.hasAttribute("download")) {
    return Option.none();
  }
  if (anchor.origin !== window.location.origin) {
    return Option.none();
  }
  return Option.some(anchor);
};

/**
 * One delegated click handler at the root. It intercepts a click only when
 * the browser would have followed a same-origin link in this tab; a middle
 * click, a modifier, `target="_blank"`, a download, and another origin are
 * all left to the browser. A typed Link attaches its queued action to the
 * anchor; this listener handles ordinary anchors and keeps that same policy.
 *
 * The decision and `preventDefault` happen inside the listener, on the
 * browser's own call: a stream would deliver the event after the browser
 * had already followed the link. Only the navigation itself is queued.
 */
export const followLinks = Effect.fn("Router.followLinks")(function* (
  root: EventTarget,
  router: RouterService,
) {
  const hrefs = yield* Queue.unbounded<{ readonly href: string; readonly replace: boolean }>();
  const listener = (event: Event) => {
    if (!(event instanceof MouseEvent)) {
      return;
    }
    Option.match(followable(event), {
      onNone: () => {},
      onSome: (anchor) => {
        event.preventDefault();
        Queue.offerUnsafe(hrefs, {
          href: anchor.href,
          replace: anchor.getAttribute("data-frame-replace") === "true",
        });
      },
    });
  };
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      root.addEventListener("click", listener);
    }),
    () =>
      Effect.sync(() => {
        root.removeEventListener("click", listener);
      }),
  );
  yield* Effect.forkScoped(
    Stream.runForEach(Stream.fromQueue(hrefs), (request) => {
      if (request.replace) {
        return router.replace(request.href);
      }
      return router.navigate(request.href);
    }),
  );
});
