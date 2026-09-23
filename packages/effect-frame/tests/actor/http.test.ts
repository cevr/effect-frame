import { Effect, Exit, Layer, Option, Schema, Scope, Stream } from "effect";
import { describe, expect, it } from "effect-bun-test";
import {
  ActorHost,
  Behavior,
  CommandId,
  HttpServer,
  Policies,
  Policy,
  implementTransparent,
} from "effect-frame/actor";
import type { Subject } from "effect-frame/actor";
import {
  ActorTransport,
  Authenticated,
  CommandConflict,
  HttpTransport,
  Principal,
  Refused,
  Unauthorized,
  Wire,
  committedRevision,
  contract,
  ref,
} from "effect-frame/actor/client";
import type { Address, CommandSettled } from "effect-frame/actor/client";

const Add = Schema.TaggedStruct("Add", { amount: Schema.Finite });
type Add = Schema.Schema.Type<typeof Add>;

const Counter = contract("Counter", {
  version: 1,
  policy: "counter",
  key: Schema.Struct({ tenant: Schema.String, id: Schema.String }),
  snapshot: Schema.Finite,
  message: Schema.Union([Add]),
});

/** Refuses a negative amount: the host answers it `Refused`, conclusively. */
const counterBehavior = Behavior.reducer<number, Add, Refused>({
  initial: 0,
  reduce: (state, message) => state + message.amount,
  refuse: (message) =>
    Option.as(
      Option.liftPredicate(message, (sent) => sent.amount < 0),
      Refused.make({ reason: "negative" }),
    ),
});

const CounterLive = implementTransparent(Counter, counterBehavior);

const id = Schema.decodeSync(CommandId);
const add = (amount: number): Add => ({ _tag: "Add", amount });
const alice = { tenant: "acme", id: "alice" };

/** Reads the key alone: the rows in process are about the wire, not the principal. */
const acmeKeys: Policy = {
  check: (_principal, subject: Subject) => {
    if (subject._tag === "Actor" && subject.address.key.includes('"acme"')) {
      return Effect.void;
    }
    return Effect.fail(Unauthorized.make({ contract: Counter.name }));
  },
};

const acmeOnly = Layer.succeed(Policies, Policies.of({ counter: acmeKeys }));

const hostLayer = Layer.provide(ActorHost.layerMemory([CounterLive]), acmeOnly);

/** Each in-process response's path and status, newest last. */
const answered: Array<{ readonly path: string; readonly status: number }> = [];

/**
 * The server handler and the client transport meet at a `fetch` function.
 * In process, that function is the handler itself: no socket, same wire.
 */
const inProcess = Layer.unwrap(
  Effect.gen(function* () {
    const server = yield* HttpServer.make({ principal: HttpServer.anonymous });
    const context = yield* Effect.context<never>();
    const run = Effect.runPromiseWith(context);
    const fetch: HttpTransport.FetchLike = (input, init) => {
      const request = new Request(input, init);
      return run(server(request)).then((response) => {
        answered.push({ path: new URL(request.url).pathname, status: response.status });
        return response;
      });
    };
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
      expect(applied).toEqual({ revision: committedRevision(1), state: 3 });
      const seen = yield* Stream.runHead(Stream.filter(reader.state.changes, (n) => n === 3));
      expect(seen).toEqual(Option.some(3));
      const fresh = yield* ref(Counter, alice);
      expect(yield* fresh.applied.get).toEqual({ revision: committedRevision(1), state: 3 });
    }),
  );

  withInProcess("a receipt round-trips with its Option", () =>
    Effect.gen(function* () {
      const transport = yield* ActorTransport;
      const address: Address = {
        contract: Counter.name,
        version: Counter.version,
        key: yield* Schema.encodeEffect(Counter.key)(alice),
      };
      const payload = yield* Schema.encodeEffect(Counter.message)(add(1));
      const first = yield* transport.send(address, id("c1"), payload, []);
      expect(first.receipt).toEqual({
        commandId: id("c1"),
        admitted: 1,
        committed: Option.none(),
      });
      yield* transport.call(address, id("c1"), payload, "1 second", []);
      const again = yield* transport.send(address, id("c1"), payload, []);
      expect(again.receipt.committed).toEqual(Option.some(1));
    }),
  );

  withInProcess("a command handle settles over the wire, and a resend gets its stored result", () =>
    Effect.gen(function* () {
      const counter = yield* ref(Counter, alice);
      const first = yield* counter.send(add(1));
      const applied: CommandSettled<number, "remote"> = {
        _tag: "Applied",
        admitted: 1,
        revision: committedRevision(1),
        state: 1,
      };
      expect(yield* first.settled).toEqual(applied);
      const again = yield* counter.send(add(1), { commandId: first.commandId });
      expect(yield* again.settled).toEqual(applied);
      expect(yield* counter.state.get).toBe(1);
    }),
  );

  withInProcess("typed failures survive the wire with their status", () =>
    Effect.gen(function* () {
      const counter = yield* ref(Counter, alice);
      yield* counter.call(add(1), { commandId: id("c1"), timeout: "1 second" });
      const conflict = yield* counter.send(add(2), { commandId: id("c1") });
      expect(yield* conflict.settled).toEqual({
        _tag: "Rejected",
        reason: CommandConflict.make({ commandId: id("c1") }),
      });
      const denied = yield* Effect.flip(ref(Counter, { tenant: "other", id: "x" }));
      expect(denied._tag).toBe("Unauthorized");
      const Stale = contract("Counter", {
        ...Counter,
        version: 2,
        policy: "counter",
        key: Counter.key,
        snapshot: Schema.Finite,
        message: Schema.Union([Add]),
      });
      const stale = yield* Effect.flip(ref(Stale, alice));
      expect(stale._tag).toBe("ContractMismatch");
    }),
  );

  withInProcess(
    "a refusal crosses the wire as 422 Refused, is conclusive, and is never predicted",
    () =>
      Effect.gen(function* () {
        const counter = yield* ref(Counter, alice, {
          resume: Option.none(),
          behavior: counterBehavior,
        });
        const shown: Array<number> = [];
        yield* Effect.forkScoped(
          Stream.runForEach(counter.displayed.changes, (displayed) =>
            Effect.sync(() => shown.push(displayed.state)),
          ),
        );
        answered.length = 0;
        const refused = yield* counter.send(add(-5));
        const expected = {
          _tag: "Rejected",
          reason: Refused.make({ reason: "negative" }),
        } satisfies CommandSettled<number, "remote">;
        expect(yield* refused.settled).toEqual(expected);
        const commands = () =>
          answered.filter(({ path }) => path === "/actors/send" || path === "/actors/call");
        // One request: a refusal is conclusive, so the owner never retries it.
        expect(commands()).toEqual([{ path: "/actors/send", status: 422 }]);
        // The same bytes under the same ID are refused again, never admitted.
        const retried = yield* counter.send(add(-5), { commandId: refused.commandId });
        expect(yield* retried.settled).toEqual(expected);
        expect(commands().every(({ status }) => status === 422)).toBe(true);
        expect(yield* counter.applied.get).toEqual({ revision: committedRevision(0), state: 0 });
        // The predicting reference never showed the refused state.
        expect(shown).not.toContain(-5);
        const accepted = yield* counter.call(add(2), { timeout: "1 second" });
        expect(accepted).toEqual({ revision: committedRevision(1), state: 2 });
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
      const app = HttpServer.toWebHandler(hostLayer, { principal: HttpServer.anonymous });
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
        Stream.filter(reader.applied.changes, (committed) => committed.revision.value === 2),
      );
      expect(two).toEqual(Option.some({ revision: committedRevision(2), state: 2 }));
    }),
  );
});

