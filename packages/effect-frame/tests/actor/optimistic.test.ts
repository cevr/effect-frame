import { Deferred, Effect, Fiber, Option, Predicate, Schema, Stream } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { Event, Machine, State } from "effect-machine";
import { ActorHost, Behavior, Policies, Policy, implement } from "effect-frame/actor";
import {
  ActorTransport,
  CommandId,
  Generated,
  Unauthorized,
  Unreachable,
  committedRevision,
  contract,
  ref,
} from "effect-frame/actor/client";
import type { Displayed, Source, TransportService } from "effect-frame/actor/client";
import { CommandPolicy } from "../../src/actor/command-owner.js";

/**
 * #19 and #67: a remote reference with a predicting behavior shows a fresh
 * send at once, as a provisional revision over its committed base. The
 * pending log is the only new state. A command leaves the display by leaving
 * the log; the committed base replaces every prediction it holds.
 */

// ---------------------------------------------------------------------------
// A list whose server stamps each item with a value the client cannot know
// ---------------------------------------------------------------------------

const Item = Schema.Struct({ text: Schema.String, stamp: Schema.String });
type Item = Schema.Schema.Type<typeof Item>;
const Append = Schema.TaggedStruct("Append", { text: Schema.String });
type Append = Schema.Schema.Type<typeof Append>;

const List = contract("OptimisticList", {
  version: 1,
  policy: "public",
  key: Schema.String,
  snapshot: Schema.Array(Item),
  message: Schema.Union([Append]),
});

/** The server's turn: the stamp is the item's committed position. */
const ListLive = implement(List, {
  behavior: Behavior.reducer<ReadonlyArray<Item>, Append>({
    initial: [],
    reduce: (items, message) => [
      ...items,
      { text: message.text, stamp: `server-${items.length + 1}` },
    ],
  }),
  state: List.snapshot,
  snapshot: (items) => items,
});

/** The client's prediction of that turn. It cannot know the stamp. */
const predicting = Behavior.reducer<ReadonlyArray<Item>, Append>({
  initial: [],
  reduce: (items, message) => [...items, { text: message.text, stamp: "pending" }],
});

const append = (text: string): Append => ({ _tag: "Append", text });
const decodeMessage = Schema.decodeSync(List.message);
const pending = (text: string): Item => ({ text, stamp: "pending" });
const stamped = (text: string, position: number): Item => ({
  text,
  stamp: `server-${position}`,
});

// ---------------------------------------------------------------------------
// The real host behind a wire the test holds by message text
// ---------------------------------------------------------------------------

interface Gate {
  readonly reached: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}

const gate = Effect.all({ reached: Deferred.make<void>(), release: Deferred.make<void>() });

const pass = (held: Option.Option<Gate>) =>
  Option.match(held, {
    onNone: () => Effect.void,
    onSome: (found) =>
      Effect.andThen(Deferred.succeed(found.reached, void 0), Deferred.await(found.release)),
  });

/**
 * Every verb reaches the real host. A send gate holds a send before the
 * host sees it; a call gate holds a call before the host sees it. A refused
 * text fails its send with `Unauthorized` before the host sees it. A lost
 * call reaches the host and loses its reply.
 */
const policies = { public: Policy.allowAll };

