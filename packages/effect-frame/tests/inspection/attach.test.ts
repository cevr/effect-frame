/* oxlint-disable effect/noGlobals, effect/noThrowStatement, effect/noNewError -- the fake gateway is a raw Bun WebSocket server at the test boundary. */
/**
 * The public `attachGateway` against a raw loopback peer. The peer plays the
 * gateway's side of the root link by hand: it accepts one upgrade, sends raw
 * RPC request frames, and reads the replies. The full gateway, reader, and
 * real-browser proofs live in `@effect-frame/inspect`.
 */
import { Deferred, Effect, Exit, Option, Queue, Schema } from "effect";
import { describe, expect, it } from "effect-bun-test";
import * as Frame from "effect-frame/frame";
import { Protocol, attachGateway, type AttachStatus } from "effect-frame/inspection";
import { Rpc, RpcSerialization } from "effect/unstable/rpc";

const TOKEN = "attach-token-0123456789abcdef";

interface Upgrade {
  readonly url: URL;
  readonly protocols: ReadonlyArray<string>;
}

interface PeerSocket {
  readonly send: (data: string) => void;
}

/**
 * A loopback WebSocket peer that records the first upgrade, counts every
 * upgrade, and keeps the frames. With `dropOnOpen` it closes each socket as
 * soon as it opens, as a gateway that drops a root at once.
 */
const peer = (dropOnOpen = false) =>
  Effect.gen(function* () {
    const upgrade = yield* Deferred.make<Upgrade>();
    const opened = yield* Deferred.make<PeerSocket>();
    const closed = yield* Deferred.make<number>();
    const frames = yield* Queue.unbounded<string>();
    let upgrades = 0;
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch(request, bunServer) {
            const protocols = Option.getOrElse(
              Option.fromNullishOr(request.headers.get("sec-websocket-protocol")),
              () => "",
            )
              .split(",")
              .map((value) => value.trim());
            upgrades += 1;
            Deferred.doneUnsafe(upgrade, Exit.succeed({ url: new URL(request.url), protocols }));
            const upgraded = bunServer.upgrade(request, {
              headers: { "Sec-WebSocket-Protocol": Protocol.wire.subprotocol },
            });
            if (upgraded) return;
            return new Response("upgrade required", { status: 400 });
          },
          websocket: {
            open: (ws) => {
              if (dropOnOpen) {
                ws.close(4000, "dropped at once");
                return;
              }
              Deferred.doneUnsafe(opened, Exit.succeed({ send: (data) => ws.send(data) }));
            },
            message: (_ws, message) => {
              Queue.offerUnsafe(frames, String(message));
            },
            close: (_ws, code) => {
              Deferred.doneUnsafe(closed, Exit.succeed(code));
            },
          },
        }),
      ),
      (running) => Effect.promise(() => running.stop(true)),
    );
    return {
      url: `ws://127.0.0.1:${server.port}`,
      upgrade,
      opened,
      closed,
      frames,
      upgrades: () => upgrades,
    };
  });

const decodeExit = Schema.decodeUnknownSync(
  RpcSerialization.json.codecFor(Rpc.exitSchema(Protocol.Inspect)),
);

/** Send one raw Inspect request and wait for its Exit frame. */
const inspectOver = (
  socket: PeerSocket,
  frames: Queue.Queue<string>,
  id: string,
  maxBytes: number,
) =>
  Effect.gen(function* () {
    socket.send(
      JSON.stringify({ _tag: "Request", id, tag: "Inspect", payload: { maxBytes }, headers: [] }),
    );
    while (true) {
      const frame = yield* Queue.take(frames);
      const messages: ReadonlyArray<{ readonly _tag: string; readonly exit?: unknown }> = [
        JSON.parse(frame),
      ].flat();
      const exit = Option.fromNullishOr(messages.find((message) => message._tag === "Exit"));
      if (Option.isSome(exit)) return decodeExit(exit.value.exit);
    }
  });

const frameLayer = Frame.layer({ name: "attach-test" });

