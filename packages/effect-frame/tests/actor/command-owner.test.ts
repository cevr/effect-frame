import {
  Clock,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Scheduler,
  Schema,
  Scope,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it, yieldFibers } from "effect-bun-test";
import {
  ActorHost,
  CommandId,
  MailboxStore,
  Unauthorized,
  contract,
  implementTransparent,
} from "effect-frame/actor";
import { Unreachable } from "effect-frame/actor/client";
import type { Address, Projection, TransportService } from "effect-frame/actor/client";
import type { Behavior } from "../../src/actor/behavior.js";
import * as Commands from "../../src/actor/command-owner.js";
import { durableCommands } from "../../src/actor/durable-commands.js";
import { openDurable } from "../../src/actor/durable-engine.js";
import type { Committed } from "../../src/actor/engine-types.js";
import { remoteCommands } from "../../src/actor/remote-commands.js";

const Add = Schema.TaggedStruct("OwnerAdd", { amount: Schema.Finite });
type Add = Schema.Schema.Type<typeof Add>;
const MessageCodec = Schema.fromJsonString(Add);
const encodeAdd = Schema.encodeEffect(MessageCodec);

const Counter = contract("OwnerCounter", {
  version: 1,
  key: Schema.String,
  snapshot: Schema.Finite,
  message: Add,
});

const id = Schema.decodeSync(CommandId);
const add = (amount: number): Add => ({ _tag: "OwnerAdd", amount });
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A reducer whose turns can be held open, with an exact apply count. */
const heldCounter = () => {
  let applies = 0;
  let gate = Option.none<Deferred.Deferred<void>>();
  const behavior: Behavior<number, Add> = {
    initial: 0,
    open: () =>
      Effect.succeed({
        apply: (state, message) =>
          Effect.gen(function* () {
            if (Option.isSome(gate)) {
              yield* Deferred.await(gate.value);
            }
            applies += 1;
            return state + message.amount;
          }),
        changes: Stream.empty,
      }),
  };
  return {
    behavior,
    applies: () => applies,
    hold: Effect.map(Deferred.make<void>(), (latch) => {
      gate = Option.some(latch);
      return latch;
    }),
    release: Effect.suspend(() => {
      const current = gate;
      gate = Option.none();
      return Option.match(current, {
        onNone: () => Effect.void,
        onSome: (latch) => Deferred.succeed(latch, void 0),
      });
    }),
  };
};

interface Request {
  readonly verb: "send" | "call";
  readonly commandId: string;
  readonly payload: string;
  readonly at: number;
}

/**
 * Delays or drops the replies of a real host. It never answers for the host:
 * a dropped reply is a real request whose answer the client does not see.
 */
const impaired = (real: TransportService) => {
  const requests: Array<Request> = [];
  const controls = {
    dropCalls: false,
    hangSends: false,
    hangCalls: false,
  };
  const record = (verb: Request["verb"], commandId: string, payload: string) =>
    Effect.flatMap(Clock.currentTimeMillis, (at) =>
      Effect.sync(() => {
        requests.push({ verb, commandId, payload, at });
      }),
    );
  const transport: TransportService = {
    ...real,
    send: (address, commandId, payload, active) =>
      Effect.andThen(
        record("send", commandId, payload),
        Effect.suspend(() => {
          if (controls.hangSends) {
            return Effect.never;
          }
          return real.send(address, commandId, payload, active);
        }),
      ),
    call: (address, commandId, payload, timeout, active) =>
      Effect.andThen(
        record("call", commandId, payload),
        Effect.suspend(() => {
          if (controls.hangCalls) {
            return Effect.never;
          }
          if (controls.dropCalls) {
            return Effect.andThen(
              Effect.exit(real.call(address, commandId, payload, timeout, active)),
              Effect.fail(Unreachable.make({ reason: "reply dropped" })),
            );
          }
          return real.call(address, commandId, payload, timeout, active);
        }),
      ),
  };
  return { transport, requests, controls };
};

const address: Address = { contract: "OwnerCounter", version: 1, key: '"k"' };

const decodeSnapshot = Schema.decodeEffect(Counter.snapshot);
const decode = (projection: Projection): Effect.Effect<Committed<number>> =>
  Effect.map(Effect.orDie(decodeSnapshot(projection.snapshot)), (state) => ({
    revision: projection.revision,
    state,
  }));

