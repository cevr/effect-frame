/* oxlint-disable effect/noGlobals -- this module is the browser boundary: it measures encoded bytes with TextEncoder and dials with the global WebSocket constructor. */
/**
 * The opt-in browser attachment, exported as `attachGateway`. Import it from a development entry only; a
 * production entry that does not import `effect-frame/inspection` carries no
 * inspection, RPC, or socket code.
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
import { Clock, Context, Duration, Effect, Layer, Option, Predicate, Schema, Scope } from "effect";
import { NetAddress } from "effect/unstable/net";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { Socket, SocketServer } from "effect/unstable/socket";
import { RootId, RootName, RootRpcs, wire, type SnapshotTooLarge } from "./protocol.js";
import * as Frame from "../frame.js";

export type AttachStatus =
  | { readonly _tag: "Connecting"; readonly attempt: number }
  | { readonly _tag: "Connected"; readonly attempt: number }
  | { readonly _tag: "Disconnected"; readonly attempt: number; readonly retryInMillis: number };

export interface AttachOptions {
  /** The gateway origin, for example `ws://127.0.0.1:4318`. Loopback only. */
  readonly url: string;
  /** The attach capability issued by the gateway. */
  readonly token: string;
  /**
   * Optional status observer for development diagnostics. A throw from it is
   * ignored; it never stops the connection loop.
   */
  readonly onStatus?: (status: AttachStatus) => void;
  /** The first retry delay. Finite and positive. Defaults to 250. */
  readonly initialRetryMillis?: number;
  /** The largest retry delay. Finite, positive, and not below the first. Defaults to 5000. */
  readonly maxRetryMillis?: number;
  /** How long one dial may take to open. Finite and positive. Defaults to 2000. */
  readonly openTimeoutMillis?: number;
}

/** The attachment was configured with a gateway it must not dial. */
export class InvalidAttachOptions extends Schema.TaggedError<InvalidAttachOptions>()(
  "InvalidAttachOptions",
  { detail: Schema.String },
) {}

/**
 * A connection that stayed open this long resets the retry delay. A shorter
 * one, such as a gateway that drops the root at once, keeps the backoff
 * growing.
 */
const STABLE_CONNECTION_MILLIS = 1_000;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;

const invalid = (detail: string) => InvalidAttachOptions.make({ detail });

const gatewayAddress = Effect.fn("InspectionAttach.gatewayAddress")(function* (url: string) {
  const parsed = yield* Effect.try({
    try: () => new URL(url),
    catch: () => invalid("gateway URL does not parse"),
  });
  if (parsed.protocol !== "ws:") return yield* invalid("gateway URL must use ws:");
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    return yield* invalid("gateway URL must be 127.0.0.1 or localhost");
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0) {
    return yield* invalid("gateway URL needs an explicit port");
  }
  return { origin: parsed.origin, port };
});

/** One optional duration: finite and positive, or its default. */
const millis = (name: string, value: Option.Option<number>, fallback: number) =>
  Option.match(value, {
    onNone: () => Effect.succeed(fallback),
    onSome: (given) => {
      if (Number.isFinite(given) && given > 0) return Effect.succeed(given);
      return Effect.fail(invalid(`${name} must be a finite number above 0`));
    },
  });

const timing = Effect.fn("InspectionAttach.timing")(function* (options: AttachOptions) {
  const initialRetry = yield* millis(
    "initialRetryMillis",
    Option.fromNullishOr(options.initialRetryMillis),
    250,
  );
  const maxRetry = yield* millis(
    "maxRetryMillis",
    Option.fromNullishOr(options.maxRetryMillis),
    Math.max(5_000, initialRetry),
  );
  if (maxRetry < initialRetry) {
    return yield* invalid("maxRetryMillis must not be below initialRetryMillis");
  }
  const openTimeout = yield* millis(
    "openTimeoutMillis",
    Option.fromNullishOr(options.openTimeoutMillis),
    2_000,
  );
  return { initialRetry, maxRetry, openTimeout };
});

const isRootId = Schema.is(RootId);
const isRootName = Schema.is(RootName);

