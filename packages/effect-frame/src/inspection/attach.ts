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
import type { Stream } from "effect";
import {
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Predicate,
  Pull,
  Ref,
  Schedule,
  Schema,
  Scope,
  SubscriptionRef,
} from "effect";
import { NetAddress } from "effect/unstable/net";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { Socket, SocketServer } from "effect/unstable/socket";
import {
  RootId,
  RootName,
  RootRpcs,
  loopbackHosts,
  wire,
  type SnapshotTooLarge,
} from "./protocol.js";
import * as Frame from "../frame.js";

export type AttachStatus =
  | { readonly _tag: "Connecting"; readonly attempt: number }
  | { readonly _tag: "Connected"; readonly attempt: number }
  | { readonly _tag: "Disconnected"; readonly attempt: number; readonly retryInMillis: number }
  | { readonly _tag: "Stopped"; readonly attempt: number };

export interface AttachOptions {
  /** The gateway origin, for example `ws://127.0.0.1:4318`. Loopback only. */
  readonly url: string;
  /** The attach capability issued by the gateway. */
  readonly token: string;
  /**
   * The delay before each redial. A connection that stayed open for one
   * second starts the schedule over; a shorter one keeps it going. When the
   * schedule ends, the attachment stops dialing and reports `Stopped`.
   * `defaultRetry` doubles from 250 ms up to 5 s and never ends.
   */
  readonly retry: Schedule.Schedule<unknown>;
  /** How long one dial may take to open. `defaultOpenTimeout` is 2 s. */
  readonly openTimeout: Duration.Input;
}

/** A running attachment. Its lifetime is the scope `attachGateway` ran in. */
export interface Attachment {
  /**
   * The connection's status: the current value first, then each change.
   * Development diagnostics read it; the connection never waits for a reader.
   */
  readonly status: Stream.Stream<AttachStatus>;
}

/** Redial after 250 ms, doubling up to 5 s, for as long as the attachment lives. */
export const defaultRetry: Schedule.Schedule<unknown> = Schedule.exponential("250 millis").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(5))),
  ),
);

/** One dial may take 2 s to open. */
export const defaultOpenTimeout: Duration.Duration = Duration.seconds(2);

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

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;

const invalid = (detail: string) => InvalidAttachOptions.make({ detail });

const gatewayAddress = Effect.fn("InspectionAttach.gatewayAddress")(function* (url: string) {
  const parsed = yield* Effect.try({
    try: () => new URL(url),
    catch: () => invalid("gateway URL does not parse"),
  });
  if (parsed.protocol !== "ws:") return yield* invalid("gateway URL must use ws:");
  if (!loopbackHosts.includes(parsed.hostname)) {
    return yield* invalid("gateway URL must be 127.0.0.1 or localhost");
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0) {
    return yield* invalid("gateway URL needs an explicit port");
  }
  return { origin: parsed.origin, port };
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
 * connection loop and returns at once with the loop's status; mount never
 * waits for the gateway. The loop ends when the caller's scope closes. The
 * timers use Effect's live clock, so an application TestClock neither
 * freezes nor advances them.
 *
 * ```ts
 * const attachment = yield* attachGateway({
 *   url: config.gatewayUrl,
 *   token: config.gatewayToken,
 *   retry: defaultRetry,
 *   openTimeout: defaultOpenTimeout,
 * });
 * yield* Stream.runForEach(attachment.status, (status) => Effect.logDebug(status._tag)).pipe(
 *   Effect.forkScoped,
 * );
 * ```
 */
export const attachGateway = Effect.fn("InspectionAttach.attachGateway")(function* (
  options: AttachOptions,
) {
  const address = yield* gatewayAddress(options.url);
  if (!TOKEN_PATTERN.test(options.token)) {
    return yield* invalid("attach token has an invalid shape");
  }
  const frame = yield* Frame.Service;
  // The construction context supplies application services to inspection only.
  const applicationContext = Context.omit(Scope.Scope)(yield* Effect.context<Frame.Service>());
  const liveClock = Context.get(Context.empty(), Clock.Clock);
  const status = yield* SubscriptionRef.make<AttachStatus>({ _tag: "Connecting", attempt: 1 });
  const report = (next: AttachStatus) => SubscriptionRef.set(status, next);

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
      const connectedAt = yield* Ref.make(Option.none<number>());
      const outgoing = yield* Socket.makeWebSocket(dialUrl.href, {
        protocols: [wire.subprotocol, `${wire.attachTokenPrefix}${options.token}`],
        openTimeout: options.openTimeout,
      });
      const socket = Socket.make({
        reader: Effect.tap(outgoing.reader, () =>
          Effect.flatMap(Clock.currentTimeMillis, (now) =>
            Effect.andThen(
              Ref.set(connectedAt, Option.some(now)),
              report({ _tag: "Connected", attempt }),
            ),
          ),
        ),
        writer: outgoing.writer,
      });
      return { socket, connectedAt: Ref.get(connectedAt) };
    });

  /** The retry schedule, started over. */
  const freshStep = Schedule.toStep(options.retry);

  // A SocketServer whose connections are outgoing dials. `run` never
  // returns; it ends only by interruption when the attachment scope closes.
  const dialer = SocketServer.SocketServer.of({
    address: NetAddress.inetAddressUnsafe(NetAddress.ipv4Loopback, address.port),
    run: (handler) =>
      Effect.gen(function* () {
        const attempt = yield* Ref.make(1);
        const step = yield* Ref.make(yield* freshStep);
        const cycle = Effect.gen(function* () {
          // The status starts at `Connecting` 1; each redial reports its own.
          const current = yield* Ref.get(attempt);
          const dial = yield* dialOnce(current);
          // A failed open ends the handler with a defect; either way this
          // incarnation is over and its RpcServer client is disconnected.
          yield* Effect.exit(Effect.scoped(handler(dial.socket)));
          const endedAt = yield* Clock.currentTimeMillis;
          const stable = Option.exists(
            yield* dial.connectedAt,
            (at) => endedAt - at >= STABLE_CONNECTION_MILLIS,
          );
          if (stable) yield* Ref.set(step, yield* freshStep);
          const delay = yield* Effect.flatMap(Ref.get(step), (next) => next(endedAt, current));
          yield* report({
            _tag: "Disconnected",
            attempt: current,
            retryInMillis: Duration.toMillis(delay[1]),
          });
          yield* Effect.sleep(delay[1]);
          yield* Ref.set(attempt, current + 1);
          yield* report({ _tag: "Connecting", attempt: current + 1 });
        });
        return yield* Effect.forever(cycle).pipe(
          // The schedule ended: the attachment stops dialing and waits for its scope.
          Pull.catchDone(() =>
            Effect.andThen(
              Effect.flatMap(Ref.get(attempt), (last) =>
                report({ _tag: "Stopped", attempt: last }),
              ),
              Effect.never,
            ),
          ),
        );
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
  const attachment: Attachment = { status: SubscriptionRef.changes(status) };
  return attachment;
});