/** The number of finalizers a scope holds right now: the exact release receipt. */
const finalizerCount = (scope: Scope.Scope): number => {
  const state = scope.state;
  if (state._tag !== "Open") {
    return 0;
  }
  // Effect's Scope state keeps either one finalizer or a map of them.
  return Option.match(Option.fromNullishOr(state.finalizers), {
    onSome: (finalizers) => finalizers.size,
    onNone: () =>
      Option.match(Option.fromNullishOr(state.finalizer), { onNone: () => 0, onSome: () => 1 }),
  });
};

const counted = (message: Add) => {
  let encodes = 0;
  return {
    prepare: Effect.orDie(encodeAdd(message)).pipe(
      Effect.tap(() => Effect.sync(() => (encodes += 1))),
    ),
    encodes: () => encodes,
  };
};

const noKeys = Effect.succeed([]);

type FakeRejection =
  | { readonly _tag: "ActorStopped" }
  | { readonly _tag: "CommandConflict"; readonly commandId: CommandId };

/** An adapter with no host behind it. Each test replaces the requests it drives. */
const fakeAdapter = (
  overrides: Partial<Commands.CommandAdapter<number, FakeRejection>>,
): Commands.CommandAdapter<number, FakeRejection> => ({
  kind: "durable",
  own: Commands.ownNothing,
  closed: Effect.succeed(false),
  send: () => Effect.succeed({ admitted: 1 }),
  call: () => Effect.succeed({ committed: { revision: 1, state: 1 }, refreshed: [] }),
  stopped: () => ({ _tag: "ActorStopped" }),
  conflict: (commandId) => ({ _tag: "CommandConflict", commandId }),
  ...overrides,
});

const onePass: Commands.CommandPolicySettings = {
  passes: 1,
  passDeadline: "1 hour",
  baseDelay: "1 millis",
  maxDelay: "1 millis",
};

const remoteOwner = Effect.fn("CommandOwnerTest.remoteOwner")(function* (
  behavior: Behavior<number, Add>,
  authorizer: Option.Option<ActorHost.AuthorizerService> = Option.none(),
) {
  let host = ActorHost.make({
    implementations: [implementTransparent(Counter, behavior)],
  });
  if (Option.isSome(authorizer)) {
    host = Effect.provideService(host, ActorHost.Authorizer, authorizer.value);
  }
  const real = yield* host;
  const wire = impaired(real);
  const owner = yield* Commands.make(remoteCommands(wire.transport, address, decode));
  return { owner, wire };
});

