/* oxlint-disable effect/noGlobals -- the fake gateway is a raw Bun WebSocket server at the test boundary. */
/**
 * The public `attach` against a raw loopback peer. The peer plays the
 * gateway's side of the root link by hand: it accepts one upgrade, sends raw
 * RPC request frames, and reads the replies. The full gateway, reader, and
 * real-browser proofs live in `@effect-frame/inspect`.
 */
import { Deferred, Effect, Exit, Option, Queue, Schema } from "effect";
import { describe, expect, it } from "effect-bun-test";
import * as Frame from "effect-frame/frame";
import { Protocol, attach } from "effect-frame/inspection";
import { Rpc, RpcSerialization } from "effect/unstable/rpc";

const TOKEN = "attach-token-0123456789abcdef";

interface Upgrade {
  readonly url: URL;
  readonly protocols: ReadonlyArray<string>;
}

interface PeerSocket {
  readonly send: (data: string) => void;
}

/** A loopback WebSocket peer that records one upgrade and its frames. */
const peer = Effect.gen(function* () {
  const upgrade = yield* Deferred.make<Upgrade>();
  const opened = yield* Deferred.make<PeerSocket>();
  const closed = yield* Deferred.make<number>();
  const frames = yield* Queue.unbounded<string>();
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
          Deferred.doneUnsafe(upgrade, Exit.succeed({ url: new URL(request.url), protocols }));
          const upgraded = bunServer.upgrade(request, {
            headers: { "Sec-WebSocket-Protocol": Protocol.ROOT_SUBPROTOCOL },
          });
          if (upgraded) return;
          return new Response("upgrade required", { status: 400 });
        },
        websocket: {
          open: (ws) => {
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
  return { url: `ws://127.0.0.1:${server.port}`, upgrade, opened, closed, frames };
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
        attach({ url, token }).pipe(
          Effect.flip,
          Effect.map((error) => error.detail),
        );
      expect(yield* refused("http://127.0.0.1:4318")).toBe("gateway URL must use ws:");
      expect(yield* refused("ws://example.com:4318")).toBe("gateway URL must be loopback");
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
        const gateway = yield* peer;
        const direct = yield* Frame.inspect;
        const statuses: Array<string> = [];
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* attach({
              url: gateway.url,
              token: TOKEN,
              onStatus: (status) => statuses.push(status._tag),
            });
            const upgrade = yield* Deferred.await(gateway.upgrade);
            expect(upgrade.url.pathname).toBe(Protocol.ATTACH_PATH);
            expect(upgrade.url.searchParams.get("root")).toBe(direct.root.id);
            expect(upgrade.url.searchParams.get("name")).toBe("attach-test");
            expect(upgrade.protocols).toEqual([
              Protocol.ROOT_SUBPROTOCOL,
              `${Protocol.ATTACH_TOKEN_PREFIX}${TOKEN}`,
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
});