const heldWire = Effect.fn("OptimisticTest.heldWire")(function* () {
  const real = yield* ActorHost.make({ implementations: [ListLive] }).pipe(
    Effect.provideService(Policies, policies),
  );
  const sendGates = new Map<string, Gate>();
  const callGates = new Map<string, Gate>();
  const refused = new Set<string>();
  const lostCalls = new Map<string, number>();
  const counts = { sends: 0, calls: 0 };
  const stream = { down: false };
  const textOf = (payload: string) => decodeMessage(payload).text;
  const transport: TransportService = {
    ...real,
    changes: (address, after) =>
      Stream.unwrap(
        Effect.sync(() => {
          if (stream.down) {
            return Stream.never;
          }
          return real.changes(address, after);
        }),
      ),
    send: (address, commandId, payload, active) =>
      Effect.gen(function* () {
        const text = textOf(payload);
        yield* pass(Option.fromNullishOr(sendGates.get(text)));
        counts.sends += 1;
        if (refused.has(text)) {
          return yield* Unauthorized.make({ contract: List.name });
        }
        return yield* real.send(address, commandId, payload, active);
      }),
    call: (address, commandId, payload, timeout, active) =>
      Effect.gen(function* () {
        const text = textOf(payload);
        yield* pass(Option.fromNullishOr(callGates.get(text)));
        counts.calls += 1;
        const reply = yield* real.call(address, commandId, payload, timeout, active);
        const lose = Option.getOrElse(Option.fromNullishOr(lostCalls.get(text)), () => 0);
        if (lose > 0) {
          lostCalls.set(text, lose - 1);
          return yield* Unreachable.make({ reason: "the reply was lost" });
        }
        return reply;
      }),
  };
  const holdSend = (text: string) =>
    Effect.tap(gate, (held) => Effect.sync(() => sendGates.set(text, held)));
  const holdCall = (text: string) =>
    Effect.tap(gate, (held) => Effect.sync(() => callGates.set(text, held)));
  const release = (held: Gate) => Deferred.succeed(held.release, void 0);
  return {
    real,
    transport,
    counts,
    holdSend,
    holdCall,
    release,
    refuse: (text: string) => Effect.sync(() => refused.add(text)),
    loseCalls: (text: string, times: number) => Effect.sync(() => lostCalls.set(text, times)),
    /** The change stream delivers nothing: only receipts can move the base. */
    streamDown: Effect.sync(() => {
      stream.down = true;
    }),
  };
});

const address = { contract: List.name, version: List.version, key: '"shelf"' };

/** The first value of a source that passes the check. */
const until = <A>(source: Source<A>, check: (value: A) => boolean) =>
  Effect.map(Stream.runHead(Stream.filter(source.changes, check)), Option.getOrThrow);

/** One comparable line per list, for deduplicating a view's history. */
const render = (items: ReadonlyArray<Item>) =>
  items.map((item) => `${item.text}:${item.stamp}`).join(",");

const itemsOf = (shown: Displayed<ReadonlyArray<Item>>) => shown.state;