describe("effect-frame/inspection attach", () => {
  it.scopedLive.layer(frameLayer)("refuses a gateway it must not dial", () =>
    Effect.gen(function* () {
      const refused = (url: string, token = TOKEN) =>
        attachGateway({ url, token }).pipe(
          Effect.flip,
          Effect.map((error) => error.detail),
        );
      expect(yield* refused("http://127.0.0.1:4318")).toBe("gateway URL must use ws:");
      expect(yield* refused("ws://example.com:4318")).toBe(
        "gateway URL must be 127.0.0.1 or localhost",
      );
      expect(yield* refused("ws://[::1]:4318")).toBe("gateway URL must be 127.0.0.1 or localhost");
      expect(yield* refused("ws://127.0.0.1")).toBe("gateway URL needs an explicit port");
      expect(yield* refused("not a url")).toBe("gateway URL does not parse");
      expect(yield* refused("ws://127.0.0.1:4318", "short")).toBe(
        "attach token has an invalid shape",
      );
    }),
  );

  it.scopedLive.layer(frameLayer)(
    "dials once with its identity, answers Inspect, and stops with its scope",
    () =>
      Effect.gen(function* () {
        const gateway = yield* peer();
        const direct = yield* Frame.inspect;
        const statuses: Array<string> = [];
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* attachGateway({
              url: gateway.url,
              token: TOKEN,
              onStatus: (status) => statuses.push(status._tag),
            });
            const upgrade = yield* Deferred.await(gateway.upgrade);
            expect(upgrade.url.pathname).toBe(Protocol.wire.attachPath);
            expect(upgrade.url.searchParams.get("root")).toBe(direct.root.id);
            expect(upgrade.url.searchParams.get("name")).toBe("attach-test");
            expect(upgrade.protocols).toEqual([
              Protocol.wire.subprotocol,
              `${Protocol.wire.attachTokenPrefix}${TOKEN}`,
            ]);
            const socket = yield* Deferred.await(gateway.opened);

            const sample = yield* inspectOver(socket, gateway.frames, "1", 4 * 1024 * 1024);
            expect(Exit.isSuccess(sample)).toBe(true);
            if (Exit.isSuccess(sample)) expect(sample.value.root.id).toBe(direct.root.id);

            const tooLarge = yield* inspectOver(socket, gateway.frames, "2", 16);
            expect(Exit.isFailure(tooLarge)).toBe(true);
            expect(JSON.stringify(tooLarge)).toContain("SnapshotTooLarge");
          }),
        );
        // Closing the attachment scope closes the socket and ends the loop.
        yield* Deferred.await(gateway.closed).pipe(Effect.timeout("2 seconds"));
        expect(statuses.slice(0, 2)).toEqual(["Connecting", "Connected"]);
      }),
    10_000,
  );

  it.scopedLive.layer(frameLayer)("refuses retry timing it cannot honour", () =>
    Effect.gen(function* () {
      const refused = (
        timing: Partial<
          Record<"initialRetryMillis" | "maxRetryMillis" | "openTimeoutMillis", number>
        >,
      ) =>
        attachGateway({ url: "ws://127.0.0.1:4318", token: TOKEN, ...timing }).pipe(
          Effect.flip,
          Effect.map((error) => error.detail),
        );
      for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(yield* refused({ initialRetryMillis: bad })).toBe(
          "initialRetryMillis must be a finite number above 0",
        );
        expect(yield* refused({ maxRetryMillis: bad })).toBe(
          "maxRetryMillis must be a finite number above 0",
        );
        expect(yield* refused({ openTimeoutMillis: bad })).toBe(
          "openTimeoutMillis must be a finite number above 0",
        );
      }
      expect(yield* refused({ initialRetryMillis: 400, maxRetryMillis: 100 })).toBe(
        "maxRetryMillis must not be below initialRetryMillis",
      );
    }),
  );

  it.scopedLive.layer(Frame.layer({ name: "bad\u001b]0;title\u0007name" }))(
    "refuses a root name with control characters before any dial",
    () =>
      Effect.gen(function* () {
        const gateway = yield* peer();
        const error = yield* Effect.flip(attachGateway({ url: gateway.url, token: TOKEN }));
        expect(error.detail).toBe("the Frame root name has control characters");
        yield* Effect.sleep("150 millis");
        expect(gateway.upgrades()).toBe(0);
      }),
  );

  it.scopedLive.layer(frameLayer)(
    "keeps dialing when the status observer throws",
    () =>
      Effect.gen(function* () {
        const gateway = yield* peer(true);
        const seen: Array<string> = [];
        yield* attachGateway({
          url: gateway.url,
          token: TOKEN,
          initialRetryMillis: 10,
          maxRetryMillis: 20,
          onStatus: (status) => {
            seen.push(status._tag);
            throw new Error("observer bug");
          },
        });
        yield* Effect.sleep("300 millis");
        expect(gateway.upgrades()).toBeGreaterThanOrEqual(3);
        expect(seen.filter((tag) => tag === "Disconnected").length).toBeGreaterThanOrEqual(2);
      }),
    10_000,
  );

  it.scopedLive.layer(frameLayer)(
    "doubles the retry delay and keeps it after a gateway drops the root at once",
    () =>
      Effect.gen(function* () {
        const gateway = yield* peer(true);
        const statuses: Array<AttachStatus> = [];
        yield* attachGateway({
          url: gateway.url,
          token: TOKEN,
          initialRetryMillis: 20,
          maxRetryMillis: 160,
          onStatus: (status) => statuses.push(status),
        });
        const delays = () =>
          statuses.flatMap((status) => {
            if (status._tag === "Disconnected") return [status.retryInMillis];
            return [];
          });
        yield* Effect.sleep("50 millis").pipe(
          Effect.repeat({ until: () => delays().length >= 6 }),
          Effect.timeout("5 seconds"),
        );
        // Every dial opened, so a reset on open would have kept 20 forever.
        expect(
          statuses.filter((status) => status._tag === "Connected").length,
        ).toBeGreaterThanOrEqual(5);
        expect(delays().slice(0, 6)).toEqual([20, 40, 80, 160, 160, 160]);
      }),
    10_000,
  );
});