describe("private command owner", () => {
  it.scoped("a healthy pass is one send and one same-ID call with the exact result", () =>
    Effect.gen(function* () {
      const counter = heldCounter();
      const { owner, wire } = yield* remoteOwner(counter.behavior);
      const message = counted(add(3));
      const command = yield* owner.submit(
        yield* Commands.identify(Option.none()),
        message.prepare,
        noKeys,
      );
      expect(command.identity).toBe("fresh");
      expect(command.commandId).toMatch(uuidV4);
      const settled = yield* command.settled;
      expect(settled).toEqual({
        _tag: "Applied",
        admitted: 1,
        committed: { revision: 1, state: 3 },
      });
      expect(yield* command.lifecycle.get).toEqual(settled);
      expect(wire.requests.map((request) => request.verb)).toEqual(["send", "call"]);
      expect(new Set(wire.requests.map((request) => request.commandId))).toEqual(
        new Set([command.commandId]),
      );
      expect(message.encodes()).toBe(1);
      expect(yield* owner.retained).toEqual([]);

      const other = yield* owner.submit(
        yield* Commands.identify(Option.none()),
        counted(add(1)).prepare,
        noKeys,
      );
      expect(other.commandId).not.toBe(command.commandId);
      expect(other.commandId).toMatch(uuidV4);
    }),
  );

  it.scoped("a later submission of an old ID returns its exact older receipt", () =>
    Effect.gen(function* () {
      const counter = heldCounter();
      const store = yield* Layer.build(MailboxStore.layerMemory);
      const engine = yield* openDurable({
        behavior: counter.behavior,
        state: Schema.fromJsonString(Schema.Finite),
        message: MessageCodec,
      }).pipe(Effect.provideContext(store));
      const owner = yield* Commands.make(durableCommands(engine));
      const first = yield* owner.submit(
        yield* Commands.identify(Option.some(id("older"))),
        counted(add(1)).prepare,
        noKeys,
      );
      expect(yield* first.settled).toMatchObject({ committed: { revision: 1, state: 1 } });
      const newer = yield* owner.submit(
        yield* Commands.identify(Option.some(id("newer"))),
        counted(add(2)).prepare,
        noKeys,
      );
      expect(yield* newer.settled).toMatchObject({ committed: { revision: 2, state: 3 } });
      const again = yield* owner.submit(
        yield* Commands.identify(Option.some(id("older"))),
        counted(add(1)).prepare,
        noKeys,
      );
      expect(again.identity).toBe("supplied");
      expect(yield* again.settled).toEqual({
        _tag: "Applied",
        admitted: 1,
        committed: { revision: 1, state: 1 },
      });
      expect(counter.applies()).toBe(2);
    }),
  );

  it.scoped("a first refusal rejects a fresh ID but a supplied ID stays Uncertain", () =>
    Effect.gen(function* () {
      const counter = heldCounter();
      const { owner, wire } = yield* remoteOwner(
        counter.behavior,
        Option.some({
          authorize: (target: Address) =>
            Effect.fail(Unauthorized.make({ contract: target.contract })),
        }),
      );
      const fresh = yield* owner.submit(
        yield* Commands.identify(Option.none()),
        counted(add(1)).prepare,
        noKeys,
      );
      const rejected = yield* fresh.settled;
      expect(rejected._tag).toBe("Rejected");
      expect(rejected._tag === "Rejected" && rejected.reason._tag).toBe("Unauthorized");
      expect(wire.requests).toHaveLength(1);

      // A supplied string shaped exactly like a framework ID is still supplied.
      // oxlint-disable-next-line effect/noGlobals -- the test needs a real framework-shaped ID
      const lookalike = id(crypto.randomUUID());
      const supplied = yield* owner.submit(
        yield* Commands.identify(Option.some(lookalike)),
        counted(add(1)).prepare,
        noKeys,
      );
      expect(supplied.identity).toBe("supplied");
      yield* yieldFibers;
      expect(yield* supplied.lifecycle.get).toEqual({
        _tag: "Uncertain",
        attempt: 1,
        admitted: Option.none(),
      });
      yield* TestClock.adjust("5 minutes");
      expect(wire.requests).toHaveLength(2);
      const retained = yield* owner.retained;
      expect(retained.map((command) => [command.commandId, command.possibleAdmission])).toEqual([
        [lookalike, true],
      ]);
    }),
  );

  it.scoped("eight passes keep exact bytes, then Uncertain until one manual retry settles", () =>
    Effect.gen(function* () {
      const counter = heldCounter();
      const { owner, wire } = yield* remoteOwner(counter.behavior);
      wire.controls.dropCalls = true;
      const message = counted(add(1));
      const command = yield* owner.submit(
        yield* Commands.identify(Option.none()),
        message.prepare,
        noKeys,
      );
      const payload = Option.getOrThrow(owner.payloadOf(command.commandId));
      yield* TestClock.adjust("5 minutes");
      expect(yield* command.lifecycle.get).toEqual({
        _tag: "Uncertain",
        attempt: 8,
        admitted: Option.some(1),
      });
      expect(wire.requests).toHaveLength(16);
      expect(wire.requests.every((request) => request.payload === payload)).toBe(true);
      expect(message.encodes()).toBe(1);
      const sends = wire.requests.filter((request) => request.verb === "send");
      const delays: Array<number> = [];
      let previous = Option.none<number>();
      for (const request of sends) {
        if (Option.isSome(previous)) {
          delays.push(Math.round(request.at - previous.value));
        }
        previous = Option.some(request.at);
      }
      expect(delays).toHaveLength(7);
      delays.forEach((delay, index) => {
        const base = 200 * 2 ** index;
        expect(delay).toBeGreaterThanOrEqual(Math.min(base * 0.8, 10_000));
        expect(delay).toBeLessThanOrEqual(Math.min(base * 1.2, 10_000));
      });
      expect(delays[6]).toBe(10_000);

      // Streams and time alone start nothing after the bound.
      yield* TestClock.adjust("1 hour");
      expect(wire.requests).toHaveLength(16);
      const retained = yield* owner.retained;
      expect(retained.map((record) => [record.attempt, record.running])).toEqual([[8, false]]);

      wire.controls.dropCalls = false;
      yield* Effect.all([command.retry, command.retry, command.retry], {
        concurrency: "unbounded",
      });
      const settled = yield* command.settled;
      expect(settled).toEqual({
        _tag: "Applied",
        admitted: 1,
        committed: { revision: 1, state: 1 },
      });
      expect(wire.requests).toHaveLength(18);
      expect(wire.requests.every((request) => request.payload === payload)).toBe(true);
      expect(message.encodes()).toBe(1);
      expect(counter.applies()).toBe(1);
      expect(yield* owner.retained).toEqual([]);
      yield* command.retry;
      expect(wire.requests).toHaveLength(18);
    }),
  );

  it.scoped("a hung send or call ends at the whole-pass deadline", () =>
    Effect.gen(function* () {
      const counter = heldCounter();
      const { owner, wire } = yield* remoteOwner(counter.behavior);
      wire.controls.hangSends = true;
      const hungSend = yield* owner.submit(
        yield* Commands.identify(Option.none()),
        counted(add(1)).prepare,
        noKeys,
      );
      yield* yieldFibers;
      yield* TestClock.adjust("9999 millis");
      expect(yield* hungSend.lifecycle.get).toEqual({ _tag: "Sent" });
      yield* TestClock.adjust("1 millis");
      expect(yield* hungSend.lifecycle.get).toEqual({
        _tag: "Uncertain",
        attempt: 1,
        admitted: Option.none(),
      });
      wire.controls.hangSends = false;
      yield* TestClock.adjust("1 second");
      expect(yield* hungSend.settled).toMatchObject({
        _tag: "Applied",
        committed: { revision: 1 },
      });

      wire.controls.hangCalls = true;
      const hungCall = yield* owner.submit(
        yield* Commands.identify(Option.none()),
        counted(add(1)).prepare,
        noKeys,
      );
      yield* yieldFibers;
      expect(yield* hungCall.lifecycle.get).toEqual({ _tag: "Admitted", admitted: 2 });
      yield* TestClock.adjust("10 seconds");
      expect(yield* hungCall.lifecycle.get).toEqual({
        _tag: "Uncertain",
        attempt: 1,
        admitted: Option.some(2),
      });
      wire.controls.hangCalls = false;
      yield* TestClock.adjust("1 second");
      expect(yield* hungCall.settled).toMatchObject({
        _tag: "Applied",
        committed: { revision: 2 },
      });
      expect(counter.applies()).toBe(2);
    }),
  );

  it.scoped("a live ID joins same bytes and refuses different bytes locally", () =>
    Effect.gen(function* () {
      const counter = heldCounter();
      const { owner, wire } = yield* remoteOwner(counter.behavior);
      yield* counter.hold;
      const first = yield* owner.submit(
        yield* Commands.identify(Option.some(id("x"))),
        counted(add(1)).prepare,
        noKeys,
      );
      yield* yieldFibers;
      const joined = yield* owner.submit(
        yield* Commands.identify(Option.some(id("x"))),
        counted(add(1)).prepare,
        noKeys,
      );
      const conflicting = yield* owner.submit(
        yield* Commands.identify(Option.some(id("x"))),
        counted(add(2)).prepare,
        noKeys,
      );
      expect(yield* conflicting.settled).toEqual({
        _tag: "Rejected",
        reason: expect.objectContaining({ _tag: "CommandConflict", commandId: id("x") }),
      });
      expect(yield* owner.retained).toHaveLength(1);
      expect(wire.requests.filter((request) => request.verb === "send")).toHaveLength(1);
      yield* counter.release;
      const settled = yield* first.settled;
      expect(yield* joined.settled).toEqual(settled);
      expect(counter.applies()).toBe(1);

      // After collection the server decides: different bytes are a real conflict.
      const late = yield* owner.submit(
        yield* Commands.identify(Option.some(id("x"))),
        counted(add(2)).prepare,
        noKeys,
      );
      const refused = yield* late.settled;
      expect(refused._tag === "Rejected" && refused.reason._tag).toBe("CommandConflict");
    }),
  );

  it.scoped("a stopped durable engine after admission stays Uncertain and recovers later", () =>
    Effect.gen(function* () {
      const counter = heldCounter();
      const store = yield* Layer.build(MailboxStore.layerMemory);
      const options = {
        behavior: counter.behavior,
        state: Schema.fromJsonString(Schema.Finite),
        message: MessageCodec,
      };
      const firstLife = yield* Scope.make();
      const engine = yield* openDurable(options).pipe(
        Effect.provideContext(store),
        Scope.provide(firstLife),
      );
      const owner = yield* Commands.make(durableCommands(engine));
      yield* counter.hold;
      const command = yield* owner.submit(
        yield* Commands.identify(Option.none()),
        counted(add(5)).prepare,
        noKeys,
      );
      yield* yieldFibers;
      expect(yield* command.lifecycle.get).toEqual({ _tag: "Admitted", admitted: 1 });
      yield* Scope.close(firstLife, Exit.void);
      yield* TestClock.adjust("5 minutes");
      expect(yield* command.lifecycle.get).toEqual({
        _tag: "Uncertain",
        attempt: 8,
        admitted: Option.some(1),
      });

      yield* counter.release;
      const recovered = yield* openDurable(options).pipe(Effect.provideContext(store));
      const done = yield* Stream.runHead(
        Stream.filter(recovered.committed.changes, (committed) => committed.revision === 1),
      );
      expect(Option.map(done, (committed) => committed.state)).toEqual(Option.some(5));
      expect(counter.applies()).toBe(1);
    }),
  );

  it.scoped("closing the owner stops workers and refuses new work without cancelling it", () =>
    Effect.gen(function* () {
      const counter = heldCounter();
      const lifetime = yield* Scope.make();
      const host = yield* ActorHost.make({
        implementations: [implementTransparent(Counter, counter.behavior)],
      });
      const wire = impaired(host);
      let interrupted = 0;
      const adapter = remoteCommands(wire.transport, address, decode);
      const owner = yield* Commands.make({
        ...adapter,
        call: (commandId, payload, deadline, active) =>
          Effect.onInterrupt(adapter.call(commandId, payload, deadline, active), () =>
            Effect.sync(() => (interrupted += 1)),
          ),
      }).pipe(Scope.provide(lifetime));
      yield* counter.hold;
      const command = yield* owner.submit(
        yield* Commands.identify(Option.none()),
        counted(add(2)).prepare,
        noKeys,
      );
      yield* yieldFibers;
      expect(yield* command.lifecycle.get).toEqual({ _tag: "Admitted", admitted: 1 });
      const waiting = yield* Effect.forkScoped(command.settled);
      yield* Scope.close(lifetime, Exit.void);
      expect(interrupted).toBe(1);
      expect(yield* command.lifecycle.get).toEqual({ _tag: "Admitted", admitted: 1 });
      expect(finalizerCount(lifetime)).toBe(0);

      yield* command.retry;
      const late = counted(add(9));
      const refused = yield* owner.submit(
        yield* Commands.identify(Option.none()),
        late.prepare,
        noKeys,
      );
      expect(yield* refused.settled).toMatchObject({
        _tag: "Rejected",
        reason: { _tag: "ActorStopped" },
      });
      const supplied = yield* owner.submit(
        yield* Commands.identify(Option.some(id("kept"))),
        late.prepare,
        noKeys,
      );
      expect(yield* supplied.lifecycle.get).toEqual({
        _tag: "Uncertain",
        attempt: 0,
        admitted: Option.none(),
      });
      expect(late.encodes()).toBe(0);
      expect(wire.requests.filter((request) => request.verb === "send")).toHaveLength(1);

      // The admitted work was not cancelled: the host still commits it.
      yield* counter.release;
      const committed = yield* Stream.runHead(
        Stream.filter(host.changes(address, 0), (projection) => projection.revision === 1),
      );
      expect(Option.isSome(committed)).toBe(true);
      expect(counter.applies()).toBe(1);
      expect(waiting.pollUnsafe()).toBeUndefined();
    }),
  );

  it.scoped("repeated commands and exhausted retry cycles release every worker scope", () =>
    Effect.gen(function* () {
      const counter = heldCounter();
      const lifetime = yield* Scope.make();
      const host = yield* ActorHost.make({
        implementations: [implementTransparent(Counter, counter.behavior)],
      });
      const wire = impaired(host);
      const owner = yield* Commands.make(remoteCommands(wire.transport, address, decode)).pipe(
        Scope.provide(lifetime),
      );
      const baseline = finalizerCount(lifetime);
      for (let index = 0; index < 20; index += 1) {
        const command = yield* owner.submit(
          yield* Commands.identify(Option.none()),
          counted(add(1)).prepare,
          noKeys,
        );
        yield* command.settled;
      }
      expect(finalizerCount(lifetime)).toBe(baseline);

      wire.controls.dropCalls = true;
      const command = yield* owner.submit(
        yield* Commands.identify(Option.none()),
        counted(add(1)).prepare,
        noKeys,
      );
      for (let cycle = 0; cycle < 3; cycle += 1) {
        yield* TestClock.adjust("5 minutes");
        expect(yield* command.lifecycle.get).toMatchObject({ _tag: "Uncertain", attempt: 8 });
        // One retained record scope, and no worker scope inside it.
        expect(finalizerCount(lifetime)).toBe(baseline + 1);
        yield* command.retry;
      }
      wire.controls.dropCalls = false;
      yield* TestClock.adjust("5 minutes");
      expect((yield* command.settled)._tag).toBe("Applied");
      expect(finalizerCount(lifetime)).toBe(baseline);
      yield* Scope.close(lifetime, Exit.void);
    }),
  );

  it.scoped("a retry that races the exhaustion step joins the one running sequence", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      let sends = 0;
      let inflight = 0;
      let maxInflight = 0;
      let settles = 0;
      const owner = yield* Commands.make(
        fakeAdapter({
          own: () => Effect.succeed(() => Effect.sync(() => (settles += 1))),
          send: () =>
            Effect.suspend(() => {
              sends += 1;
              if (sends === 1) {
                return Effect.fail(Commands.lost);
              }
              inflight += 1;
              maxInflight = Math.max(maxInflight, inflight);
              return Effect.ensuring(
                Effect.as(Deferred.await(release), { admitted: 1 }),
                Effect.sync(() => (inflight -= 1)),
              );
            }),
        }),
      ).pipe(Effect.provideService(Commands.CommandPolicy, onePass));
      const command = yield* owner.submit(
        { commandId: id("raced"), identity: "supplied" },
        Effect.succeed("{}"),
        noKeys,
      );
      // Retry at every moment the record reads idle. A short yield budget
      // lets this loop run between the steps of the exhausted sequence.
      let retries = 0;
      for (let turn = 0; turn < 200 && retries < 3; turn += 1) {
        const retained = yield* owner.retained;
        if (retained.some((record) => !record.running)) {
          yield* command.retry;
          retries += 1;
        }
        yield* Effect.yieldNow;
      }
      yield* Deferred.succeed(release, void 0);
      expect((yield* command.settled)._tag).toBe("Applied");
      yield* yieldFibers;
      expect(maxInflight).toBe(1);
      expect(settles).toBe(1);
      expect(retries).toBe(1);
      expect(sends).toBe(2);
    }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 3)),
  );

  it.scoped("an interrupted submission still leaves its record a running worker", () =>
    Effect.gen(function* () {
      let owns = 0;
      const owner = yield* Commands.make(
        fakeAdapter({
          // The first adoption suspends, as a cache claim can while it counts.
          own: (active) =>
            Effect.suspend(() => {
              owns += 1;
              if (owns === 1) {
                return Effect.andThen(
                  Effect.sleep("10 millis"),
                  Commands.ownNothing<number>(active),
                );
              }
              return Commands.ownNothing<number>(active);
            }),
        }),
      );
      const submit = owner.submit(
        { commandId: id("interrupted"), identity: "supplied" },
        Effect.succeed("{}"),
        noKeys,
      );
      const first = yield* Effect.forkChild(submit);
      yield* TestClock.adjust("1 millis");
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(first));
      yield* TestClock.adjust("10 millis");
      yield* Fiber.join(interrupting);
      yield* yieldFibers;
      // The record was created, so its first sequence ran and settled it.
      expect(yield* owner.retained).toEqual([]);

      const again = yield* submit;
      const waiting = yield* Effect.forkChild(Effect.timeoutOption(again.settled, "1 second"));
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(waiting)).toEqual(
        Option.some({ _tag: "Applied", admitted: 1, committed: { revision: 1, state: 1 } }),
      );
    }),
  );
});
