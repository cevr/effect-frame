/* oxlint-disable effect/noGlobals, effect/noNullish, effect/noTryCatch, effect/noRuntimeTypeof, effect/noTernary, effect/noUnknownParameters -- this module is the Bun platform boundary: Bun.serve callbacks, Web Request/Response, JSON frames, and random capabilities. */
/**
 * The development inspection gateway: a loopback Bun server.
 *
 * - `GET /v1/attach` upgrades an application root's WebSocket. It checks the
 *   Host, the configured application Origin, the protocol subprotocol, and the
 *   attach capability. The browser is the RPC server over that socket; the
 *   gateway holds one native `RpcClient` for each attached root.
 * - `GET /v1/roots` and `POST /v1/inspect` serve readers. They require the
 *   read capability and refuse any browser Origin.
 *
 * The registry holds live connections and root metadata only. It keeps no
 * snapshot history and it starts no application reads other than the one
 * sample each reader requests.
 */
import { Deferred, Effect, Exit, Option, Schedule, Schema, Scope } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import { Socket } from "effect/unstable/socket";
import type { ServerWebSocket } from "bun";
import { Protocol } from "effect-frame/inspection";
import { MAX_DEADLINE_MILLIS, MAX_REQUEST_BYTES, statusOf } from "./limits.js";

export interface GatewayOptions {
  /** The one application origin allowed to attach roots. */
  readonly allowedOrigin: string;
  /** The capability the application uses to attach. */
  readonly attachToken: string;
  /** The capability readers use for `roots` and `inspect`. */
  readonly readToken: string;
  /** Defaults to 0: an ephemeral loopback port. */
  readonly port?: number;
  /** The largest encoded snapshot a root may return. Defaults to 4 MiB. */
  readonly maxSnapshotBytes?: number;
  /** The most roots attached at once. Defaults to 64. */
  readonly maxRoots?: number;
}

export interface GatewayStats {
  readonly roots: number;
  readonly pendingReads: number;
  readonly connectionsOpened: number;
  readonly connectionsClosed: number;
  readonly readsStarted: number;
  readonly readsInterrupted: number;
  readonly protocolViolations: number;
}

export interface Gateway {
  readonly port: number;
  /** The reader base URL, `http://127.0.0.1:<port>`. */
  readonly url: string;
  /** The attach base URL, `ws://127.0.0.1:<port>`. */
  readonly attachUrl: string;
  readonly stats: Effect.Effect<GatewayStats>;
  readonly roots: Effect.Effect<ReadonlyArray<Protocol.RootInfo>>;
  /** Development control: close one root's socket from the gateway side. */
  readonly disconnectRoot: (rootId: string) => Effect.Effect<boolean>;
}

/** A fresh 256-bit capability as URL-safe hex. */
export const makeToken = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const sameSecret = (expected: string, received: string): boolean => {
  const a = new TextEncoder().encode(expected);
  const b = new TextEncoder().encode(received);
  let difference = a.length ^ b.length;
  for (let index = 0; index < a.length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index % Math.max(1, b.length)] ?? 0);
  }
  return difference === 0;
};

// ---------------------------------------------------------------------------
// One accepted root socket as a native Effect Socket
// ---------------------------------------------------------------------------

type Listener = (event: Socket.WebSocketEvent) => void;
type EventName = "open" | "message" | "error" | "close";

interface AcceptedSocket {
  readonly like: Socket.WebSocketLike;
  readonly message: (data: string) => void;
  readonly closed: (code: number, reason: string) => void;
}

/**
 * Bun hands the server side of a WebSocket to callbacks, not to an event
 * target. This adapter gives it the `WebSocketLike` shape that
 * `Socket.fromWebSocket` reads. Frames that arrive before the reader attaches
 * are buffered, so no reply is lost between upgrade and the first pull.
 */
