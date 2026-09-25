import type { ScopesClosed, View } from "effect-frame/view";
import { Deferred, Duration, Effect, Exit, Option, Schema, Scope, Stream } from "effect";
import type { ActorTransport, Principal } from "effect-frame/actor/client";
import { CurrentPrincipal, QueryCache } from "effect-frame/actor/client";
import type {
  CacheSource,
  Document,
  Drawing,
  HtmlNode,
  RecordsUnsettled,
} from "../view/hosts/html.js";
import { awaitAllDrawing, renderSeeded, requestCache, streamPrepared } from "../view/hosts/html.js";
import { ResolveBeforeRender } from "./branch.js";
import type { AnyRoute } from "./codec.js";
import { modeOf } from "./codec.js";
import type { RenderingMode } from "./rendering-mode.js";
import { notFoundMode } from "./rendering-mode.js";
import { Restore } from "./navigation-behavior.js";
import type { LocationService, NotFoundProps, Router } from "./router.js";
import { Location, SettledRequest, mount, settleRequest } from "./router.js";
import type { Runtime as UrlStateRuntime } from "./url-state-runtime.js";

/**
 * The router's server document (#18 §3.3 and §6, #22). One request URL, one
 * route tree, one outcome. See `docs/design/route-data.md`.
 *
 * The request settles first: the URL is matched and the matched route's
 * checks run, whatever its mode. A redirect is the answer. Otherwise the
 * settled tree's rendering-mode constructor chooses the pipeline, so a view
 * never branches on the mode, and the router it mounts reuses the
 * settlement instead of running the checks again.
 *
 * Every pipeline but `ClientOnly` mounts the same router the client mounts,
 * on the HTML host, over its own query cache (#28), with a `Location` that
 * stays at the request URL. Every query it reads goes through
 * `ActorTransport` under the `principal` the caller names (#85), so the
 * query's own named policy checks it.
 */

export interface DocumentOptions<R, N = R> {
  readonly routes: ReadonlyArray<AnyRoute<R>>;
  readonly notFound: View.View<NotFoundProps, never, N> & ScopesClosed<N>;
  /** The request URL. */
  readonly url: URL;
  /** The document around the routed markup, as `Html.renderToStream` takes it. */
  readonly document: Document;
  /**
   * The time limit. Required, as in `Html.renderToStream`. The preparation,
   * that is the checks, the declarations, and the first drawing, must end
   * before it completes, or the render fails with `DocumentTimedOut`. After
   * the first drawing, an `AwaitAll` render serializes what it has and a
   * `Streamed` render writes `Closed`: a query still open is read by the
   * client.
   */
  readonly closeWhen: Effect.Effect<void>;
}

/** Which route a document shows. No user route may be named `"not-found"` (`RouteNameRejected`). */
export type DocumentRoute<R> =
  | { readonly _tag: "Matched"; readonly route: AnyRoute<R> }
  | { readonly _tag: "NotFound" };

/** A check redirected: answer `303 See Other` with this `Location`. Nothing was drawn. */
export interface DocumentRedirect {
  readonly _tag: "Redirect";
  readonly location: URL;
}

/** The document to send. */
export interface RenderedDocument<R> {
  readonly _tag: "Rendered";
  readonly route: DocumentRoute<R>;
  /** The settled route's mode. Not-found renders as `notFoundMode` (`SSR`). */
  readonly mode: RenderingMode;
  /** 404 for not-found, 200 otherwise. */
  readonly status: 200 | 404;
  /**
   * The document's chunks. One chunk, except for `Streamed`, whose later
   * records come from the request Scope: run the body before it closes.
   */
  readonly body: Stream.Stream<string>;
}

/** What `renderDocument` answers. */
export type DocumentOutcome<R> = DocumentRedirect | RenderedDocument<R>;

/**
 * The time limit completed before the document was prepared: a check, a
 * declaration, or the first drawing had not ended. Nothing was written, and
 * everything the render started is closed. `phase` says which step waited.
 * `agree`: the drawing and the seed written beside it did not come to one
 * instant, because a query kept moving; a document whose
 * seed the markup does not show is never written.
 */
