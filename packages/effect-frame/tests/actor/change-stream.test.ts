import { Context, Effect, Option, Queue, Schema, Stream, SubscriptionRef } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "effect-bun-test";
import { ActorHost, CommandId, implementTransparent } from "effect-frame/actor";
import {
  ActorTransport,
  Unreachable,
  Wire,
  committedRevision,
  contract,
  ref,
} from "effect-frame/actor/client";
import type {
  Address,
  CommandUncertain,
  Projection,
  TransportService,
} from "effect-frame/actor/client";

/**
 * #29: the change stream carries state, never command identity. A client
 * learns its own command's fate from the command's receipt, by sending the
 * same ID again. These rows pin what the stream is and is not.
 */

// ---------------------------------------------------------------------------
// Types: no third field, and no receipt-read verb
// ---------------------------------------------------------------------------

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const projectionFields: Equals<keyof Projection, "revision" | "snapshot"> = true;
const wireProjectionFields: Equals<
  keyof Schema.Schema.Type<typeof Wire.WireProjection>,
  "revision" | "snapshot"
> = true;
/** The transport's verbs. None of them reads a receipt by command ID. */
const transportVerbs: Equals<
  keyof TransportService,
  "send" | "call" | "snapshot" | "query" | "queryBatch" | "changes"
> = true;

// ---------------------------------------------------------------------------
// An actor that commits on commands and on its own
// ---------------------------------------------------------------------------

const Add = Schema.TaggedStruct("Add", { amount: Schema.Finite });
type Add = Schema.Schema.Type<typeof Add>;

const Clocked = contract("StreamClocked", {
  version: 1,
  key: Schema.String,
  snapshot: Schema.Finite,
  message: Schema.Union([Add]),
});

/** States the behavior reaches on its own, with no message. */
class Ticks extends Context.Service<Ticks, Queue.Queue<number>>()(
  "effect-frame/tests/actor/change-stream.test/Ticks",
) {}

const ClockedLive = implementTransparent(Clocked, {
  initial: 0,
  open: () =>
    Effect.gen(function* () {
      const ticks = yield* Ticks;
      return {
        apply: (state: number, message: Add) => Effect.succeed(state + message.amount),
        changes: Stream.fromQueue(ticks),
      };
    }),
});

const host = Effect.provideServiceEffect(
  ActorHost.make({ implementations: [ClockedLive] }),
  Ticks,
  Queue.unbounded<number>(),
);

const id = Schema.decodeSync(CommandId);
const encodeAdd = Schema.encodeSync(Clocked.message);
const addressOf = (key: string): Address => ({
  contract: Clocked.name,
  version: Clocked.version,
  key: Schema.encodeSync(Clocked.key)(key),
});

const encodeWire = Schema.encodeSync(Schema.fromJsonString(Wire.WireProjection));

/** The next revision the stream delivers after `after`. */
const nextAfter = (transport: TransportService, address: Address, after: number) =>
  Effect.map(Stream.runHead(transport.changes(address, after)), Option.getOrThrow);

describe("the change stream (#29)", () => {
  it.effect("carries no command identity, and the transport has no receipt-read verb", () =>
    Effect.sync(() => {
      expect([projectionFields, wireProjectionFields, transportVerbs]).toEqual([true, true, true]);
    }),
  );

  it.scoped("may skip revisions a client missed, and ends at the actor's state", () =>
    Effect.gen(function* () {
      const transport = yield* host;
      const address = addressOf("skip");
      // A client holds revision 1, then is absent across three commits.
      yield* transport.call(
        address,
        id("skip-1"),
        encodeAdd({ _tag: "Add", amount: 1 }),
        "1 second",
        [],
      );
      const later: ReadonlyArray<readonly [string, number]> = [
        ["skip-2", 10],
        ["skip-3", 100],
        ["skip-4", 1000],
      ];
      for (const [commandId, amount] of later) {
        yield* transport.call(
          address,
          id(commandId),
          encodeAdd({ _tag: "Add", amount }),
          "1 second",
          [],
        );
      }
      // Resuming after revision 1 delivers the newest revision first, not 2.
      const first = yield* nextAfter(transport, address, 1);
      expect(first.revision).toBe(4);
      expect(first).toEqual(yield* transport.snapshot(address));
      expect(first.snapshot).toBe("1111");
    }),
  );

  it.scoped("an autonomous revision is indistinguishable on the wire from a commanded one", () =>
    Effect.gen(function* () {
      const ticks = yield* Queue.unbounded<number>();
      const transport = yield* Effect.provideService(
        ActorHost.make({ implementations: [ClockedLive] }),
        Ticks,
        ticks,
      );
      const address = addressOf("origin");
      yield* transport.call(
        address,
        id("origin-1"),
        encodeAdd({ _tag: "Add", amount: 7 }),
        "1 second",
        [],
      );
      const commanded = yield* nextAfter(transport, address, 0);
      yield* Queue.offer(ticks, 50);
      const autonomous = yield* nextAfter(transport, address, commanded.revision);

      // One revision clock, one shape, one encoding. Nothing says which
      // revision a command produced.
      expect([commanded.revision, autonomous.revision]).toEqual([1, 2]);
      expect(Object.keys(commanded).toSorted()).toEqual(["revision", "snapshot"]);
      expect(Object.keys(autonomous).toSorted()).toEqual(Object.keys(commanded).toSorted());
      expect(encodeWire(commanded)).toBe('{"revision":1,"snapshot":"7"}');
      expect(encodeWire(autonomous)).toBe('{"revision":2,"snapshot":"50"}');
    }),
  );
});

