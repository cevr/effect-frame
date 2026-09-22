/* oxlint-disable effect/noGlobals, effect/noRuntimeTypeof, effect/noTernary -- this module is the browser boundary: it measures encoded bytes with TextEncoder and dials with the global WebSocket constructor. */
/**
 * The opt-in browser attachment.
 *
 * It reads the root's existing `Frame.Service` and captures the context that
 * built it. It does not build a second Frame layer, copy records, or keep
 * snapshots. Each gateway request takes one fresh sample.
 *
 * Connection direction: a browser cannot listen, so the browser dials the
 * gateway. Over that one outgoing socket the browser is the RPC server and
 * the gateway is the RPC client. The native `RpcServer` only accepts sockets
 * from a `SocketServer`, so this module supplies a `SocketServer` whose `run`
 * loop dials instead of accepting: one outgoing socket at a time, each handed
 * to the native socket protocol as one client. A reconnect is a new client;
 * `RpcServer` interrupts the old client's handlers when its socket closes.
 */
import * as Frame from "effect-frame/frame";
import { Clock, Context, Duration, Effect, Layer, Option, Schema, Scope } from "effect";
import { NetAddress } from "effect/unstable/net";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { Socket, SocketServer } from "effect/unstable/socket";
import {
  ATTACH_PATH,
  ATTACH_TOKEN_PREFIX,
  MAX_ROOT_NAME_LENGTH,
  ROOT_SUBPROTOCOL,
  RootRpcs,
  type SnapshotTooLarge,
} from "./protocol.js";

export type AttachStatus =
  | { readonly _tag: "Connecting"; readonly attempt: number }
  | { readonly _tag: "Connected"; readonly attempt: number }
  | { readonly _tag: "Disconnected"; readonly attempt: number; readonly retryInMillis: number };

export interface AttachOptions {
  /** The gateway origin, for example `ws://127.0.0.1:4318`. Loopback only. */
  readonly url: string;
  /** The attach capability issued by the gateway. */
  readonly token: string;
  /** Optional status observer for development diagnostics. */
  readonly onStatus?: (status: AttachStatus) => void;
  readonly initialRetryMillis?: number;
  readonly maxRetryMillis?: number;
  readonly openTimeoutMillis?: number;
}

/** The attachment was configured with a gateway it must not dial. */
export class InvalidAttachOptions extends Schema.TaggedError<InvalidAttachOptions>()(
  "InvalidAttachOptions",
  { detail: Schema.String },
) {}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;

const gatewayAddress = Effect.fn("InspectionAttach.gatewayAddress")(function* (url: string) {
  const parsed = yield* Effect.try({
    try: () => new URL(url),
    catch: () => InvalidAttachOptions.make({ detail: "gateway URL does not parse" }),
  });
  if (parsed.protocol !== "ws:") {
    return yield* InvalidAttachOptions.make({ detail: "gateway URL must use ws:" });
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    return yield* InvalidAttachOptions.make({ detail: "gateway URL must be loopback" });
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0) {
    return yield* InvalidAttachOptions.make({ detail: "gateway URL needs an explicit port" });
  }
  return { origin: parsed.origin, port };
});

const encoder = new TextEncoder();

/** Browsers take only subprotocols; they cannot send handshake headers. */
const dialWebSocket = (
  url: string,
  options?: Socket.WebSocketConstructorOptions,
): Socket.WebSocketLike =>
  new WebSocket(url, Array.isArray(options) || typeof options === "string" ? options : []);

const encodeSnapshot = Schema.encodeSync(Frame.Snapshot);

const measure = (snapshot: Frame.Snapshot): number =>
  encoder.encode(JSON.stringify(encodeSnapshot(snapshot))).byteLength;

/**
 * Attach the current root's Frame service to a loopback gateway.
 *
 * The returned effect forks one scoped connection loop and returns at once;
 * mount never waits for the gateway. The loop ends when the caller's scope
 * closes. Its retry timers use Effect's live clock, so an application
 * TestClock neither freezes nor advances them.
 */