export class DocumentTimedOut extends Schema.TaggedError<DocumentTimedOut>()("DocumentTimedOut", {
  phase: Schema.Literals(["settle", "draw", "agree"]),
}) {}

/** A drawing whose records did not agree at the limit fails as `DocumentTimedOut`. Internal. */
export const agreedInTime = <A, R>(
  effect: Effect.Effect<A, DocumentTimedOut | RecordsUnsettled, R>,
): Effect.Effect<A, DocumentTimedOut, R> =>
  Effect.catchTag(effect, "RecordsUnsettled", () =>
    Effect.fail(DocumentTimedOut.make({ phase: "agree" })),
  );

/** What the router's mount needs once the request `Location` is provided. */
type Mounted<R> = Exclude<
  Exclude<Exclude<Exclude<R, Router>, UrlStateRuntime>, Scope.Scope>,
  Location
>;

/** What a document needs: the views' services the router does not provide, and a transport. */
export type DocumentServices<R> = Exclude<Mounted<R>, QueryCache> | ActorTransport;

/** What the pipelines need before the drawing's Scope is provided. */
type PreparedServices<R, N> =
  | Exclude<Mounted<R> | Mounted<N> | Scope.Scope, QueryCache>
  | ActorTransport;

/** A server render does not move: the URL stays the request's. */
const requestLocation = (url: URL): LocationService => ({
  current: Effect.succeed(url),
  push: () => Effect.void,
  replace: () => Effect.void,
  pops: Stream.never,
});

/**
 * What a settled request hands the pipeline that prepares its body: the
 * routed drawing, the same drawing resolving its declared data first, the
 * release of the checks' interests, the time limit, and the request cache.
 */
interface Pipelines<R, N> {
  readonly routed: Drawing<DocumentTimedOut, Mounted<R> | Mounted<N> | Scope.Scope>;
  readonly resolvedFirst: Drawing<DocumentTimedOut, Mounted<R> | Mounted<N> | Scope.Scope>;
  readonly releaseChecks: Effect.Effect<void>;
  readonly closeWhen: Effect.Effect<void>;
  readonly shared: CacheSource;
}

/** A request that settled on a document, and the body its pipeline prepared. */
export interface Prepared<R, A> {
  readonly _tag: "Prepared";
  readonly route: DocumentRoute<R>;
  readonly mode: RenderingMode;
  readonly status: 200 | 404;
  readonly body: A;
}

/**
 * Settle one request, then prepare its body with `prepare`, over the cache
 * `cacheOf` gives. `renderDocument` prepares by the settled mode over a
 * cache of its own; the prerender build prepares an `AwaitAll` page over the
 * build's one cache. Internal: see `docs/design/prerender.md`.
 */
export const settleAndPrepare = <R, N, A>(
  options: DocumentOptions<R, N>,
  cacheOf: CacheSource,
  prepare: (
    mode: RenderingMode,
    pipelines: Pipelines<R, N>,
  ) => Effect.Effect<A, DocumentTimedOut, PreparedServices<R, N>>,
): Effect.Effect<
  DocumentRedirect | Prepared<R, A>,
  DocumentTimedOut,
  DocumentServices<R> | DocumentServices<N> | Scope.Scope
