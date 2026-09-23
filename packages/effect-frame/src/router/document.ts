import type { View } from "effect-frame/view";
import { Deferred, Effect, Exit, Option, Schema, Scope, Stream } from "effect";
import type { ActorTransport } from "effect-frame/actor/client";
import { QueryCache } from "effect-frame/actor/client";
import type { Document, Drawing, HtmlNode } from "../view/hosts/html.js";
import { awaitAllDrawing, renderSeeded, requestCache, streamPrepared } from "../view/hosts/html.js";
import { ResolveBeforeRender } from "./branch.js";
import type { AnyRoute } from "./codec.js";
import type { RenderingMode } from "./rendering-mode.js";
import { read as readMode } from "./rendering-mode.js";
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
 * `ActorTransport` under the `CurrentPrincipal` the caller provides (#85),
 * so the query's own named policy checks it.
 */

export interface DocumentOptions<R, N = R> {
  readonly routes: ReadonlyArray<AnyRoute<R>>;
  readonly notFound: View.View<NotFoundProps, never, N>;
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

/** Which route a document shows. A user route may be named anything, `"not-found"` too. */
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
  /** The settled tree's mode. A hand-written route and not-found render as `SSR`. */
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
 */
export class DocumentTimedOut extends Schema.TaggedError<DocumentTimedOut>()("DocumentTimedOut", {
  phase: Schema.Literals(["settle", "draw"]),
}) {}

/** What the router's mount needs once the request `Location` is provided. */
type Mounted<R> = Exclude<
  Exclude<Exclude<Exclude<R, Router>, UrlStateRuntime>, Scope.Scope>,
  Location
>;

/** What a document needs: the views' services the router does not provide, and a transport. */
export type DocumentServices<R> = Exclude<Mounted<R>, QueryCache> | ActorTransport;

/** What the pipelines need before the drawing's Scope is provided. */
type Prepared<R, N> = Exclude<Mounted<R> | Mounted<N> | Scope.Scope, QueryCache> | ActorTransport;

/** A server render does not move: the URL stays the request's. */
const requestLocation = (url: URL): LocationService => ({
  current: Effect.succeed(url),
  push: () => Effect.void,
  replace: () => Effect.void,
  pops: Stream.never,
});

/**
 * Answer one request. It runs in the request's Scope: the time limit runs
 * there once, and a `Streamed` body keeps its drawing there until the body
 * ends. On `DocumentTimedOut`, what the render opened is already closed.
 */
export const renderDocument = <R, N = R>(
  options: DocumentOptions<R, N>,
): Effect.Effect<
  DocumentOutcome<R>,
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
    const cache = yield* requestCache;
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
      const mode = Option.getOrElse(
        Option.flatMap(settlement.route, readMode),
        (): RenderingMode => "SSR",
      );
      const { document } = options;
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
      /** Prepare the body in the render's Scope, by the settled mode. */
      const prepare = (): Effect.Effect<
        Stream.Stream<string>,
        DocumentTimedOut,
        Prepared<R, N>
      > => {
        if (mode === "ClientOnly") {
          // Nothing is drawn and nothing is read: the client mounts into the empty element.
          return Effect.as(
            releaseChecks,
            Stream.succeed(
              [document.head, document.tail, document.bootstrap, document.end].join(""),
            ),
          );
        }
        if (mode === "SSR") {
          return Effect.map(renderSeeded(resolvedFirst, document, shared), Stream.succeed);
        }
        if (mode === "AwaitAll") {
          return Effect.map(
            awaitAllDrawing(routed, document, { closeWhen }, shared),
            Stream.succeed,
          );
        }
        return streamPrepared(routed, document, { closeWhen }, shared);
      };
      const body = yield* Scope.provide(prepare(), opened);
      const route = Option.match(settlement.route, {
        onNone: (): DocumentRoute<R> => ({ _tag: "NotFound" }),
        onSome: (matched): DocumentRoute<R> => ({ _tag: "Matched", route: matched }),
      });
      const rendered: RenderedDocument<R> = {
        _tag: "Rendered",
        route,
        mode,
        status: Option.match(settlement.route, { onNone: () => 404, onSome: () => 200 }),
        body,
      };
      return rendered;
    });
    return yield* prepared.pipe(
      Effect.onError((cause) => Scope.close(opened, Exit.failCause(cause))),
    );
  });