describe("optimistic sends (#19, #67)", () => {
  it.scoped("an optimistic send shows the new state in the same turn", () =>
    Effect.gen(function* () {
      const wire = yield* heldWire();
      const held = yield* wire.holdSend("a");
      yield* wire.streamDown;
      const list = yield* Effect.provideService(
        ref(List, "shelf", { resume: Option.none(), behavior: predicting }),
        ActorTransport,
        wire.transport,
      );

      const handle = yield* list.send(append("a"));
      // No reply has landed, and the host has not seen the command.
      expect(yield* handle.state.get).toEqual({ _tag: "Sent" });
      expect(wire.counts.sends).toBe(0);
      expect(yield* list.displayed.get).toEqual({
        revision: { _tag: "Provisional", base: 0, depth: 1 },
        state: [pending("a")],
      });
      expect(yield* list.state.get).toEqual([pending("a")]);
      // The committed value is still the committed value.
      expect(yield* list.applied.get).toEqual({ revision: committedRevision(0), state: [] });

      yield* wire.release(held);
      const settled = yield* handle.settled;
      expect(settled).toMatchObject({ _tag: "Applied", revision: committedRevision(1) });
      // The receipt alone replaces the guess; the stream delivered nothing.
      expect(yield* list.displayed.get).toEqual({
        revision: committedRevision(1),
        state: [stamped("a", 1)],
      });
    }),
  );

  it.scoped("a committed revision replaces a provisional one and never merges with it", () =>
    Effect.gen(function* () {
      const wire = yield* heldWire();
      const heldB = yield* wire.holdCall("b");
      const list = yield* Effect.provideService(
        ref(List, "shelf", { resume: Option.none(), behavior: predicting }),
        ActorTransport,
        wire.transport,
      );

      const a = yield* list.send(append("a"));
      const b = yield* list.send(append("b"));
      expect(yield* list.state.get).toEqual([pending("a"), pending("b")]);

      // A commits with a stamp the client could not predict. Its receipt
      // proves B was admitted after it, so B replays over A's commit.
      yield* a.settled;
      yield* Deferred.await(heldB.reached);
      const between = yield* until(
        list.displayed,
        (shown) => shown.revision._tag === "Provisional" && shown.revision.base === 1,
      );
      expect(between).toEqual({
        revision: { _tag: "Provisional", base: 1, depth: 1 },
        state: [stamped("a", 1), pending("b")],
      });

      yield* wire.release(heldB);
      yield* b.settled;
      const server = yield* wire.real.snapshot(address);
      expect(server.revision).toBe(2);
      const final = yield* list.displayed.get;
      expect(final).toEqual({
        revision: committedRevision(2),
        state: [stamped("a", 1), stamped("b", 2)],
      });
      // Replaced, not merged: no predicted field survives the commit.
      expect(itemsOf(final).map((item) => item.stamp)).not.toContain("pending");
    }),
  );

  it.scoped("a rejected command rolls back by leaving the pending log", () =>
    Effect.gen(function* () {
      const wire = yield* heldWire();
      const heldA = yield* wire.holdSend("a");
      const heldB = yield* wire.holdSend("b");
      yield* wire.refuse("a");
      const list = yield* Effect.provideService(
        ref(List, "shelf", { resume: Option.none(), behavior: predicting }),
        ActorTransport,
        wire.transport,
      );

      const a = yield* list.send(append("a"));
      const b = yield* list.send(append("b"));
      expect(yield* list.displayed.get).toEqual({
        revision: { _tag: "Provisional", base: 0, depth: 2 },
        state: [pending("a"), pending("b")],
      });

      yield* wire.release(heldA);
      const rejected = yield* a.settled;
      expect(rejected).toMatchObject({ _tag: "Rejected", reason: { _tag: "Unauthorized" } });
      // B is replayed from the committed base alone. Nothing undid A.
      expect(yield* list.displayed.get).toEqual({
        revision: { _tag: "Provisional", base: 0, depth: 1 },
        state: [pending("b")],
      });

      yield* wire.release(heldB);
      yield* b.settled;
      expect(yield* list.displayed.get).toEqual({
        revision: committedRevision(1),
        state: [stamped("b", 1)],
      });
    }),
  );

  it.scoped("provisional order converges on committed order", () =>
    Effect.gen(function* () {
      const wire = yield* heldWire();
      const heldA = yield* wire.holdSend("a");
      const list = yield* Effect.provideService(
        ref(List, "shelf", { resume: Option.none(), behavior: predicting }),
        ActorTransport,
        wire.transport,
      );
      const seen: Array<ReadonlyArray<Item>> = [];
      const watching = yield* Deferred.make<void>();
      const watcher = yield* Effect.forkScoped(
        // It ends on the committed order, so joining it reads every change.
        Stream.runForEach(
          Stream.takeUntil(
            list.state.changes,
            (items) => render(items) === render([stamped("b", 1), stamped("a", 2)]),
          ),
          (items) =>
            Effect.andThen(
              Effect.sync(() => {
                const last = Option.fromNullishOr(seen.at(-1));
                if (Option.isNone(last) || render(last.value) !== render(items)) {
                  seen.push(items);
                }
              }),
              Deferred.succeed(watching, void 0),
            ),
        ),
      );
      yield* Deferred.await(watching);

      // Sent A then B; the mailbox admits B first.
      const a = yield* list.send(append("a"));
      const b = yield* list.send(append("b"));
      yield* b.settled;
      // B's commit cannot show yet: A's admission is unknown, so the client
      // cannot tell whether that commit holds A. The log keeps send order.
      expect(yield* list.displayed.get).toEqual({
        revision: { _tag: "Provisional", base: 0, depth: 2 },
        state: [pending("a"), pending("b")],
      });

      yield* wire.release(heldA);
      yield* a.settled;
      const server = yield* wire.real.snapshot(address);
      const final = yield* list.displayed.get;
      expect(final).toEqual({
        revision: committedRevision(server.revision),
        state: [stamped("b", 1), stamped("a", 2)],
      });
      expect(yield* Schema.encodeEffect(List.snapshot)(final.state)).toBe(server.snapshot);
      yield* Fiber.join(watcher);
      // The view never showed a reordered guess: it went from send order to
      // the committed order through the base, one revision at a time.
      expect(seen).toEqual([
        [],
        [pending("a")],
        [pending("a"), pending("b")],
        [stamped("b", 1), pending("a")],
        [stamped("b", 1), stamped("a", 2)],
      ]);
    }),
  );

  it.scoped("a prediction that throws leaves the log and the reference keeps following", () =>
    Effect.gen(function* () {
      const wire = yield* heldWire();
      const heldA = yield* wire.holdSend("a");
      // This prediction cannot run over a state that holds "boom".
      const fragile = Behavior.reducer<ReadonlyArray<Item>, Append>({
        initial: [],
        reduce: (items, message) => {
          if (items.some((item) => item.text === "boom")) {
            // Application code can throw; this is the case under test.
            // oxlint-disable-next-line effect/noThrowStatement, effect/noNewError
            throw new Error("the prediction cannot run here");
          }
          return [...items, pending(message.text)];
        },
      });
      const list = yield* Effect.provideService(
        ref(List, "shelf", { resume: Option.none(), behavior: fragile }),
        ActorTransport,
        wire.transport,
      );

      const a = yield* list.send(append("a"));
      expect(yield* list.state.get).toEqual([pending("a")]);
      // A supplied ID does not predict. Its receipt orders "a" after it.
      const boomId = yield* Schema.decodeEffect(CommandId)("boom-1");
      const boom = yield* list.send(append("boom"), { commandId: boomId });
      yield* boom.settled;

      // "a" is admitted after "boom", so it must replay over "boom", and its
      // prediction throws there. It leaves the log; the base shows alone.
      yield* wire.release(heldA);
      const applied = yield* a.settled;
      expect(applied).toMatchObject({ _tag: "Applied", revision: committedRevision(2) });
      yield* until(list.displayed, (shown) => shown.revision._tag === "Committed");

      // Another client commits. The change stream still follows.
      const otherId = yield* Schema.decodeEffect(CommandId)("other-1");
      yield* wire.real.call(
        address,
        otherId,
        yield* Schema.encodeEffect(List.message)(append("c")),
        "1 second",
        [],
      );
      const latest = yield* until(list.applied, (committed) => committed.revision.value === 3);
      expect(latest.state).toEqual([stamped("boom", 1), stamped("a", 2), stamped("c", 3)]);
      expect(
        yield* until(
          list.displayed,
          (shown) => shown.revision._tag === "Committed" && shown.revision.value === 3,
        ),
      ).toEqual({ revision: committedRevision(3), state: latest.state });
    }),
  );

  it.scoped("a supplied command ID never predicts", () =>
    Effect.gen(function* () {
      const wire = yield* heldWire();
      const held = yield* wire.holdSend("a");
      const list = yield* Effect.provideService(
        ref(List, "shelf", { resume: Option.none(), behavior: predicting }),
        ActorTransport,
        wire.transport,
      );
      const commandId = yield* Schema.decodeEffect(CommandId)("chosen");
      const handle = yield* list.send(append("a"), { commandId });
      expect(yield* list.displayed.get).toEqual({ revision: committedRevision(0), state: [] });
      yield* wire.release(held);
      yield* handle.settled;
      expect(yield* list.state.get).toEqual([stamped("a", 1)]);
    }),
  );

  it.scoped("Generated.send mints its ID, so it predicts at once like a fresh send (#67 §3)", () =>
    Effect.gen(function* () {
      const wire = yield* heldWire();
      const held = yield* wire.holdSend("a");
      const list = yield* Effect.provideService(
        ref(List, "shelf", { resume: Option.none(), behavior: predicting }),
        ActorTransport,
        wire.transport,
      );
      const handle = yield* Generated.send(list, List, append("a"));
      expect(yield* handle.state.get).toEqual({ _tag: "Sent" });
      expect(yield* list.displayed.get).toEqual({
        revision: { _tag: "Provisional", base: 0, depth: 1 },
        state: [pending("a")],
      });
      yield* wire.release(held);
      yield* handle.settled;
      expect(yield* list.state.get).toEqual([stamped("a", 1)]);
    }),
  );

  it.scoped("an application cannot mark its own ID as minted", () =>
    Effect.gen(function* () {
      const wire = yield* heldWire();
      const held = yield* wire.holdSend("a");
      const list = yield* Effect.provideService(
        ref(List, "shelf", { resume: Option.none(), behavior: predicting }),
        ActorTransport,
        wire.transport,
      );
      const commandId = yield* Schema.decodeEffect(CommandId)("forged");
      // The same description is not the same symbol: provenance is identity.
      const forged = { commandId, [Symbol("effect-frame/actor/command-id/Minted")]: true };
      const handle = yield* list.send(append("a"), forged);
      expect(yield* list.displayed.get).toEqual({ revision: committedRevision(0), state: [] });
      yield* wire.release(held);
      yield* handle.settled;
      expect(yield* list.state.get).toEqual([stamped("a", 1)]);
    }),
  );

  it.scoped("a Proxy that answers every key cannot pass for a minted ID", () =>
    Effect.gen(function* () {
      const wire = yield* heldWire();
      const held = yield* wire.holdSend("a");
      const list = yield* Effect.provideService(
        ref(List, "shelf", { resume: Option.none(), behavior: predicting }),
        ActorTransport,
        wire.transport,
      );
      const commandId = yield* Schema.decodeEffect(CommandId)("proxied");
      // `in` and every read answer yes for every key, the private one too.
      const forged = new Proxy(
        { commandId },
        {
          has: () => true,
          get: (target, key) => {
            if (key === "commandId") {
              return target.commandId;
            }
            return true;
          },
        },
      );
      const handle = yield* list.send(append("a"), forged);
      // Supplied: nothing is predicted before the receipt.
      expect(yield* list.displayed.get).toEqual({ revision: committedRevision(0), state: [] });
      yield* wire.release(held);
      yield* handle.settled;
      expect(yield* list.state.get).toEqual([stamped("a", 1)]);
    }),
  );

  it.scoped("Uncertain keeps the provisional state and the same-ID retry applies once", () =>
    Effect.gen(function* () {
      const wire = yield* heldWire();
      yield* wire.loseCalls("a", 1);
      const list = yield* Effect.provideService(
        ref(List, "shelf", { resume: Option.none(), behavior: predicting }),
        ActorTransport,
        wire.transport,
      ).pipe(
        Effect.provideService(CommandPolicy, {
          passes: 1,
          passDeadline: "1 second",
          baseDelay: "1 millis",
          maxDelay: "1 millis",
        }),
      );

      const handle = yield* list.send(append("a"));
      const uncertain = yield* until(handle.state, (state) => state._tag === "Uncertain");
      expect(uncertain).toEqual({ _tag: "Uncertain", attempt: 1, admitted: Option.some(1) });
      // The host committed it, but this client has no receipt: the guess
      // stays on screen, and it is not yet wrong.
      expect((yield* wire.real.snapshot(address)).revision).toBe(1);
      expect(yield* list.displayed.get).toMatchObject({
        revision: { _tag: "Provisional", base: 0, depth: 1 },
      });

      yield* handle.retry;
      const settled = yield* handle.settled;
      expect(settled).toMatchObject({ _tag: "Applied", revision: committedRevision(1) });
      expect(yield* list.displayed.get).toEqual({
        revision: committedRevision(1),
        state: [stamped("a", 1)],
      });
      // Same ID, two passes, one application.
      expect(wire.counts).toEqual({ sends: 2, calls: 2 });
      expect((yield* wire.real.snapshot(address)).revision).toBe(1);
    }),
  );
});