> =>
  Effect.gen(function* () {
    const request = yield* Effect.scope;
    const limit = yield* Deferred.make<void>();
    yield* Effect.forkIn(
      Effect.andThen(options.closeWhen, Deferred.succeed(limit, void 0)),
      request,
    );
    const closeWhen = Deferred.await(limit);
    /** Fails at the limit; the race interrupts whatever it bounds. */
    const timedOut = (phase: DocumentTimedOut["phase"]) =>
      Effect.andThen(closeWhen, Effect.fail(DocumentTimedOut.make({ phase })));

    // One query cache per request (#28), in the request Scope: the checks
    // and the drawing read through it, so a query both read is read once
    // and seeded once.
    const cache = yield* cacheOf;
    const shared = Effect.succeed(cache);
    // What the render opens lives in `opened`, closed at once on a failure.
    // The checks' interests live in `checks`, closed once the drawing has
    // declared its own: a query only a check read is never seeded.
    const opened = yield* Scope.fork(request);
    const checks = yield* Scope.fork(opened);
    const releaseChecks = Scope.close(checks, Exit.void);
    const prepared = Effect.gen(function* () {
      const settlement = yield* Effect.raceFirst(
        settleRequest(options.routes, options.url).pipe(
          Effect.provideService(Location, requestLocation(options.url)),
          Effect.provideService(QueryCache, cache),
          Scope.provide(checks),
        ),
        timedOut("settle"),
      );
      if (settlement._tag === "Redirect") {
        yield* releaseChecks;
        const redirect: DocumentRedirect = { _tag: "Redirect", location: settlement.location };
        return redirect;
      }
      const mode = Option.match(settlement.route, {
        onNone: () => notFoundMode,
        onSome: modeOf,
      });
      const routed: Drawing<DocumentTimedOut, Mounted<R> | Mounted<N> | Scope.Scope> = (
        host,
        root,
      ) =>
        Effect.raceFirst(
          mount<R, HtmlNode, N>({
            routes: options.routes,
            notFound: options.notFound,
            host,
            root,
            // The server Location has no surface to land on and no
            // traversals, so neither option is ever read here.
            landing: Restore,
            traversalReadLimit: Duration.zero,
          }).pipe(
            Effect.provideService(Location, requestLocation(options.url)),
            Effect.provideService(
              SettledRequest,
              Option.some({ url: settlement.url, route: settlement.route }),
            ),
            Effect.ensuring(releaseChecks),
          ),
          timedOut("draw"),
        );
      // SSR: the transition waits for each declared query before any view draws.
      const resolvedFirst: typeof routed = (host, root) =>
        Effect.provideService(routed(host, root), ResolveBeforeRender, true);
      const body = yield* Scope.provide(
        prepare(mode, { routed, resolvedFirst, releaseChecks, closeWhen, shared }),
        opened,
      );
      const route = Option.match(settlement.route, {
        onNone: (): DocumentRoute<R> => ({ _tag: "NotFound" }),
        onSome: (matched): DocumentRoute<R> => ({ _tag: "Matched", route: matched }),
      });
      const done: Prepared<R, A> = {
        _tag: "Prepared",
        route,
        mode,
        status: Option.match(settlement.route, { onNone: () => 404, onSome: () => 200 }),
        body,
      };
      return done;
    });
    return yield* prepared.pipe(
      Effect.onError((cause) => Scope.close(opened, Exit.failCause(cause))),
    );
  });

/** What `renderDocument` takes: the document, and who is asking. */
export interface RenderDocumentOptions<R, N = R> extends DocumentOptions<R, N> {
  /**
   * Who is asking. Every check and query the render reads runs under this
   * principal, so its policy judges the request's caller. A site with no
   * sessions writes `principal: Anonymous.make({})`.
   */
  readonly principal: Principal;
}

/**
 * Answer one request. It runs in the request's Scope: the time limit runs
 * there once, and a `Streamed` body keeps its drawing there until the body
 * ends. On `DocumentTimedOut`, what the render opened is already closed.
 * `respondDocument` turns the outcome into a `Response` and owns that Scope.
 *
 * ```ts
 * const outcome = yield* renderDocument({
 *   routes,
 *   notFound: NotFound,
 *   url,
 *   document,
 *   closeWhen: Effect.sleep("10 seconds"),
 *   principal: Anonymous.make({}),
 * });
 * ```
 */
export const renderDocument = <R, N = R>(
  options: RenderDocumentOptions<R, N>,
): Effect.Effect<
  DocumentOutcome<R>,
  DocumentTimedOut,
  DocumentServices<R> | DocumentServices<N> | Scope.Scope
