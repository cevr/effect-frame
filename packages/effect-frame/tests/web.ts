import type { Scope } from "effect";
import { Effect, Layer } from "effect";
import type { ActorTransport } from "effect-frame/actor/client";
import type { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpEffect, HttpRouter } from "effect/unstable/http";

/**
 * A web `fetch` over `app`, through the adapter a server uses
 * (`HttpEffect.toWebHandlerWith` over the caller's context). Each answer
 * is an Effect, so a test reads web `Response`s as a browser would.
 */
export const webOf = <E>(
  app: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    E,
    HttpServerRequest.HttpServerRequest | Scope.Scope
  >,
) =>
  Effect.map(Effect.context<never>(), (context) => {
    const web = HttpEffect.toWebHandlerWith<
      never,
      HttpServerRequest.HttpServerRequest | Scope.Scope
    >(context)(app);
    return (request: Request): Effect.Effect<Response> => Effect.promise(() => web(request));
  });

/**
 * The web `fetch` of a router built from `routes` over the caller's
 * transport, through `HttpRouter.toWebHandler`, as a server serves it. The
 * router is disposed with the calling Scope.
 */
export const routerWeb = (
  routes: Layer.Layer<
    never,
    never,
    HttpRouter.HttpRouter | ActorTransport | HttpRouter.Request<"Requires", ActorTransport>
  >,
) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<ActorTransport>();
    const web = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(Layer.provideMerge(routes, Layer.succeedContext(context)), {
          disableLogger: true,
        }),
      ),
      (router) => Effect.promise(() => router.dispose()),
    );
    return (request: Request): Effect.Effect<Response> =>
      Effect.promise(() => web.handler(request));
  });