const acceptSocket = (ws: ServerWebSocket<RootData>): AcceptedSocket => {
  // Each registered listener maps to the function actually called, so a
  // `once` listener can still be removed by its original reference.
  const listeners = new Map<EventName, Map<Listener, Listener>>();
  const pending: Array<string> = [];
  let readyState = 1;
  const listenersOf = (name: EventName): Map<Listener, Listener> => {
    const existing = listeners.get(name);
    if (existing !== undefined) return existing;
    const created = new Map<Listener, Listener>();
    listeners.set(name, created);
    return created;
  };
  const emit = (name: EventName, event: Socket.WebSocketEvent): void => {
    for (const call of Array.from(listenersOf(name).values())) call(event);
  };
  const like: Socket.WebSocketLike = {
    get readyState() {
      return readyState;
    },
    addEventListener(type, listener, options) {
      const call: Listener =
        options?.once === true
          ? (event) => {
              listenersOf(type).delete(listener);
              listener(event);
            }
          : listener;
      listenersOf(type).set(listener, call);
      if (type === "message" && pending.length > 0) {
        for (const data of pending.splice(0)) emit("message", { type: "message", data });
      }
    },
    removeEventListener(type, listener) {
      listenersOf(type).delete(listener);
    },
    close(code, reason) {
      if (readyState >= 2) return;
      readyState = 2;
      ws.close(code, reason);
    },
    send(data) {
      ws.send(data);
    },
  };
  return {
    like,
    message: (data) => {
      if (listenersOf("message").size === 0) {
        pending.push(data);
        return;
      }
      emit("message", { type: "message", data });
    },
    closed: (code, reason) => {
      readyState = 3;
      emit("close", { type: "close", code, reason });
    },
  };
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

type CloseReason =
  | { readonly _tag: "Closed" }
  | { readonly _tag: "Violation"; readonly detail: string };

interface RootData {
  readonly rootId: string;
  readonly name: string | null;
  connection?: Connection;
}

interface Connection {
  readonly info: Protocol.RootInfo;
  readonly ws: ServerWebSocket<RootData>;
  readonly socket: AcceptedSocket;
  readonly scope: Scope.Closeable;
  readonly closed: Deferred.Deferred<CloseReason>;
  readonly client: Deferred.Deferred<RpcClient.FromGroup<typeof Protocol.RootRpcs, RpcClientError>>;
  terminated: boolean;
}

/** The server messages a root may send over the root link. */
const SERVER_TAGS = new Set(["Chunk", "Exit", "Defect", "Pong"]);

const frameViolation = (message: string | Buffer): Option.Option<string> => {
  if (typeof message !== "string") return Option.some("binary frame");
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return Option.some("frame is not JSON");
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of messages) {
    if (typeof item !== "object" || item === null || !("_tag" in item)) {
      return Option.some("frame is not an RPC message");
    }
    const tag = item._tag;
    if (typeof tag !== "string" || !SERVER_TAGS.has(tag)) {
      return Option.some(`unexpected RPC message ${String(tag).slice(0, 32)}`);
    }
    if ((tag === "Exit" || tag === "Chunk") && !("requestId" in item)) {
      return Option.some("response has no request id");
    }
  }
  return Option.none();
};

/** The gateway could not listen, for example because the port is in use. */
export class GatewayListenError extends Schema.TaggedError<GatewayListenError>()(
  "GatewayListenError",
  { port: Schema.Int, detail: Schema.String },
) {}

class ReaderFailure extends Schema.TaggedError<ReaderFailure>()("ReaderFailure", {
  error: Protocol.GatewayError,
}) {}

const readerError = (error: Protocol.GatewayError) => Effect.fail(ReaderFailure.make({ error }));

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const encodeError = Schema.encodeSync(Protocol.ErrorResponse);
const encodeRoots = Schema.encodeSync(Protocol.RootsResponse);
const encodeInspection = Schema.encodeSync(Protocol.InspectResponse);
const decodeInspectRequest = Schema.decodeUnknownExit(Protocol.InspectRequest);
const hasProtocolVersion = Schema.is(
  Schema.Struct({ version: Schema.Literal(Protocol.wire.version) }),
);
const decodeDeadline = Schema.decodeUnknownOption(Schema.Struct({ deadlineMillis: Schema.Finite }));
const hasValidDeadline = Schema.is(Schema.Struct({ deadlineMillis: Protocol.DeadlineMillis }));
const isRootId = Schema.is(Protocol.RootId);
const isRootName = Schema.is(Protocol.RootName);

const tooLarge = () => readerError({ _tag: "MalformedRequest", detail: "request body too large" });

/**
 * Read a reader request body, counting bytes as they arrive. A body over
 * the limit is refused as soon as it crosses it, chunked or not; the
 * gateway never buffers the rest.
 */
const readBody = (request: Request) =>
  Effect.gen(function* () {
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > MAX_REQUEST_BYTES) return yield* tooLarge();
    if (request.body === null) return "";
    const reader = request.body.getReader();
    const chunks: Array<Uint8Array> = [];
    let total = 0;
    while (true) {
      const chunk = yield* Effect.promise(() => reader.read());
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        yield* Effect.sync(() => {
          reader.cancel().catch(() => undefined);
        });
        return yield* tooLarge();
      }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  });

/**
 * Name the first contract a request body breaks. The schemas hold the
 * contract; this only picks which error the reader sees.
 */