export const attach = Effect.fn("InspectionAttach.attach")(function* (options: AttachOptions) {
  const address = yield* gatewayAddress(options.url);
  if (!TOKEN_PATTERN.test(options.token)) {
    return yield* InvalidAttachOptions.make({ detail: "attach token has an invalid shape" });
  }
  const frame = yield* Frame.Service;
  // The construction context supplies application services to inspection only.
  const applicationContext = Context.omit(Scope.Scope)(yield* Effect.context<Frame.Service>());
  const liveClock = Context.get(Context.empty(), Clock.Clock);
  const report = Option.fromNullishOr(options.onStatus);
  const notify = (status: AttachStatus): Effect.Effect<void> =>
    Option.match(report, {
      onNone: () => Effect.void,
      onSome: (onStatus) => Effect.sync(() => onStatus(status)),
    });
  const initialRetry = Option.getOrElse(
    Option.fromNullishOr(options.initialRetryMillis),
    () => 250,
  );
  const maxRetry = Option.getOrElse(Option.fromNullishOr(options.maxRetryMillis), () => 5_000);
  const openTimeout = Option.getOrElse(
    Option.fromNullishOr(options.openTimeoutMillis),
    () => 2_000,
  );

  const sample = Effect.provideContext(frame.inspect, applicationContext);

  // The root identity is read once, from the service itself, on first dial.
  // oxlint-disable-next-line effect/noPerCallCacheConstruction -- one identity cache per attachment is the owner.
  const identity = yield* Effect.cached(Effect.map(sample, (snapshot) => snapshot.root));
  const dialUrl = Effect.map(identity, (root) => {
    const url = new URL(ATTACH_PATH, address.origin);
    url.searchParams.set("root", root.id);
    Option.map(Option.fromNullishOr(root.name), (name) =>
      url.searchParams.set("name", name.slice(0, MAX_ROOT_NAME_LENGTH)),
    );
    return url.href;
  });

  const handlers = RootRpcs.toLayer({
    Inspect: ({ maxBytes }) =>
      Effect.flatMap(sample, (snapshot) => {
        const bytes = measure(snapshot);
        if (bytes > maxBytes) {
          return Effect.fail({
            _tag: "SnapshotTooLarge",
            bytes,
            limit: maxBytes,
          } satisfies SnapshotTooLarge);
        }
        return Effect.succeed(snapshot);
      }),
  });

  const dialOnce = (attempt: number) =>
    Effect.gen(function* () {
      let connected = false;
      const outgoing = yield* Socket.makeWebSocket(dialUrl, {
        protocols: [ROOT_SUBPROTOCOL, `${ATTACH_TOKEN_PREFIX}${options.token}`],
        openTimeout: Duration.millis(openTimeout),
      });
      const socket = Socket.make({
        reader: Effect.tap(outgoing.reader, () =>
          Effect.andThen(
            Effect.sync(() => {
              connected = true;
            }),
            notify({ _tag: "Connected", attempt }),
          ),
        ),
        writer: outgoing.writer,
      });
      return { socket, connected: () => connected };
    });

  // A SocketServer whose connections are outgoing dials. `run` never
  // returns; it ends only by interruption when the attachment scope closes.
  const dialer = SocketServer.SocketServer.of({
    address: NetAddress.inetAddressUnsafe(NetAddress.ipv4Loopback, address.port),
    run: (handler) =>
      Effect.gen(function* () {
        let attempt = 0;
        let delay = initialRetry;
        while (true) {
          attempt += 1;
          yield* notify({ _tag: "Connecting", attempt });
          const dial = yield* dialOnce(attempt);
          // A failed open ends the handler with a defect; either way this
          // incarnation is over and its RpcServer client is disconnected.
          yield* Effect.exit(Effect.scoped(handler(dial.socket)));
          if (dial.connected()) {
            delay = initialRetry;
          }
          yield* notify({ _tag: "Disconnected", attempt, retryInMillis: delay });
          yield* Effect.sleep(Duration.millis(delay));
          delay = Math.min(maxRetry, delay * 2);
        }
      }).pipe(Effect.provideService(Socket.WebSocketConstructor, dialWebSocket)),
  });

  const server = Effect.gen(function* () {
    const handlerContext = yield* Layer.build(handlers);
    const protocol = yield* RpcServer.makeProtocolSocketServer.pipe(
      Effect.provideService(SocketServer.SocketServer, dialer),
    );
    return yield* RpcServer.make(RootRpcs).pipe(
      Effect.provideService(RpcServer.Protocol, protocol),
      Effect.provideContext(handlerContext),
    );
  }).pipe(
    Effect.provideService(RpcSerialization.RpcSerialization, RpcSerialization.json),
    Effect.provideService(Clock.Clock, liveClock),
    Effect.scoped,
  );

  yield* Effect.forkScoped(server);
});
