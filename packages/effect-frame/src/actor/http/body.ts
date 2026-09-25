import { Effect, Option, Schema, Stream } from "effect";

/** The body is larger than the limit the host named. Nothing past the limit was read. */
export class BodyTooLarge extends Schema.TaggedError<BodyTooLarge>()("BodyTooLarge", {
  maxBodyBytes: Schema.Finite,
}) {
  override get message(): string {
    return `the request body is over ${String(this.maxBodyBytes)} bytes`;
  }
}

/** The body could not be read: the connection failed or the stream was already used. */
export class BodyUnreadable extends Schema.TaggedError<BodyUnreadable>()("BodyUnreadable", {
  reason: Schema.String,
}) {}

const declaredLength = (request: Request): Option.Option<number> =>
  Option.filter(
    Option.map(Option.fromNullishOr(request.headers.get("content-length")), Number),
    Number.isFinite,
  );

/**
 * Read a request body as UTF-8 text, counting bytes as they arrive. A body
 * whose declared length is over `maxBodyBytes` is refused before any byte
 * is read; a chunked one is refused as soon as it crosses the limit, and
 * the rest is never buffered.
 *
 * ```ts
 * const text = yield* HttpServer.readText(request, 64 * 1024).pipe(
 *   Effect.catchTag("BodyTooLarge", () => Effect.succeed("")),
 * );
 * ```
 */
export const readText = (
  request: Request,
  maxBodyBytes: number,
): Effect.Effect<string, BodyTooLarge | BodyUnreadable> => {
  const tooLarge = BodyTooLarge.make({ maxBodyBytes });
  if (Option.isSome(Option.filter(declaredLength(request), (length) => length > maxBodyBytes))) {
    return Effect.fail(tooLarge);
  }
  return Option.match(Option.fromNullishOr(request.body), {
    onNone: () => Effect.succeed(""),
    onSome: (body) =>
      Stream.fromReadableStream({
        evaluate: () => body,
        onError: (cause) => BodyUnreadable.make({ reason: String(cause) }),
      }).pipe(
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
      ),
  });
};
