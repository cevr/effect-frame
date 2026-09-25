import { Effect, Layer } from "effect";
import type { HttpBody } from "effect/unstable/http";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

/** A web-standard handler: the shape `HttpServer.make` builds. */
export type Handler = (request: Request) => Effect.Effect<Response>;

/** The request init for one body. The actor transport sends text or nothing. */
const initOf = (
  method: string,
  headers: Record<string, string>,
  body: HttpBody.HttpBody,
): Effect.Effect<RequestInit> => {
  if (body._tag === "Empty") {
    return Effect.succeed({ method, headers });
  }
  if (body._tag === "Uint8Array") {
    return Effect.succeed({ method, headers, body: new TextDecoder().decode(body.body) });
  }
  return Effect.die(`HttpTest.client sends a text body or none, not ${body._tag}`);
};

/**
 * An `HttpClient` whose every request goes straight into `handler`, in
 * process, with no socket. `HttpTransport.layer` over it crosses the same
 * wire a browser does. An interrupted request interrupts the handler.
 *
 * ```ts
 * const actors = yield* HttpServer.make({ prefix: "/actors", ... });
 * const transport = HttpTransport.layer({
 *   baseUrl: "http://actors.test/actors",
 *   reconnect: HttpTransport.defaultReconnect,
 * }).pipe(Layer.provide(HttpTest.client(actors)));
 * ```
 */
export const client = (handler: Handler): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url, signal) =>
      Effect.flatMap(initOf(request.method, request.headers, request.body), (init) =>
        Effect.map(handler(new Request(url, { ...init, signal })), (response) =>
          HttpClientResponse.fromWeb(request, response),
        ),
      ),
    ),
  );
