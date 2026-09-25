import { Clock, Effect, Layer, Option, Schema, Stream } from "effect";
import { describe, expect, it } from "effect-bun-test";
import {
  FetchHttpClient,
  HttpEffect,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import {
  Actor,
  ActorHost,
  Behavior,
  HttpServer,
  Policies,
  Policy,
  implementTransparent,
} from "effect-frame/actor";
import { HttpTransport, committedRevision, contract } from "effect-frame/actor/client";
import type { IdentifiedCommandHandle } from "effect-frame/actor/client";
import type { CommandPolicySettings } from "../../src/actor/command-owner.js";
import { CommandPolicy } from "../../src/actor/command-owner.js";

/**
 * Commands over a real socket through an impairing proxy. The proxy sits in
 * front of the real web handler and can forward a request and then lose its
 * reply, refuse a request before the host sees it, or hold a request until
 * the client gives up. Every count below is a request the host's socket
 * received.
 */
const Add = Schema.TaggedStruct("Add", { amount: Schema.Finite });
type Add = Schema.Schema.Type<typeof Add>;

const Counter = contract("ImpairedCounter", {
  version: 1,
  policy: "public",
  key: Schema.String,
  snapshot: Schema.Finite,
  message: Schema.Union([Add]),
});

let applies = 0;
const CounterLive = implementTransparent(Counter, {
  behavior: Behavior.reducer<number, Add>({
    initial: 0,
    reduce: (state, message) => {
      applies += 1;
      return state + message.amount;
    },
  }),
});

type Impairment = "pass" | "lose-reply" | "refuse" | "hang";

interface Proxy {
  send: Impairment;
  call: Impairment;
  /** How many requests of each kind get the impairment before passing. */
  limit: number;
  sends: number;
  calls: number;
}

const proxy: Proxy = { send: "pass", call: "pass", limit: 0, sends: 0, calls: 0 };

const reset = (next: Partial<Proxy>) =>
  Effect.sync(() => {
    Object.assign(proxy, { send: "pass", call: "pass", limit: 0, sends: 0, calls: 0 }, next);
  });

type App = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest
>;

const impair = (mode: Impairment, seen: number, forward: App): App => {
  if (mode === "pass" || seen > proxy.limit) {
    return forward;
  }
  if (mode === "refuse") {
    return Effect.succeed(HttpServerResponse.text("impaired: refused", { status: 502 }));
  }
  if (mode === "hang") {
    // The request is held until the client aborts it at its pass deadline;
    // the web adapter interrupts it then.
    return Effect.never;
  }
  return Effect.as(forward, HttpServerResponse.text("impaired: reply lost", { status: 502 }));
};

const policy = (settings: Partial<CommandPolicySettings>): CommandPolicySettings => ({
  passes: 8,
  passDeadline: "2 seconds",
  baseDelay: "5 millis",
  maxDelay: "20 millis",
  ...settings,
});

const serve = Effect.gen(function* () {
  const host = yield* Layer.build(
    ActorHost.layer({ implementations: [CounterLive], store: ActorHost.memoryStore }).pipe(
      Layer.provide(Layer.succeed(Policies, Policies.of({ public: Policy.allowAll }))),
    ),
  );
  const handler = yield* HttpServer.make({
    prefix: "",
    principal: HttpServer.anonymous,
    maxBodyBytes: HttpServer.defaultMaxBodyBytes,
    form: Option.none(),
  }).pipe(Effect.provideContext(host));
  const impaired: App = Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
    if (request.url.endsWith("/send")) {
      proxy.sends += 1;
      return impair(proxy.send, proxy.sends, handler);
    }
    if (request.url.endsWith("/call")) {
      proxy.calls += 1;
      return impair(proxy.call, proxy.calls, handler);
    }
    return handler;
  });
  const web = HttpEffect.toWebHandlerWith<never, HttpServerRequest.HttpServerRequest>(
    yield* Effect.context<never>(),
  )(impaired);
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      // oxlint-disable-next-line effect/noGlobals -- Bun.serve is this test's platform boundary.
      Bun.serve({ port: 0, fetch: (request) => web(request) }),
    ),
    (running) => Effect.promise(() => running.stop(true)),
  );
  const port = Option.getOrElse(Option.fromNullishOr(server.port), () => 0);
  return HttpTransport.layer({
    baseUrl: `http://127.0.0.1:${port}`,
    reconnect: HttpTransport.defaultReconnect,
  }).pipe(Layer.provide(FetchHttpClient.layer));
});

