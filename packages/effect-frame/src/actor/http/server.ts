import type { Context, Scope } from "effect";
import { Duration, Effect, Option, RcMap, Schema, Sink, Stream } from "effect";
import type { FormContext } from "../form.js";
import type { Address } from "../contract.js";
import type { PrincipalRevision, PrincipalSource } from "../principal.js";
import { Anonymous, CurrentPrincipal, Principal } from "../principal.js";
import type { Projection } from "../transport.js";
import { ActorTransport } from "../transport.js";
import { Unauthorized } from "../vocabulary.js";
import {
  AddressBody,
  CallBody,
  QueryBody,
  QueryBatchBody,
  SendBody,
  WireAddress,
  WireApplied,
  WireError,
  WireProjection,
  WireQueryError,
  WireQueryBatch,
  WireQueryValue,
  WireReceipt,
  errorEvent,
  eventPrefix,
  paths,
  queryStatusOf,
  statusOf,
} from "./wire.js";
import { readText } from "./body.js";
import type { FormRoute } from "./form-post.js";
import { formPost } from "./form-post.js";

export type { FormRoute } from "./form-post.js";
export { BodyTooLarge, BodyUnreadable, readText } from "./body.js";

/**
 * A web-standard handler over the transport in context. `Request` in,
 * `Response` out: the shape Bun, Cloudflare Workers, and celld all serve.
 * It answers the paths under its `prefix`; give the client that prefix as
 * `baseUrl`.
 */
export type WebHandler = (request: Request) => Effect.Effect<Response>;

/**
 * The path a handler owns: `""` for the root, or a path that starts with
 * `/` and does not end with one, such as `"/actors"`.
 */
export type Prefix = "" | `/${string}`;

/**
 * Derives who is asking from the raw request. It is the
 * only place a cookie or an `Authorization` header is read. It returns
 * `Anonymous` rather than failing: refusal is a policy's job, not the
 * parser's. A request reads `get` once. A `changes` connection watches
 * `changes`, and ends with `Unauthorized` when the principal changes.
 */
export type DerivePrincipal<R = never> = (
  request: Request,
) => Effect.Effect<PrincipalSource, never, R>;

export interface ServerOptions<R = never, FE = never, FR = never> {
  /**
   * Where the handler is mounted. Each verb answers at exactly
   * `prefix` plus `/send`, `/call`, `/snapshot`, `/changes`, `/query`,
   * `/query/batch` or `/form` (`paths` in `wire.ts`), so the app routes every path under the prefix
   * here unchanged, and any other path under it answers 404.
   */
  readonly prefix: Prefix;
  /**
   * Required: a host that serves authenticated traffic cannot forget it.
   * A host with no sessions writes `principal: HttpServer.anonymous`. It is
   * derived once per request, for the JSON verbs and the form route alike.
   */
  readonly principal: DerivePrincipal<R>;
  /**
   * The largest request body read, in bytes. A larger body answers 413
   * before it is decoded. `HttpServer.defaultMaxBodyBytes` is one MiB.
   */
  readonly maxBodyBytes: number;
  /**
   * The plain-form route at `prefix + /form`, for pages with no script.
   * `Option.none()` for a host whose pages post nothing without script.
   */
  readonly form: Option.Option<FormRoute<FE, FR>>;
}

/** One MiB: a named limit for `maxBodyBytes`, larger than any message the example apps send. */
export const defaultMaxBodyBytes = 1024 * 1024;

/** Ten seconds: a named limit for a form route's `commitWithin`. */
export const defaultCommitWithin: Duration.Duration = Duration.seconds(10);

/**
 * The explicit opt-out: every request is `Anonymous`, and every connection
 * watches a principal that never changes. It opens no subscription and
 * never ends a stream.
 */
export const anonymous: DerivePrincipal = () => Effect.succeed(Principal.anonymous);

/** The body read under the host's limit, then decoded. A refusal carries its status. */
interface BodyRefusal {
  readonly status: 400 | 413;
  readonly reason: string;
}

