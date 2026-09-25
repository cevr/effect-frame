import { Effect, Option, Schema, Stream } from "effect";
import type { HttpServerRequest } from "effect/unstable/http";
import { Headers, HttpMethod } from "effect/unstable/http";

/** The body is larger than the limit the host named. Nothing past the limit was read. */
export class BodyTooLarge extends Schema.TaggedError<BodyTooLarge>()("BodyTooLarge", {
  maxBodyBytes: Schema.Finite,
}) {
  override get message(): string {
    return `the request body is over ${String(this.maxBodyBytes)} bytes`;
  }
}

/** The body could not be read: the connection failed, the stream was already used, or there is none. */
export class BodyUnreadable extends Schema.TaggedError<BodyUnreadable>()("BodyUnreadable", {
  reason: Schema.String,
}) {}

const declaredLength = (request: HttpServerRequest.HttpServerRequest): Option.Option<number> =>
  Option.filter(
    Option.map(Headers.get(request.headers, "content-length"), Number),
    Number.isFinite,
  );

/**
 * Read a request body as UTF-8 text, counting bytes as they arrive. A body
 * whose declared length is over `maxBodyBytes` is refused before any byte
 * is read; a chunked one is refused as soon as it crosses the limit, and
 * the rest is never buffered. A method that carries no body (`GET`,
 * `HEAD`, `OPTIONS`, `TRACE`) reads as empty text.
 *
 * ```ts
 * const request = yield* HttpServerRequest.HttpServerRequest;
 * const text = yield* HttpServer.readText(request, 64 * 1024).pipe(
 *   Effect.catchTag("BodyTooLarge", () => Effect.succeed("")),
 * );
 * ```
 */
export const readText = (
  request: HttpServerRequest.HttpServerRequest,
  maxBodyBytes: number,
): Effect.Effect<string, BodyTooLarge | BodyUnreadable> => {
  const tooLarge = BodyTooLarge.make({ maxBodyBytes });
  if (!HttpMethod.hasBody(request.method)) {
    return Effect.succeed("");
  }
  if (Option.isSome(Option.filter(declaredLength(request), (length) => length > maxBodyBytes))) {
    return Effect.fail(tooLarge);
  }
  // `request.stream`, not `request.text`: a web-backed request's `text`
  // buffers the whole body and ignores `HttpIncomingMessage.MaxBodySize`.
  return request.stream.pipe(
    Stream.mapError((error) => BodyUnreadable.make({ reason: error.message })),
    Stream.mapAccumEffect(
      () => 0,
      (total, chunk: Uint8Array) => {
        const next = total + chunk.byteLength;
        if (next > maxBodyBytes) {
          return Effect.fail(tooLarge);
        }
        const counted: readonly [number, ReadonlyArray<Uint8Array>] = [next, [chunk]];
        return Effect.succeed(counted);
      },
    ),
    Stream.decodeText,
    Stream.mkString,
  );
};