// ---------------------------------------------------------------------------
// The principal over the wire (#20 §1): derived once, where the request enters
// ---------------------------------------------------------------------------

/** The test's session: a header naming a subject and its tenant. No header is nobody. */
const fromHeader: HttpServer.DerivePrincipal = (request) =>
  Effect.succeed(
    Option.match(Option.fromNullishOr(request.headers.get("x-tenant")), {
      onNone: () => Principal.anonymous,
      onSome: (tenant) =>
        Principal.constant(Authenticated.make({ subject: "caller", claims: { tenant } })),
    }),
  );

const decodeCounterKey = Schema.decodeUnknownOption(Counter.key);

/** A member of the key's tenant, by the claims the principal carries. */
const tenantMember = Policy.of(
  (subject: Subject) => {
    if (subject._tag === "Actor") {
      return Option.map(decodeCounterKey(subject.address.key), (key) => key.tenant);
    }
    return Option.none();
  },
  (who, tenant) => Effect.succeed(who.claims["tenant"] === tenant),
);

const decodeReadError = Schema.decodeEffect(Schema.fromJsonString(Wire.ReadWireError));

describe("the principal over a real socket", () => {
  it.scopedLive("an anonymous request to a protected actor is 403", () =>
    Effect.gen(function* () {
      const app = HttpServer.toWebHandler(
        Layer.provide(
          ActorHost.layerMemory([CounterLive]),
          Layer.succeed(Policies, Policies.of({ counter: tenantMember })),
        ),
        { principal: fromHeader },
      );
      yield* Effect.addFinalizer(() => Effect.promise(() => app.dispose()));
      const server = yield* Effect.acquireRelease(
        // oxlint-disable-next-line effect/noGlobals -- Bun.serve is this test's platform boundary.
        Effect.sync(() => Bun.serve({ port: 0, fetch: app.fetch })),
        (running) => Effect.promise(() => running.stop(true)),
      );
      const port = Option.getOrElse(Option.fromNullishOr(server.port), () => 0);
      const key = yield* Schema.encodeEffect(Counter.key)(alice);
      const body = yield* Schema.encodeEffect(Schema.fromJsonString(Wire.AddressBody))({
        address: { contract: Counter.name, version: Counter.version, key },
      });
      const snapshot = (headers: Record<string, string>) =>
        Effect.promise(() =>
          // oxlint-disable-next-line effect/noGlobals -- the test is the browser.
          fetch(`http://127.0.0.1:${String(port)}/snapshot`, {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body,
          }).then((response) => response.text().then((text) => ({ response, text }))),
        );

      const anonymous = yield* snapshot({});
      expect(anonymous.response.status).toBe(403);
      expect(yield* decodeReadError(anonymous.text)).toEqual(
        Unauthorized.make({ contract: Counter.name }),
      );

      const member = yield* snapshot({ "x-tenant": "acme" });
      expect(member.response.status).toBe(200);

      const outsider = yield* snapshot({ "x-tenant": "rival" });
      expect(outsider.response.status).toBe(403);
    }),
  );
});