const decodeBody = <S extends Schema.Codec<unknown, unknown>>(schema: S) => {
  const decode = Schema.decodeEffect(Schema.fromJsonString(schema));
  return (request: Request, maxBodyBytes: number): Effect.Effect<S["Type"], BodyRefusal> =>
    readText(request, maxBodyBytes).pipe(
      Effect.catchTags({
        BodyTooLarge: (error) => Effect.fail<BodyRefusal>({ status: 413, reason: error.message }),
        BodyUnreadable: (error) => Effect.fail<BodyRefusal>({ status: 400, reason: error.reason }),
      }),
      Effect.flatMap((text) =>
        Effect.mapError(decode(text), (error): BodyRefusal => ({
          status: 400,
          reason: error.message,
        })),
      ),
    );
};

const decodeSend = decodeBody(SendBody);
const decodeCall = decodeBody(CallBody);
const decodeAddress = decodeBody(AddressBody);
const decodeQueryBody = decodeBody(QueryBody);
const decodeQueryBatchBody = decodeBody(QueryBatchBody);
const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(WireReceipt));
const encodeProjection = Schema.encodeEffect(Schema.fromJsonString(WireProjection));
const encodeApplied = Schema.encodeEffect(Schema.fromJsonString(WireApplied));
const encodeQueryValue = Schema.encodeEffect(Schema.fromJsonString(WireQueryValue));
const encodeQueryBatch = Schema.encodeEffect(Schema.fromJsonString(WireQueryBatch));
const encodeError = Schema.encodeEffect(Schema.fromJsonString(WireError));
const encodeQueryError = Schema.encodeEffect(Schema.fromJsonString(WireQueryError));
const decodeQuery = Schema.decodeEffect(
  Schema.Struct({ ...WireAddress.fields, after: Schema.Finite }),
);

const json = (status: number, body: string) =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

const BadRequest = Schema.TaggedStruct("BadRequest", { reason: Schema.String });
const encodeBadRequest = Schema.encodeSync(Schema.fromJsonString(BadRequest));
const badRequest = (reason: string) => json(400, encodeBadRequest({ _tag: "BadRequest", reason }));

/** A body the host would not read or could not decode: 413 over the limit, else 400. */
const refusedBody = (refusal: BodyRefusal) =>
  json(refusal.status, encodeBadRequest({ _tag: "BadRequest", reason: refusal.reason }));

const respond = <A>(
  result: Effect.Effect<A, WireError>,
  encode: (value: A) => Effect.Effect<string, Schema.SchemaError>,
): Effect.Effect<Response> =>
  result.pipe(
    Effect.flatMap((value) => Effect.map(Effect.orDie(encode(value)), (text) => json(200, text))),
    Effect.catch((error) =>
      Effect.map(Effect.orDie(encodeError(error)), (text) => json(statusOf(error), text)),
    ),
  );

/** The query verb has its own failure union and its own status map. */
const respondQuery = <A>(
  result: Effect.Effect<A, WireQueryError>,
  encode: (value: A) => Effect.Effect<string, Schema.SchemaError>,
): Effect.Effect<Response> =>
  result.pipe(
    Effect.flatMap((value) => Effect.map(Effect.orDie(encode(value)), (text) => json(200, text))),
    Effect.catch((error) =>
      Effect.map(Effect.orDie(encodeQueryError(error)), (text) => json(queryStatusOf(error), text)),
    ),
  );

const eventLine = (projection: Projection) =>
  Effect.map(Effect.orDie(encodeProjection(projection)), (text) => `${eventPrefix}${text}\n\n`);

const parseQuery = (url: URL) =>
  decodeQuery({
    contract: Option.getOrElse(Option.fromNullishOr(url.searchParams.get("contract")), () => ""),
    version: Number(url.searchParams.get("version")),
    key: Option.getOrElse(Option.fromNullishOr(url.searchParams.get("key")), () => ""),
    after: Number(url.searchParams.get("after")),
  });

/**
 * Ends when the principal is no longer the one the connection was
 * authorized under: any change, not only a revocation. The source
 * numbers only real changes, so a session revision that leaves the
 * principal equal ends nothing. `rest` is the same subscription the
 * connected value was read from, so no change between the read and the
 * watch can be missed. A later revision always has a larger number, so a
 * change and a change back (A, B, A) ends the stream even when a slow
 * connection skipped B.
 */