> =>
  Effect.map(
    settleAndPrepare(options, requestCache, (mode, pipelines) =>
      prepareBody(options.document, mode, pipelines),
    ).pipe(Effect.provideService(CurrentPrincipal, options.principal)),
    (outcome): DocumentOutcome<R> => {
      if (outcome._tag === "Redirect") {
        return outcome;
      }
      return {
        _tag: "Rendered",
        route: outcome.route,
        mode: outcome.mode,
        status: outcome.status,
        body: outcome.body,
      };
    },
  );

/** Prepare the body in the render's Scope, by the settled mode. */
const prepareBody = <R, N>(
  document: Document,
  mode: RenderingMode,
  { routed, resolvedFirst, releaseChecks, closeWhen, shared }: Pipelines<R, N>,
): Effect.Effect<Stream.Stream<string>, DocumentTimedOut, PreparedServices<R, N>> => {
  if (mode === "ClientOnly") {
    // Nothing is drawn and nothing is read: the client mounts into the empty element.
    return Effect.as(
      releaseChecks,
      Stream.succeed([document.head, document.tail, document.bootstrap, document.end].join("")),
    );
  }
  if (mode === "SSR") {
    return Effect.map(
      agreedInTime(renderSeeded(resolvedFirst, document, { closeWhen }, shared)),
      Stream.succeed,
    );
  }
  if (mode === "AwaitAll") {
    return Effect.map(
      agreedInTime(awaitAllDrawing(routed, document, { closeWhen }, shared)),
      Stream.succeed,
    );
  }
  return agreedInTime(streamPrepared(routed, document, { closeWhen }, shared));
};

/** What `respondDocument` answers when the document is not prepared in time. */
export interface RespondDocumentOptions {
  /**
   * The answer to `DocumentTimedOut`. Nothing was written and the render's
   * Scope is already closed: answer a status, or a client-only page.
   */
  readonly onTimeout: (error: DocumentTimedOut) => Effect.Effect<Response>;
}

/**
 * Answer one page request with the document `render` prepares, in a Scope
 * of its own. The Scope outlives this Effect only for a returned body and
 * closes when that body ends. Every other exit closes it before the answer
 * leaves: a redirect, a timeout, a failure or a defect in the drawing, and
 * an interruption. A redirect answers `303 See Other`. A defect is logged
 * and answers 500.
 *
 * ```ts
 * const answerPage = (request: Request) =>
 *   respondDocument(
 *     renderDocument({ routes, notFound, url: new URL(request.url), document, closeWhen, principal }),
 *     { onTimeout: () => Effect.succeed(new Response("the page took too long", { status: 504 })) },
 *   );
 * ```
 */
export const respondDocument = <A, R>(
  render: Effect.Effect<DocumentOutcome<A>, DocumentTimedOut, R>,
  options: RespondDocumentOptions,
): Effect.Effect<Response, never, Exclude<R, Scope.Scope>> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const close = Scope.close(scope, Exit.void);
    const context = yield* Effect.context<never>();
    return yield* Scope.provide(render, scope).pipe(
      Effect.flatMap((outcome) => {
        if (outcome._tag === "Redirect") {
          const location = `${outcome.location.pathname}${outcome.location.search}`;
          return Effect.as(close, new Response("", { status: 303, headers: { location } }));
        }
        // The Scope holds a streamed drawing: it closes when the body ends.
        const body = Stream.encodeText(outcome.body).pipe(Stream.ensuring(close));
        return Effect.succeed(
          new Response(Stream.toReadableStreamWith(body, context), {
            status: outcome.status,
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
        );
      }),
      Effect.onExit((exit) => {
        if (Exit.isSuccess(exit)) {
          return Effect.void;
        }
        return close;
      }),
      Effect.catchTag("DocumentTimedOut", options.onTimeout),
      Effect.catchCause((cause) =>
        Effect.as(
          Effect.logError("respondDocument: the page failed", cause),
          new Response("the page failed", { status: 500 }),
        ),
      ),
    );
  });
