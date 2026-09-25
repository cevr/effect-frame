import { Effect, Layer } from "effect";
import { HttpClient, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

/**
 * An `HttpClient` whose every request goes straight into `app`, in
 * process, with no socket: the client request becomes the app's
 * `HttpServerRequest`, and its response the client's response.
 * `HttpTransport.layer` over it crosses the same wire a browser does. An
 * interrupted request interrupts the app.
 *
 * ```ts
 * const actors = yield* HttpServer.make({ prefix: "/actors", ... });
 * const transport = HttpTransport.layer({
 *   baseUrl: "http://actors.test/actors",
 *   reconnect: HttpTransport.defaultReconnect,
 * }).pipe(Layer.provide(HttpTest.client(actors)));
 * ```
 */
export const client = (
  app: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    HttpServerRequest.HttpServerRequest
  >,
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.map(
        Effect.provideService(
          app,
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromClientRequest(request),
        ),
        (response) => HttpServerResponse.toClientResponse(response, { request }),
      ),
    ),
  );