const revokedWhen = (
  rest: Stream.Stream<PrincipalRevision>,
  connected: PrincipalRevision,
  address: Address,
): Stream.Stream<never, Unauthorized> =>
  rest.pipe(
    Stream.filter((current) => current.revision > connected.revision),
    Stream.take(1),
    Stream.flatMap(() => Stream.fail(Unauthorized.make({ contract: address.contract }))),
  );

/** How one session is read and followed, by the key a request carries. */
export interface SessionPrincipals<K, R = never> {
  /** One request's principal: a snapshot read of the session. */
  readonly read: (key: K) => Effect.Effect<Principal, never, R>;
  /** The session's principal over time. It emits the current value first. */
  readonly follow: (key: K) => Stream.Stream<Principal, never, R>;
}

/**
 * One subscription per session, shared by every connection that follows
 * it. The first connection on a key opens the subscription; the rest
 * join it and see its latest revision first; the last one to close
 * releases it. Revisions are numbered once, before the share, so every
 * connection compares the same numbers. `K` must compare by value, as a
 * string does. Build it once, in the scope of the server, and derive each
 * request's source from it.
 */
export const shareSessions = <K, R>(
  sessions: SessionPrincipals<K, R>,
): Effect.Effect<(key: K) => PrincipalSource, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<R>();
    const followed = yield* RcMap.make({
      // The latest revision only: a connection that falls behind skips to the
      // newest one and never holds a queue that grows. The number still tells
      // it a change happened, so skipping one is safe.
      lookup: (key: K) =>
        Stream.share(Principal.revisions(sessions.follow(key)), {
          capacity: 1,
          strategy: "sliding",
          replay: 1,
        }),
    });
    return (key: K): PrincipalSource => ({
      // The server is the boundary: a request's read runs in the server's context.
      get: Effect.provideContext(sessions.read(key), context),
      changes: Stream.unwrap(RcMap.get(followed, key)),
    });
  });

/**
 * The actor host's one HTTP handler: the JSON verbs, the `changes` stream,
 * and the plain-form route, every one under `prefix`, every one under the
 * principal derived once per request, and every body read under
 * `maxBodyBytes`.
 *
 * ```ts
 * const actors = yield* HttpServer.make({
 *   prefix: "/actors",
 *   principal: HttpServer.anonymous,
 *   maxBodyBytes: HttpServer.defaultMaxBodyBytes,
 *   form: Option.some({
 *     contracts: [Notes],
 *     login: Option.none(),
 *     render: drawAgain,
 *     commitWithin: HttpServer.defaultCommitWithin,
 *   }),
 * });
 * // Every path under /actors goes to `actors` unchanged.
 * ```
 */