// ---------------------------------------------------------------------------
// An Uncertain command after a reconnect
// ---------------------------------------------------------------------------

interface WireRequest {
  readonly verb: "send" | "call";
  readonly commandId: string;
}

/**
 * The real host behind a wire whose call replies can be lost and whose
 * change stream can drop. A dropped stream resubscribes from the last
 * revision it delivered once the link returns, as the HTTP transport does.
 */
const impairedWire = Effect.fn("ChangeStreamTest.impairedWire")(function* (real: TransportService) {
  const link = yield* SubscriptionRef.make(true);
  const controls = { loseReplies: false };
  const requests: Array<WireRequest> = [];
  const followLink = (address: Address, after: number) => {
    let last = after;
    const follow = (up: boolean): Stream.Stream<Projection> => {
      if (!up) {
        return Stream.empty;
      }
      return Stream.tap(real.changes(address, last).pipe(Stream.orDie), (projection) =>
        Effect.sync(() => {
          last = projection.revision;
        }),
      );
    };
    return Stream.switchMap(SubscriptionRef.changes(link), follow);
  };
  const transport: TransportService = {
    ...real,
    send: (address, commandId, payload, active) =>
      Effect.andThen(
        Effect.sync(() => requests.push({ verb: "send", commandId })),
        real.send(address, commandId, payload, active),
      ),
    call: (address, commandId, payload, timeout, active) =>
      Effect.andThen(
        Effect.sync(() => requests.push({ verb: "call", commandId })),
        Effect.suspend(() => {
          if (!controls.loseReplies) {
            return real.call(address, commandId, payload, timeout, active);
          }
          return Effect.andThen(
            Effect.exit(real.call(address, commandId, payload, timeout, active)),
            Effect.fail(Unreachable.make({ reason: "reply lost" })),
          );
        }),
      ),
    changes: followLink,
  };
  return { transport, link, controls, requests };
});

/**
 * Loses every reply of one command until the bound is spent, optionally with
 * the change stream down across the commit, then lets the stream deliver the
 * committed revision and retries. Returns what a client could observe.
 */
const exhaustThenRetry = Effect.fn("ChangeStreamTest.exhaustThenRetry")(function* (
  key: string,
  dropStream: boolean,
) {
  const wire = yield* impairedWire(yield* host);
  const counter = yield* ref(Clocked, key).pipe(
    Effect.provideService(ActorTransport, wire.transport),
  );
  if (dropStream) {
    yield* SubscriptionRef.set(wire.link, false);
  }
  wire.controls.loseReplies = true;
  const handle = yield* counter.send({ _tag: "Add", amount: 5 });
  yield* TestClock.adjust("5 minutes");
  const exhausted = yield* handle.state.get;
  const stateWhileExhausted = yield* counter.state.get;

  // The stream comes back and delivers the command's revision.
  yield* SubscriptionRef.set(wire.link, true);
  const delivered = yield* Stream.runHead(
    Stream.filter(counter.applied.changes, (applied) => applied.revision.value === 1),
  );
  // Delivering the revision settled nothing, and time alone sends nothing.
  const sentBefore = wire.requests.length;
  yield* TestClock.adjust("1 hour");
  const afterDelivery = yield* handle.state.get;
  const sentWhileIdle = wire.requests.length - sentBefore;

  wire.controls.loseReplies = false;
  const mark = wire.requests.length;
  yield* handle.retry;
  const settled = yield* handle.settled;
  const retryWire = wire.requests
    .slice(mark)
    .map((request) => [request.verb, request.commandId === handle.commandId]);
  return {
    exhausted,
    stateWhileExhausted,
    delivered: Option.map(delivered, (applied) => applied.state),
    afterDelivery,
    sentWhileIdle,
    retryWire,
    settled,
  };
});

describe("an Uncertain command after a reconnect (#29)", () => {
  it.scoped("settles by the same re-send whether or not the stream dropped across the commit", () =>
    Effect.gen(function* () {
      const connected = yield* exhaustThenRetry("steady", false);
      const reconnected = yield* exhaustThenRetry("dropped", true);

      const uncertain: CommandUncertain = {
        _tag: "Uncertain",
        attempt: 8,
        admitted: Option.some(1),
      };
      expect(reconnected.exhausted).toEqual(uncertain);
      // The stream was down across the commit: the client had not seen it.
      expect(reconnected.stateWhileExhausted).toBe(0);
      expect(reconnected.delivered).toEqual(Option.some(5));
      // The revision the reconnected stream delivered did not settle the command.
      expect(reconnected.afterDelivery).toEqual(uncertain);
      expect(reconnected.sentWhileIdle).toBe(0);
      // Only the same ID sent again settles it: one send and one call.
      expect(reconnected.retryWire).toEqual([
        ["send", true],
        ["call", true],
      ]);
      expect(reconnected.settled).toEqual({
        _tag: "Applied",
        admitted: 1,
        revision: committedRevision(1),
        state: 5,
      });

      // The same, step for step, when the stream never dropped.
      expect(connected.stateWhileExhausted).toBe(5);
      expect({ ...connected, stateWhileExhausted: 0 }).toEqual(reconnected);
    }),
  );
});