/** The root identity the gateway registers, checked before any dial. */
const rootIdentity = (root: Frame.Snapshot["root"]) =>
  Effect.gen(function* () {
    if (!isRootId(root.id)) return yield* invalid("the Frame root ID is not a valid root ID");
    const name = Option.map(Option.fromNullishOr(root.name), (value) => value.slice(0, 128));
    if (Option.exists(name, (value) => !isRootName(value))) {
      return yield* invalid("the Frame root name has control characters");
    }
    return { id: root.id, name };
  });

const encoder = new TextEncoder();

/** Browsers take only subprotocols; they cannot send handshake headers. */
const browserProtocols = (
  options: Option.Option<Socket.WebSocketConstructorOptions>,
): string | Array<string> =>
  Option.match(Option.filter(options, Predicate.or(Array.isArray, Predicate.isString)), {
    onNone: () => [],
    onSome: (protocols) => protocols,
  });

const dialWebSocket = (
  url: string,
  options?: Socket.WebSocketConstructorOptions,
): Socket.WebSocketLike => new WebSocket(url, browserProtocols(Option.fromNullishOr(options)));

const encodeSnapshot = Schema.encodeSync(Frame.Snapshot);

const measure = (snapshot: Frame.Snapshot): number =>
  encoder.encode(JSON.stringify(encodeSnapshot(snapshot))).byteLength;

/**
 * Attach the current root's Frame service to a loopback inspection gateway.
 *
 * It checks the options and the root identity first and fails with
 * `InvalidAttachOptions` when either is unusable. Then it forks one scoped
 * connection loop and returns at once; mount never waits for the gateway.
 * The loop ends when the caller's scope closes. Retry delays double from
 * `initialRetryMillis` up to `maxRetryMillis`, and reset only after a
 * connection stayed open for one second. The timers use
 * Effect's live clock, so an application TestClock neither freezes nor
 * advances them.
 */
export const attachGateway = Effect.fn("InspectionAttach.attachGateway")(function* (
  options: AttachOptions,
) {
  const address = yield* gatewayAddress(options.url);
  if (!TOKEN_PATTERN.test(options.token)) {
    return yield* invalid("attach token has an invalid shape");
  }
  const { initialRetry, maxRetry, openTimeout } = yield* timing(options);
  const frame = yield* Frame.Service;
  // The construction context supplies application services to inspection only.
  const applicationContext = Context.omit(Scope.Scope)(yield* Effect.context<Frame.Service>());
  const liveClock = Context.get(Context.empty(), Clock.Clock);
  const report = Option.fromNullishOr(options.onStatus);
  // A throwing observer is a development diagnostic's bug; the loop outlives it.
  const notify = (status: AttachStatus): Effect.Effect<void> =>
    Option.match(report, {
      onNone: () => Effect.void,
      onSome: (onStatus) => Effect.asVoid(Effect.exit(Effect.sync(() => onStatus(status)))),
    });

  const sample = Effect.provideContext(frame.inspect, applicationContext);

  // The root identity is read once, from the service itself, before any dial.
  const identity = yield* Effect.flatMap(sample, (snapshot) => rootIdentity(snapshot.root));
  const dialUrl = new URL(wire.attachPath, address.origin);
  dialUrl.searchParams.set("root", identity.id);
  Option.map(identity.name, (name) => dialUrl.searchParams.set("name", name));

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
      let connectedAt = Option.none<number>();
      const outgoing = yield* Socket.makeWebSocket(dialUrl.href, {
        protocols: [wire.subprotocol, `${wire.attachTokenPrefix}${options.token}`],
        openTimeout: Duration.millis(openTimeout),
      });
      const socket = Socket.make({
        reader: Effect.tap(outgoing.reader, () =>
          Effect.flatMap(Clock.currentTimeMillis, (now) =>
            Effect.andThen(
              Effect.sync(() => {
                connectedAt = Option.some(now);
              }),
              notify({ _tag: "Connected", attempt }),
            ),
          ),
        ),
        writer: outgoing.writer,
      });
      return { socket, connectedAt: () => connectedAt };
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
          const endedAt = yield* Clock.currentTimeMillis;
          if (Option.exists(dial.connectedAt(), (at) => endedAt - at >= STABLE_CONNECTION_MILLIS)) {
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