export const make = <R = never, FE = never, FR = never>(
  options: ServerOptions<R, FE, FR>,
): Effect.Effect<WebHandler, never, ActorTransport | R | Exclude<FR, FormContext>> =>
  Effect.gen(function* () {
    const transport = yield* ActorTransport;
    const context = yield* Effect.context<never>();
    const derivation: Context.Context<R> = yield* Effect.context<R>();
    const derive = (request: Request): Effect.Effect<PrincipalSource> =>
      // The host is the boundary: the derivation runs with the context `make` was built in.
      Effect.provideContext(options.principal(request), derivation);
    const at = (path: string) => `${options.prefix}${path}`;
    const maxBodyBytes = options.maxBodyBytes;
    const form = yield* Effect.transposeOption(
      Option.map(options.form, (route) => formPost(route, maxBodyBytes)),
    );

    const changes = (request: Request, who: PrincipalSource): Effect.Effect<Response> =>
      parseQuery(new URL(request.url)).pipe(
        Effect.map((query) => {
          const address = { contract: query.contract, version: query.version, key: query.key };
          // One subscription: its first value authorizes the connection, and
          // the rest of that same subscription is what the connection watches.
          const lines = Stream.unwrap(
            Effect.map(Stream.peel(who.changes, Sink.head()), ([head, rest]) => {
              const connected = Option.getOrElse(head, (): PrincipalRevision => ({
                principal: Anonymous.make({}),
                revision: 0,
              }));
              const projections = transport
                .changes(address, query.after)
                .pipe(Stream.provideService(CurrentPrincipal, connected.principal));
              return Stream.mergeLeft(projections, revokedWhen(rest, connected, address));
            }),
          ).pipe(Stream.mapEffect(eventLine), Stream.encodeText);
          // A protocol failure ends the stream with one error event so the
          // client can decode it; a transport failure closes the connection.
          const body = Stream.catch(lines, (error) =>
            Stream.fromEffect(
              Effect.map(Effect.orDie(encodeError(error)), (text) =>
                new TextEncoder().encode(`${errorEvent}\n${eventPrefix}${text}\n\n`),
              ),
            ),
          );
          return new Response(Stream.toReadableStreamWith(body, context), {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              connection: "keep-alive",
            },
          });
        }),
        Effect.catch((error) => Effect.succeed(badRequest(error.message))),
      );

    const notFound = Effect.succeed(new Response("not found", { status: 404 }));

    /** Every POST verb: one request, one principal, one bounded body. */
    const route = (request: Request, path: string): Effect.Effect<Response> => {
      if (path === at(paths.send)) {
        return decodeSend(request, maxBodyBytes).pipe(
          Effect.flatMap((body) =>
            respond(
              Effect.map(
                transport.send(body.address, body.commandId, body.payload, body.active),
                (result) => ({ ...result.receipt, refreshed: result.refreshed }),
              ),
              encodeReceipt,
            ),
          ),
          Effect.catch((refusal) => Effect.succeed(refusedBody(refusal))),
        );
      }
      if (path === at(paths.call)) {
        return decodeCall(request, maxBodyBytes).pipe(
          Effect.flatMap((body) =>
            respond(
              Effect.map(
                transport.call(
                  body.address,
                  body.commandId,
                  body.payload,
                  Duration.millis(body.timeoutMillis),
                  body.active,
                ),
                (result) => ({ ...result.projection, refreshed: result.refreshed }),
              ),
              encodeApplied,
            ),
          ),
          Effect.catch((refusal) => Effect.succeed(refusedBody(refusal))),
        );
      }
      if (path === at(paths.query)) {
        return decodeQueryBody(request, maxBodyBytes).pipe(
          Effect.flatMap((body) =>
            respondQuery(
              Effect.map(transport.query(body.key), (result) => ({ key: body.key, result })),
              encodeQueryValue,
            ),
          ),
          Effect.catch((refusal) => Effect.succeed(refusedBody(refusal))),
        );
      }
      if (path === at(paths.queryBatch)) {
        return decodeQueryBatchBody(request, maxBodyBytes).pipe(
          Effect.flatMap((body) => respondQuery(transport.queryBatch(body.keys), encodeQueryBatch)),
          Effect.catch((refusal) => Effect.succeed(refusedBody(refusal))),
        );
      }
      if (path === at(paths.snapshot)) {
        return decodeAddress(request, maxBodyBytes).pipe(
          Effect.flatMap((body) => respond(transport.snapshot(body.address), encodeProjection)),
          Effect.catch((refusal) => Effect.succeed(refusedBody(refusal))),
        );
      }
      if (path === at(paths.form)) {
        return Option.match(form, {
          onNone: () => notFound,
          onSome: (post) => post(request),
        });
      }
      return notFound;
    };

    /**
     * One derivation per request, and no verb can bypass it. A request runs
     * under the one principal it read. A `changes` connection runs under the
     * principal it connected with and ends when that principal changes.
     */
    const handler: WebHandler = (request) =>
      Effect.flatMap(derive(request), (who) => {
        const path = new URL(request.url).pathname;
        if (path === at(paths.changes)) {
          if (request.method !== "GET") {
            return Effect.succeed(new Response("method not allowed", { status: 405 }));
          }
          return changes(request, who);
        }
        if (request.method !== "POST") {
          return Effect.succeed(new Response("method not allowed", { status: 405 }));
        }
        return Effect.flatMap(who.get, (principal) =>
          Effect.provideService(route(request, path), CurrentPrincipal, principal),
        );
      });
    return handler;
  });
