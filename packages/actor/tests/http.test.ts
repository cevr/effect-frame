import { Effect, Exit, Layer, Option, Schema, Scope, Stream } from "effect";
import { describe, expect, it } from "effect-bun-test";
import {
  ActorHost,
  Behavior,
  CommandId,
  HttpServer,
  implementTransparent,
} from "@effect-frame/actor";
import { HttpTransport, Unauthorized, contract, ref } from "@effect-frame/actor/client";
import type { Address } from "@effect-frame/actor/client";

const Add = Schema.TaggedStruct("Add", { amount: Schema.Finite });
type Add = Schema.Schema.Type<typeof Add>;

const Counter = contract("Counter", {
  version: 1,
  key: Schema.Struct({ tenant: Schema.String, id: Schema.String }),
  snapshot: Schema.Finite,
  message: Schema.Union([Add]),
});

const CounterLive = implementTransparent(
  Counter,
  Behavior.reducer<number, Add>({ initial: 0, reduce: (state, message) => state + message.amount }),
);

const id = Schema.decodeSync(CommandId);
const add = (amount: number): Add => ({ _tag: "Add", amount });
const alice = { tenant: "acme", id: "alice" };

const acmeOnly = Layer.succeed(ActorHost.Authorizer, {
  authorize: (address: Address) => {
    if (address.key.includes('"acme"')) {
      return Effect.void;
    }
    return Effect.fail(Unauthorized.make({ contract: address.contract }));
  },
});

const hostLayer = Layer.provide(ActorHost.layerMemory([CounterLive]), acmeOnly);

/**
 * The server handler and the client transport meet at a `fetch` function.
 * In process, that function is the handler itself: no socket, same wire.
 */
const inProcess = Layer.unwrap(
  Effect.gen(function* () {
    const server = yield* HttpServer.make;
    const context = yield* Effect.context<never>();
    const run = Effect.runPromiseWith(context);
    const fetch: HttpTransport.FetchLike = (input, init) => run(server(new Request(input, init)));
    return HttpTransport.layer({
      baseUrl: "http://actors.test/actors",
      reconnect: HttpTransport.defaultReconnect,
    }).pipe(Layer.provide(Layer.succeed(HttpTransport.Fetch, fetch)));
  }),
).pipe(Layer.provide(hostLayer));

const withInProcess = it.scoped.layer(inProcess);

describe("http transport in process", () => {
  withInProcess("call, snapshot, and changes cross the wire", () =>
    Effect.gen(function* () {
      const writer = yield* ref(Counter, alice);
      const reader = yield* ref(Counter, alice);
      const applied = yield* writer.call(add(3), { commandId: id("c1"), timeout: "1 second" });
      expect(applied).toEqual({ revision: 1, state: 3 });
      const seen = yield* Stream.runHead(Stream.filter(reader.state.changes, (n) => n === 3));
      expect(seen).toEqual(Option.some(3));
      const fresh = yield* ref(Counter, alice);
      expect(yield* fresh.applied.get).toEqual({ revision: 1, state: 3 });
    }),
  );

  withInProcess("a receipt round-trips with its Option", () =>
    Effect.gen(function* () {
      const counter = yield* ref(Counter, alice);
      const first = yield* counter.send(add(1), { commandId: id("c1") });
      expect(first.admitted).toBe(1);
      yield* counter.call(add(1), { commandId: id("c1"), timeout: "1 second" });
      const again = yield* counter.send(add(1), { commandId: id("c1") });
      expect(again.committed).toEqual(Option.some(1));
    }),
  );

  withInProcess("typed failures survive the wire with their status", () =>
    Effect.gen(function* () {
      const counter = yield* ref(Counter, alice);
      yield* counter.call(add(1), { commandId: id("c1"), timeout: "1 second" });
      const conflict = yield* Effect.flip(counter.send(add(2), { commandId: id("c1") }));
      expect(conflict._tag).toBe("CommandConflict");
      const denied = yield* Effect.flip(ref(Counter, { tenant: "other", id: "x" }));
      expect(denied._tag).toBe("Unauthorized");
      const Stale = contract("Counter", {
        ...Counter,
        version: 2,
        key: Counter.key,
        snapshot: Schema.Finite,
        message: Schema.Union([Add]),
      });
      const stale = yield* Effect.flip(ref(Stale, alice));
      expect(stale._tag).toBe("ContractMismatch");
    }),
  );
});

/**
 * The client side of the socket test. The port is known only once the
 * server listens, so the transport cannot be the test's outer layer; this
 * helper is the client's entry point instead, and the only place it is provided.
 */
const asClientOf =
  (baseUrl: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(
      effect,
      HttpTransport.layer({ baseUrl, reconnect: HttpTransport.defaultReconnect }),
    );

describe("http transport over a real socket", () => {
  it.scopedLive("a dropped connection reconnects from the last revision", () =>
    Effect.gen(function* () {
      const app = HttpServer.toWebHandler(hostLayer);
      yield* Effect.addFinalizer(() => Effect.promise(() => app.dispose()));
      // Bun.serve is the platform boundary of this test; the handler under
      // test is web-standard and does not know about it.
      // oxlint-disable-next-line effect/noGlobals
      const serve = (port: number) =>
        Effect.acquireRelease(
          // oxlint-disable-next-line effect/noGlobals
          Effect.sync(() => Bun.serve({ port, fetch: app.fetch })),
          (server) => Effect.promise(() => server.stop(true)),
        );

      const firstLife = yield* Scope.make();
      const first = yield* Effect.provideService(serve(0), Scope.Scope, firstLife);
      const port = Option.getOrElse(Option.fromNullishOr(first.port), () => 0);
      const baseUrl = `http://127.0.0.1:${port}`;

      const [reader, writer] = yield* asClientOf(baseUrl)(
        Effect.all([ref(Counter, alice), ref(Counter, alice)]),
      );

      yield* writer.call(add(1), { commandId: id("c1"), timeout: "1 second" });
      const one = yield* Stream.runHead(Stream.filter(reader.state.changes, (n) => n === 1));
      expect(one).toEqual(Option.some(1));

      // Drop every connection, then bring the same host back on the same port.
      yield* Scope.close(firstLife, Exit.void);
      yield* serve(port);

      yield* writer.call(add(1), { commandId: id("c2"), timeout: "1 second" });
      const two = yield* Stream.runHead(
        Stream.filter(reader.applied.changes, (committed) => committed.revision === 2),
      );
      expect(two).toEqual(Option.some({ revision: 2, state: 2 }));
    }),
  );
});