/** One client reference over the real socket, with a shortened retry policy. */
const client = (settings: Partial<CommandPolicySettings>) =>
  Effect.gen(function* () {
    const transport = yield* serve;
    const context = yield* Layer.build(transport);
    return yield* Actor.remote(Counter, "impaired").pipe(
      Effect.provideContext(context),
      Effect.provideService(CommandPolicy, policy(settings)),
    );
  });

const add = (amount: number): Add => ({ _tag: "Add", amount });

const uncertainAt = <State>(command: IdentifiedCommandHandle<State, "remote">, attempt: number) =>
  Effect.map(
    Stream.runHead(
      Stream.filter(
        command.state.changes,
        (state) => state._tag === "Uncertain" && state.attempt === attempt,
      ),
    ),
    Option.getOrThrow,
  );

describe("commands over an impaired real socket", () => {
  it.scopedLive("lost call replies retry the same ID and apply once", () =>
    Effect.gen(function* () {
      applies = 0;
      yield* reset({ call: "lose-reply", limit: 2 });
      const counter = yield* client({});
      const command = yield* counter.send(add(3));
      const settled = yield* command.settled;
      expect(settled).toEqual({
        _tag: "Applied",
        admitted: 1,
        revision: committedRevision(1),
        state: 3,
      });
      // Three passes: two whose call reply was lost after the host
      // committed, then one whose same-ID call read the stored receipt.
      expect({ sends: proxy.sends, calls: proxy.calls, applies }).toEqual({
        sends: 3,
        calls: 3,
        applies: 1,
      });
    }),
  );

  it.scopedLive("an unreachable host exhausts eight passes, then a manual retry applies", () =>
    Effect.gen(function* () {
      applies = 0;
      yield* reset({ send: "refuse", limit: Number.POSITIVE_INFINITY });
      const counter = yield* client({});
      const command = yield* counter.send(add(2));
      const exhausted = yield* uncertainAt(command, 8);
      expect(exhausted).toEqual({ _tag: "Uncertain", attempt: 8, admitted: Option.none() });
      // A refused send ends its pass: eight requests, no call, no turn.
      expect({ sends: proxy.sends, calls: proxy.calls, applies }).toEqual({
        sends: 8,
        calls: 0,
        applies: 0,
      });

      yield* reset({});
      yield* Effect.all([command.retry, command.retry, command.retry], { concurrency: 3 });
      const settled = yield* command.settled;
      expect(settled._tag).toBe("Applied");
      // Concurrent retries joined one new sequence: one send and one call.
      expect({ sends: proxy.sends, calls: proxy.calls, applies }).toEqual({
        sends: 1,
        calls: 1,
        applies: 1,
      });
    }),
  );

  it.scopedLive("a hung call ends at the pass deadline and the next pass settles", () =>
    Effect.gen(function* () {
      applies = 0;
      yield* reset({ call: "hang", limit: 1 });
      const counter = yield* client({ passDeadline: "300 millis" });
      const started = yield* Clock.currentTimeMillis;
      const command = yield* counter.send(add(4));
      const settled = yield* command.settled;
      const elapsed = (yield* Clock.currentTimeMillis) - started;
      expect(settled._tag).toBe("Applied");
      expect(elapsed).toBeGreaterThanOrEqual(300);
      expect({ sends: proxy.sends, calls: proxy.calls, applies }).toEqual({
        sends: 2,
        calls: 2,
        applies: 1,
      });
    }),
  );
});
