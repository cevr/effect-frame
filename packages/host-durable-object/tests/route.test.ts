import { Effect } from "effect";
import { describe, expect, it } from "effect-bun-test";
import type { DurableObjectNamespace } from "../src/route.js";
import { route } from "../src/route.js";

/**
 * The Worker router over a recording namespace. Each object echoes what it
 * received, so a test reads which object a request reached and what path,
 * method and body it saw.
 */

interface Received {
  readonly object: string;
  readonly path: string;
  readonly method: string;
  readonly body: string;
}

const recording = () => {
  const named: Array<string> = [];
  const namespace: DurableObjectNamespace<string> = {
    idFromName: (name) => {
      named.push(name);
      return `id:${name}`;
    },
    get: (id) => ({
      fetch: (request) =>
        request.text().then((body) => {
          const url = new URL(request.url);
          return Response.json({
            object: id,
            path: `${url.pathname}${url.search}`,
            method: request.method,
            body,
          } satisfies Received);
        }),
    }),
  };
  return { named, handler: route(namespace) };
};

const send = (handler: (request: Request) => Promise<Response>, path: string, init?: RequestInit) =>
  Effect.promise(() => handler(new Request(`http://worker.test${path}`, init)));

/** The key segment a client writes: the JSON-encoded string key, escaped. */
const key = (value: string): string => encodeURIComponent(`"${value}"`);

describe("route", () => {
  it.effect("sends an address to the object named contract@version/key", () =>
    Effect.gen(function* () {
      const { named, handler } = recording();
      const response = yield* send(handler, `/actors/Counter/1/${key("alice")}/send`, {
        method: "POST",
        body: '{"message":1}',
      });
      const received = yield* Effect.promise(() => response.json());
      expect(named).toEqual(['Counter@1/"alice"']);
      expect(received).toEqual({
        object: 'id:Counter@1/"alice"',
        path: "/send",
        method: "POST",
        body: '{"message":1}',
      });
    }),
  );

  it.effect("rewrites every generic verb to its bare path and keeps the query", () =>
    Effect.gen(function* () {
      const { handler } = recording();
      const paths = yield* Effect.forEach(["send", "call", "snapshot", "changes"], (verb) =>
        Effect.flatMap(
          send(handler, `/actors/Counter/1/${key("a")}/${verb}?contract=Counter&version=1`),
          (response) =>
            Effect.map(
              Effect.promise(() => response.json()),
              (received: Received) => received.path,
            ),
        ),
      );
      expect(paths).toEqual([
        "/send?contract=Counter&version=1",
        "/call?contract=Counter&version=1",
        "/snapshot?contract=Counter&version=1",
        "/changes?contract=Counter&version=1",
      ]);
    }),
  );

  it.effect("gives each key and each version its own object", () =>
    Effect.gen(function* () {
      const { named, handler } = recording();
      yield* send(handler, `/actors/Counter/1/${key("alice")}/snapshot`);
      yield* send(handler, `/actors/Counter/1/${key("bob")}/snapshot`);
      yield* send(handler, `/actors/Counter/2/${key("alice")}/snapshot`);
      yield* send(handler, `/actors/Counter/1/${key("alice")}/call`);
      expect(named).toEqual([
        'Counter@1/"alice"',
        'Counter@1/"bob"',
        'Counter@2/"alice"',
        'Counter@1/"alice"',
      ]);
    }),
  );

  it.effect("answers 404 for a path the wire does not use and touches no object", () =>
    Effect.gen(function* () {
      const { named, handler } = recording();
      const statuses = yield* Effect.forEach(
        [
          "/",
          "/actors/Counter/1/send",
          `/actors/Counter/1/${key("a")}/delete`,
          `/other/Counter/1/${key("a")}/send`,
          `/actors/Counter/1/${key("a")}/send/extra`,
          "/actors/Counter/1/%E0%A4%A/send",
        ],
        (path) => Effect.map(send(handler, path), (response) => response.status),
      );
      expect(statuses).toEqual([404, 404, 404, 404, 404, 404]);
      expect(named).toEqual([]);
    }),
  );
});