const requestError = (body: unknown): Protocol.GatewayError => {
  if (!hasProtocolVersion(body)) {
    const version =
      typeof body === "object" && body !== null && "version" in body ? body.version : undefined;
    return {
      _tag: "UnsupportedProtocolVersion",
      received: String(version).slice(0, 32),
      supported: [Protocol.wire.version],
    };
  }
  const deadline = decodeDeadline(body);
  if (Option.isSome(deadline) && !hasValidDeadline(body)) {
    return {
      _tag: "InvalidDeadline",
      deadlineMillis: deadline.value.deadlineMillis,
      maximum: MAX_DEADLINE_MILLIS,
    };
  }
  return {
    _tag: "MalformedRequest",
    detail: "body must be {version, root: selector, deadlineMillis: 1..30000}",
  };
};

const errorResponse = (error: Protocol.GatewayError): Response =>
  json(encodeError({ _tag: "Error", version: Protocol.wire.version, error }), statusOf(error));

const bearer = (request: Request): string => {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
};

/**
 * Start one gateway in the caller's scope. Closing the scope stops the
 * server, closes every root socket, and fails pending reads.
 */
export const make = Effect.fn("InspectionGateway.make")(function* (options: GatewayOptions) {
  const gatewayScope = yield* Effect.scope;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const maxSnapshotBytes = options.maxSnapshotBytes ?? 4 * 1024 * 1024;
  const maxRoots = options.maxRoots ?? 64;
  const registry = new Map<string, Connection>();
  let incarnations = 0;
  const counters = {
    pendingReads: 0,
    connectionsOpened: 0,
    connectionsClosed: 0,
    readsStarted: 0,
    readsInterrupted: 0,
    protocolViolations: 0,
  };
  let port = 0;

  const hostAllowed = (request: Request): boolean => {
    const host = request.headers.get("host") ?? "";
    // The gateway binds 127.0.0.1 only, so no other loopback name reaches it.
    return [`127.0.0.1:${port}`, `localhost:${port}`].includes(host);
  };

  // ------------------------------------------------------------ root link

  const openConnection = (ws: ServerWebSocket<RootData>): void => {
    incarnations += 1;
    counters.connectionsOpened += 1;
    const scope = Scope.forkUnsafe(gatewayScope);
    const connection: Connection = {
      info: {
        id: ws.data.rootId,
        name: ws.data.name,
        incarnation: incarnations,
        attachedAt: Date.now(),
      },
      ws,
      socket: acceptSocket(ws),
      scope,
      closed: Deferred.makeUnsafe<CloseReason>(),
      client: Deferred.makeUnsafe(),
      terminated: false,
    };
    ws.data.connection = connection;
    const previous = registry.get(connection.info.id);
    registry.set(connection.info.id, connection);
    // A reconnect replaces the old incarnation. Its pending reads fail; they
    // never settle against this one.
    if (previous !== undefined) {
      terminate(previous, { _tag: "Closed" }, 4001, "replaced by reconnect");
    }

    const build = Effect.gen(function* () {
      const socket = yield* Socket.fromWebSocket(Effect.succeed(connection.socket.like));
      const client = yield* RpcClient.make(Protocol.RootRpcs).pipe(
        Effect.provideServiceEffect(
          RpcClient.Protocol,
          // A server-side socket cannot be redialed. The root reconnects as a
          // new incarnation, so this client never retries.
          RpcClient.makeProtocolSocket({ retryPolicy: Schedule.recurs(0) }),
        ),
        Effect.provideService(Socket.Socket, socket),
      );
      yield* Deferred.succeed(connection.client, client);
    }).pipe(
      Effect.provideService(RpcSerialization.RpcSerialization, RpcSerialization.json),
      Scope.provide(scope),
    );
    runFork(build);
  };

  /**
   * End one incarnation now. Its registry entry goes, its pending reads fail
   * with its own incarnation, and its RPC client scope closes. The gateway
   * does not wait for the peer's close handshake: a root that is busy or
   * gone cannot hold a reader.
   */
  const terminate = (
    connection: Connection,
    reason: CloseReason,
    code: number,
    text: string,
    fromPeer = false,
  ): void => {
    if (connection.terminated) return;
    connection.terminated = true;
    counters.connectionsClosed += 1;
    if (registry.get(connection.info.id) === connection) registry.delete(connection.info.id);
    // Record why this incarnation ended before its RPC client can observe
    // the socket closing, so pending reads report the close, not the symptom.
    Deferred.doneUnsafe(connection.closed, Exit.succeed(reason));
    connection.socket.closed(code, text);
    runFork(Scope.close(connection.scope, Exit.void));
    if (!fromPeer) connection.ws.close(code, text);
  };

  const closeConnection = (ws: ServerWebSocket<RootData>, code: number, reason: string): void => {
    const connection = ws.data.connection;
    if (connection === undefined) return;
    terminate(connection, { _tag: "Closed" }, code, reason, true);
  };

  const onMessage = (ws: ServerWebSocket<RootData>, message: string | Buffer): void => {
    const connection = ws.data.connection;
    if (connection === undefined || connection.terminated) return;
    const violation = frameViolation(message);
    if (Option.isSome(violation)) {
      counters.protocolViolations += 1;
      terminate(
        connection,
        { _tag: "Violation", detail: violation.value },
        1008,
        "protocol violation",
      );
      return;
    }
    connection.socket.message(typeof message === "string" ? message : "");
  };

  const upgradeError = (error: Protocol.GatewayError): Response => errorResponse(error);

  const attach = (request: Request, server: Bun.Server<RootData>): Response | undefined => {
    const origin = request.headers.get("origin") ?? "";
    if (origin !== options.allowedOrigin) {
      return upgradeError({ _tag: "ForbiddenOrigin", origin: origin.slice(0, 256) });
    }
    const offered = (request.headers.get("sec-websocket-protocol") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (!offered.includes(Protocol.wire.subprotocol)) {
      return upgradeError({
        _tag: "UnsupportedProtocolVersion",
        received: offered
          .filter((value) => !value.startsWith(Protocol.wire.attachTokenPrefix))
          .join(","),
        supported: [Protocol.wire.version],
      });
    }
    const token = offered.find((value) => value.startsWith(Protocol.wire.attachTokenPrefix)) ?? "";
    if (!sameSecret(options.attachToken, token.slice(Protocol.wire.attachTokenPrefix.length))) {
      return upgradeError({ _tag: "Unauthorized" });
    }
    const url = new URL(request.url);
    const rootId = url.searchParams.get("root") ?? "";
    const name = url.searchParams.get("name");
    if (!isRootId(rootId)) {
      return upgradeError({ _tag: "MalformedRequest", detail: "root must be a Frame root ID" });
    }
    if (name !== null && !isRootName(name)) {
      return upgradeError({ _tag: "MalformedRequest", detail: "root name is not printable" });
    }
    if (registry.size >= maxRoots && !registry.has(rootId)) {
      return upgradeError({ _tag: "TooManyRoots", limit: maxRoots });
    }
    const upgraded = server.upgrade(request, {
      headers: { "Sec-WebSocket-Protocol": Protocol.wire.subprotocol },
      data: { rootId, name },
    });
    if (upgraded) return undefined;
    return upgradeError({ _tag: "MalformedRequest", detail: "WebSocket upgrade required" });
  };

  // ------------------------------------------------------------ readers

  const rootInfos = (): ReadonlyArray<Protocol.RootInfo> =>
    [...registry.values()]
      .map((connection) => connection.info)
      .toSorted((a, b) => a.id.localeCompare(b.id));

  const select = (selector: string) =>
    Effect.suspend(() => {
      const exact = registry.get(selector);
      if (exact !== undefined) return Effect.succeed(exact);
      const matches = [...registry.values()].filter(
        (connection) =>
          connection.info.id.startsWith(selector) || connection.info.name === selector,
      );
      const [only] = matches;
      if (matches.length === 1 && only !== undefined) return Effect.succeed(only);
      if (matches.length === 0) {
        return readerError({ _tag: "RootNotFound", selector, attached: registry.size });
      }
      return readerError({
        _tag: "AmbiguousRoot",
        selector,
        candidates: matches.map((connection) => connection.info),
      });
    });

  const disconnected = (connection: Connection) =>
    Effect.flatMap(Deferred.await(connection.closed), (reason) =>
      reason._tag === "Violation"
        ? readerError({
            _tag: "RootProtocolError",
            root: connection.info.id,
            incarnation: connection.info.incarnation,
            detail: reason.detail,
          })
        : readerError({
            _tag: "RootDisconnected",
            root: connection.info.id,
            incarnation: connection.info.incarnation,
          }),
    );

  const inspectRoot = (connection: Connection, deadlineMillis: number) =>
    Effect.gen(function* () {
      const client = yield* Deferred.await(connection.client);
      const snapshot = yield* client.Inspect({ maxBytes: maxSnapshotBytes }).pipe(
        Effect.catchTags({
          RpcClientError: (error) =>
            // Prefer the socket's close reason when the link failed underneath.
            Effect.flatMap(Deferred.isDone(connection.closed), (done) =>
              done
                ? disconnected(connection)
                : readerError({
                    _tag: "RootProtocolError",
                    root: connection.info.id,
                    incarnation: connection.info.incarnation,
                    detail: error.message.slice(0, 256),
                  }),
            ),
          SnapshotTooLarge: (error) => readerError(error),
        }),
      );
      return snapshot;
    }).pipe(
      Effect.raceFirst(disconnected(connection)),
      Effect.timeoutOrElse({
        duration: deadlineMillis,
        orElse: () =>
          readerError({
            _tag: "DeadlineExceeded",
            root: connection.info.id,
            deadlineMillis,
          }),
      }),
    );

  const readerGuard = (request: Request) =>
    Effect.gen(function* () {
      const origin = request.headers.get("origin");
      if (origin !== null) {
        return yield* readerError({ _tag: "ForbiddenOrigin", origin: origin.slice(0, 256) });
      }
      if (!sameSecret(options.readToken, bearer(request))) {
        return yield* readerError({ _tag: "Unauthorized" });
      }
      const version = request.headers.get(Protocol.wire.versionHeader) ?? "";
      if (version !== String(Protocol.wire.version)) {
        return yield* readerError({
          _tag: "UnsupportedProtocolVersion",
          received: version.slice(0, 32),
          supported: [Protocol.wire.version],
        });
      }
    });

  const handleRoots = Effect.sync(() =>
    json(encodeRoots({ _tag: "Roots", version: Protocol.wire.version, roots: rootInfos() }), 200),
  );

  const handleInspect = (request: Request) =>
    Effect.gen(function* () {
      const text = yield* readBody(request);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return yield* readerError({ _tag: "MalformedRequest", detail: "body is not JSON" });
      }
      const decoded = decodeInspectRequest(body);
      if (Exit.isFailure(decoded)) return yield* readerError(requestError(body));
      const { root, deadlineMillis } = decoded.value;
      const connection = yield* select(root);
      counters.readsStarted += 1;
      counters.pendingReads += 1;
      const snapshot = yield* inspectRoot(connection, deadlineMillis).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            counters.readsInterrupted += 1;
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            counters.pendingReads -= 1;
          }),
        ),
      );
      return json(
        encodeInspection({
          _tag: "Inspection",
          version: Protocol.wire.version,
          root: connection.info,
          snapshot,
        }),
        200,
      );
    });

  const handleReader = (request: Request, path: string) =>
    Effect.gen(function* () {
      yield* readerGuard(request);
      if (path === Protocol.wire.rootsPath && request.method === "GET") return yield* handleRoots;
      if (path === Protocol.wire.inspectPath && request.method === "POST")
        return yield* handleInspect(request);
      return yield* readerError({ _tag: "NotFound", path: path.slice(0, 128) });
    }).pipe(
      Effect.catchTag("ReaderFailure", (failure) => Effect.succeed(errorResponse(failure.error))),
    );

  const listener = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        Bun.serve<RootData>({
          hostname: "127.0.0.1",
          port: options.port ?? 0,
          fetch(request, bunServer) {
            if (!hostAllowed(request)) {
              return errorResponse({
                _tag: "ForbiddenHost",
                host: (request.headers.get("host") ?? "").slice(0, 256),
              });
            }
            const path = new URL(request.url).pathname;
            if (path === Protocol.wire.attachPath) return attach(request, bunServer);
            return Effect.runPromiseWith(context)(handleReader(request, path), {
              signal: request.signal,
            }).catch(() => new Response(null, { status: 499 }));
          },
          websocket: {
            maxPayloadLength: maxSnapshotBytes + 64 * 1024,
            idleTimeout: 30,
            open: openConnection,
            message: onMessage,
            close: closeConnection,
          },
        }),
      catch: (cause) =>
        GatewayListenError.make({
          port: options.port ?? 0,
          detail: cause instanceof Error ? cause.message.slice(0, 256) : "listen failed",
        }),
    }),
    (running) =>
      Effect.sync(() => {
        for (const connection of Array.from(registry.values())) {
          terminate(connection, { _tag: "Closed" }, 1001, "gateway closed");
        }
        running.stop(true);
      }),
  );
  port = listener.port ?? 0;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    attachUrl: `ws://127.0.0.1:${port}`,
    stats: Effect.sync(() => ({ roots: registry.size, ...counters })),
    roots: Effect.sync(rootInfos),
    disconnectRoot: (rootId) =>
      Effect.sync(() => {
        const connection = registry.get(rootId);
        if (connection === undefined) return false;
        terminate(connection, { _tag: "Closed" }, 4000, "disconnected by gateway");
        return true;
      }),
  } satisfies Gateway;
});
