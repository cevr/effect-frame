import type { Context, Layer, Scope } from "effect";
import { Duration, Effect, ManagedRuntime, Option, RcMap, Schema, Sink, Stream } from "effect";
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

export { form, type FormPostOptions } from "./form-post.js";

/**
 * A web-standard handler over the transport in context. `Request` in,
 * `Response` out: the shape Bun, Cloudflare Workers, and celld all serve.
 * Mount it under one prefix and give the client that prefix as `baseUrl`.
 */
export type WebHandler = (request: Request) => Effect.Effect<Response>;

/**
 * Derives who is asking from the raw request (#20 §1, #30 §4). It is the
 * only place a cookie or an `Authorization` header is read. It returns
 * `Anonymous` rather than failing: refusal is a policy's job, not the
 * parser's. A request reads `get` once. A `changes` connection watches
 * `changes`, and ends with `Unauthorized` when the principal changes.
 */
export type DerivePrincipal<R = never> = (
  request: Request,
) => Effect.Effect<PrincipalSource, never, R>;

export interface ServerOptions<R = never> {
  /**
   * Required: a host that serves authenticated traffic cannot forget it.
   * A host with no sessions writes `principal: HttpServer.anonymous`.
   */
  readonly principal: DerivePrincipal<R>;
}

/**
 * The explicit opt-out: every request is `Anonymous`, and every connection
 * watches a principal that never changes. It opens no subscription and
 * never ends a stream.
 */
export const anonymous: DerivePrincipal = () => Effect.succeed(Principal.anonymous);

const decodeBody = <S extends Schema.Codec<unknown, unknown>>(schema: S) => {
  const decode = Schema.decodeEffect(Schema.fromJsonString(schema));
  return (request: Request) =>
    Effect.flatMap(
      Effect.tryPromise({ try: () => request.text(), catch: (cause) => String(cause) }),
      (text) => Effect.mapError(decode(text), (error) => error.message),
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
 * authorized under: any change, not only a revocation (#30 §6). The source
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
 * How a shared session subscription buffers for each connection: the latest
 * revision only. A connection that falls behind skips to the newest
 * revision and never holds a queue that grows. The number still tells it a
 * change happened, so skipping one is safe.
 */
export interface SessionBuffer {
  readonly capacity: 1;
  readonly strategy: "sliding";
  readonly replay: 1;
}

export const sessionBuffer: SessionBuffer = { capacity: 1, strategy: "sliding", replay: 1 };

/**
 * One subscription per session, shared by every connection that follows it
 * (#30 §8). The first connection on a key opens the subscription; the rest
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
      lookup: (key: K) => Stream.share(Principal.revisions(sessions.follow(key)), sessionBuffer),
    });
    return (key: K): PrincipalSource => ({
      // The server is the boundary: a request's read runs in the server's context.
      // oxlint-disable-next-line effect/noInlineProvide
      get: Effect.provideContext(sessions.read(key), context),
      changes: Stream.unwrap(RcMap.get(followed, key)),
    });
  });

export const make = <R = never>(
  options: ServerOptions<R>,
): Effect.Effect<WebHandler, never, ActorTransport | R> =>
  Effect.gen(function* () {
    const transport = yield* ActorTransport;
    const context = yield* Effect.context<never>();
    const derivation: Context.Context<R> = yield* Effect.context<R>();
    const derive = (request: Request): Effect.Effect<PrincipalSource> =>
      // The host is the boundary: the derivation runs with the context `make` was built in.
      // oxlint-disable-next-line effect/noInlineProvide
      Effect.provideContext(options.principal(request), derivation);

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

    /** Every verb but `changes`: one request, one principal. */
    const route = (request: Request): Effect.Effect<Response> => {
      const path = new URL(request.url).pathname;
      if (request.method !== "POST") {
        return Effect.succeed(new Response("method not allowed", { status: 405 }));
      }
      if (path.endsWith(paths.send)) {
        return decodeSend(request).pipe(
          Effect.flatMap((body) =>
            respond(
              Effect.map(
                transport.send(body.address, body.commandId, body.payload, body.active),
                (result) => ({ ...result.receipt, refreshed: result.refreshed }),
              ),
              encodeReceipt,
            ),
          ),
          Effect.catch((reason) => Effect.succeed(badRequest(reason))),
        );
      }
      if (path.endsWith(paths.call)) {
        return decodeCall(request).pipe(
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
          Effect.catch((reason) => Effect.succeed(badRequest(reason))),
        );
      }
      if (path.endsWith(paths.query)) {
        return decodeQueryBody(request).pipe(
          Effect.flatMap((body) =>
            respondQuery(
              Effect.map(transport.query(body.key), (result) => ({ key: body.key, result })),
              encodeQueryValue,
            ),
          ),
          Effect.catch((reason) => Effect.succeed(badRequest(reason))),
        );
      }
      if (path.endsWith(paths.queryBatch)) {
        return decodeQueryBatchBody(request).pipe(
          Effect.flatMap((body) => respondQuery(transport.queryBatch(body.keys), encodeQueryBatch)),
          Effect.catch((reason) => Effect.succeed(badRequest(reason))),
        );
      }
      if (path.endsWith(paths.snapshot)) {
        return decodeAddress(request).pipe(
          Effect.flatMap((body) => respond(transport.snapshot(body.address), encodeProjection)),
          Effect.catch((reason) => Effect.succeed(badRequest(reason))),
        );
      }
      return Effect.succeed(new Response("not found", { status: 404 }));
    };

    /**
     * One derivation per request, and no verb can bypass it. A request runs
     * under the one principal it read. A `changes` connection runs under the
     * principal it connected with and ends when that principal changes.
     */
    const handler: WebHandler = (request) =>
      Effect.flatMap(derive(request), (who) => {
        const path = new URL(request.url).pathname;
        if (request.method === "GET" && path.endsWith(paths.changes)) {
          return changes(request, who);
        }
        return Effect.flatMap(who.get, (principal) =>
          Effect.provideService(route(request), CurrentPrincipal, principal),
        );
      });
    return handler;
  });

/**
 * A promise-returning handler for `Bun.serve` or a Worker `fetch`. The
 * runtime owns the transport layer; dispose it when the server stops. The
 * layer also supplies what the principal derivation needs: a derivation
 * that reads sessions through `ActorTransport` gets the same host.
 */
export const toWebHandler = <E, R = never>(
  layer: Layer.Layer<ActorTransport | NoInfer<R>, E>,
  options: ServerOptions<R>,
) => {
  const runtime = ManagedRuntime.make(layer);
  const handler = runtime.runPromise(make(options));
  return {
    fetch: (request: Request): Promise<Response> =>
      handler.then((run) => runtime.runPromise(run(request))),
    dispose: (): Promise<void> => runtime.dispose(),
  };
};