// ---------------------------------------------------------------------------
// A machine behavior
// ---------------------------------------------------------------------------

const CounterState = State({ Counting: { count: Schema.Finite } });
const CounterEvent = Event({ Increment: {} });
const counterMachine = Machine.make({
  state: CounterState,
  event: CounterEvent,
  initial: CounterState.Counting({ count: 0 }),
}).on(CounterState.Counting, CounterEvent.Increment, ({ state }) =>
  CounterState.Counting({ count: state.count + 1 }),
);

const Counter = contract("OptimisticMachine", {
  version: 1,
  policy: "public",
  key: Schema.String,
  snapshot: counterMachine.stateSchema,
  message: counterMachine.eventSchema,
});

const counterBehavior = Behavior.machine(counterMachine);

const CounterLive = implement(Counter, {
  behavior: counterBehavior,
  state: Schema.fromJsonString(counterMachine.stateSchema),
  snapshot: (state) => state,
});

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** A reducer's prediction is its reduce function. */
const reducerPredicts: Equals<
  NonNullable<(typeof predicting)["predict"]>,
  (state: ReadonlyArray<Item>, message: Append) => ReadonlyArray<Item>
> = true;

describe("a machine behavior (#19)", () => {
  it.scoped("is never applied optimistically", () =>
    Effect.gen(function* () {
      // A machine's next state can depend on a task, so it has no prediction.
      expect(Predicate.hasProperty(counterBehavior, "predict")).toBe(false);
      expect(Predicate.hasProperty(predicting, "predict")).toBe(true);
      expect(reducerPredicts).toBe(true);
      const real = yield* ActorHost.make({ implementations: [CounterLive] }).pipe(
        Effect.provideService(Policies, policies),
      );
      const held = yield* gate;
      const heldCall = yield* gate;
      const transport: TransportService = {
        ...real,
        send: (target, commandId, payload, active) =>
          Effect.andThen(pass(Option.some(held)), real.send(target, commandId, payload, active)),
        call: (target, commandId, payload, timeout, active) =>
          Effect.andThen(
            pass(Option.some(heldCall)),
            real.call(target, commandId, payload, timeout, active),
          ),
      };
      const counter = yield* Effect.provideService(
        ref(Counter, "one", { resume: Option.none(), behavior: counterBehavior }),
        ActorTransport,
        transport,
      );

      const handle = yield* counter.send(CounterEvent.Increment);
      yield* Deferred.await(held.reached);
      expect(yield* handle.state.get).toEqual({ _tag: "Sent" });
      expect(yield* counter.displayed.get).toEqual({
        revision: committedRevision(0),
        state: CounterState.Counting({ count: 0 }),
      });

      // Admitted, with its reply held: the display stays committed.
      yield* Deferred.succeed(held.release, void 0);
      yield* Deferred.await(heldCall.reached);
      expect(yield* handle.state.get).toEqual({ _tag: "Admitted", admitted: 1 });
      expect((yield* counter.displayed.get).revision._tag).toBe("Committed");

      yield* Deferred.succeed(heldCall.release, void 0);
      yield* handle.settled;
      expect(yield* counter.displayed.get).toEqual({
        revision: committedRevision(1),
        state: CounterState.Counting({ count: 1 }),
      });
    }),
  );
});
