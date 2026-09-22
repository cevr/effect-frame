/* oxlint-disable effect/noNullish -- The private harness names absent replies and gates. */

import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect";
import { describe, expect, it, yieldFibers } from "effect-bun-test";
import {
  ActorHost,
  ActorTransport,
  CommandId,
  MailboxStore,
  durable,
  implement,
  contract,
  ref,
} from "effect-frame/actor";
import type { Address, TransportService } from "effect-frame/actor/client";
import { Unreachable, Unauthorized } from "effect-frame/actor/client";
import type { ActorRef, Applied } from "effect-frame/actor";
import type { Behavior } from "../../src/actor/behavior.js";
import type { AuthorizerService } from "../../src/actor/host.js";
import {
  classifyRefusalAfterPossibleAdmission,
  exactMembership,
  predictionPolicy,
  reconcile,
} from "./reconciliation-prototype.js";

const Add = Schema.TaggedStruct("Add", { amount: Schema.Finite, label: Schema.String });
type Add = Schema.Schema.Type<typeof Add>;

const Counter = contract("ReconciliationCounter", {
  version: 1,
  key: Schema.String,
  snapshot: Schema.Struct({ count: Schema.Finite }),
  message: Schema.Union([Add]),
});

const ServerState = Schema.Struct({ count: Schema.Finite, serverOnly: Schema.String });
type ServerState = Schema.Schema.Type<typeof ServerState>;

const stateCodec = Schema.fromJsonString(ServerState);
const key = "alice";
const id = (value: string) => Schema.decodeSync(CommandId)(value);
const add = (label: string, amount = 1): Add => ({ _tag: "Add", amount, label });
const encodedKey = Schema.encodeSync(Counter.key)(key);
const encodedAdd = (label: string, amount = 1) =>
  Schema.encodeSync(Counter.message)(add(label, amount));

type ChangeDirective = { readonly hold: Deferred.Deferred<void> };
type SendDirective = {
  readonly hold?: Deferred.Deferred<void>;
  readonly drop?: boolean;
  readonly afterCommit?: Effect.Effect<void>;
};

interface Controls {
  readonly sends: Map<string, SendDirective>;
  readonly changes: Map<number, ChangeDirective>;
}

interface Harness {
  readonly store: MailboxStore["Service"];
  readonly real: TransportService;
  readonly wrapped: TransportService;
  readonly controls: Controls;
  readonly address: Address;
  readonly sendCalls: Array<{ readonly commandId: string; readonly payload: string }>;
  readonly callCalls: Array<{ readonly commandId: string; readonly payload: string }>;
  readonly changeRevisions: Array<number>;
}

const gatedBehavior = (
  gate: Deferred.Deferred<void> | undefined,
  autonomous: Queue.Queue<ServerState> | undefined,
): Behavior<ServerState, Add> => ({
  initial: { count: 0, serverOnly: "initial" },
  open: () =>
    Effect.succeed({
      apply: (state, message) =>
        Effect.gen(function* () {
          if (message.label === "B" && gate !== undefined) {
            yield* Deferred.await(gate);
          }
          return {
            count: state.count + message.amount,
            serverOnly: `${message.label}:${state.count + message.amount}`,
          };
        }),
      changes: (() => {
        if (autonomous === undefined) return Stream.empty;
        return Stream.fromQueue(autonomous);
      })(),
    }),
});

const makeHarness = Effect.fn("ReconciliationTest.makeHarness")(function* (
  behavior: Behavior<ServerState, Add>,
  authorizer: AuthorizerService | undefined = undefined,
) {
  const store = yield* MailboxStore;
  const controls: Controls = { sends: new Map(), changes: new Map() };
  const sendCalls: Array<{ readonly commandId: string; readonly payload: string }> = [];
  const callCalls: Array<{ readonly commandId: string; readonly payload: string }> = [];
  const changeRevisions: Array<number> = [];
  const implementation = implement(Counter, {
    behavior,
    state: stateCodec,
    snapshot: (state) => ({ count: state.count }),
  });
  const host = ActorHost.make({
    implementations: [implementation],
    store: () => Layer.succeed(MailboxStore, store),
  });
  let real: TransportService;
  if (authorizer === undefined) {
    real = yield* host;
  } else {
    real = yield* host.pipe(Effect.provideService(ActorHost.Authorizer, authorizer));
  }
  const wrapped: TransportService = {
    send: (address, commandId, payload, active) =>
      Effect.gen(function* () {
        sendCalls.push({ commandId, payload });
        const result = yield* real.send(address, commandId, payload, active);
        const directive = controls.sends.get(commandId);
        if (directive?.afterCommit !== undefined) {
          yield* directive.afterCommit;
        }
        if (directive?.hold !== undefined) {
          yield* Deferred.await(directive.hold);
        }
        if (directive?.drop === true) {
          return yield* Unreachable.make({ reason: "test dropped real reply" });
        }
        return result;
      }),
    call: (address, commandId, payload, timeout, active) =>
      Effect.gen(function* () {
        callCalls.push({ commandId, payload });
        return yield* real.call(address, commandId, payload, timeout, active);
      }),
    snapshot: real.snapshot,
    query: real.query,
    queryBatch: real.queryBatch,
    changes: (address, after) =>
      real.changes(address, after).pipe(
        Stream.tap((projection) => Effect.sync(() => changeRevisions.push(projection.revision))),
        Stream.mapEffect((projection) => {
          const directive = controls.changes.get(projection.revision);
          if (directive === undefined) return Effect.succeed(projection);
          return Deferred.await(directive.hold).pipe(Effect.as(projection));
        }),
      ),
  };
  return {
    store,
    real,
    wrapped,
    controls,
    address: {
      contract: Counter.name,
      version: Counter.version,
      key: encodedKey,
    },
    sendCalls,
    callCalls,
    changeRevisions,
  } satisfies Harness;
});

const makeReference = (harness: Harness) =>
  ref(Counter, key).pipe(Effect.provideService(ActorTransport, harness.wrapped));

const storedReceipt = (harness: Harness, commandId: string) =>
  Effect.map(
    Effect.repeat(harness.store.receipt(id(commandId)), { until: Option.isSome }),
    Option.getOrThrow,
  );

const decodeReceiptState = (harness: Harness, commandId: string) =>
  Effect.map(storedReceipt(harness, commandId), (receipt) => ({
    receipt,
    state: Schema.decodeSync(stateCodec)(receipt.state),
  }));

const waitForApplied = <State, Message, Kind extends "local" | "durable" | "remote">(
  actor: ActorRef<State, Message, Kind>,
  revision: number,
): Effect.Effect<Applied<State>> =>
  Effect.gen(function* () {
    const current = yield* actor.applied.get;
    if (current.revision >= revision) return current;
    return yield* Stream.runHead(
      Stream.filter(actor.applied.changes, (applied) => applied.revision >= revision),
    ).pipe(Effect.map(Option.getOrThrow));
  });

const initialReconciliation = (state: ServerState = { count: 0, serverOnly: "initial" }) => ({
  base: { revision: 0, state },
  visible: state,
  held: undefined,
});

const withStore = it.scoped.layer(MailboxStore.layerMemory);

describe("issue 67 reconciliation prototype", () => {
  it.effect("classifies exact and anchored receipt evidence without stream identity", () =>
    Effect.sync(() => {
      expect(exactMembership(1, 1)).toBe("included");
      expect(exactMembership(2, 1)).toBe("excluded");
      expect(
        reconcile(
          initialReconciliation(),
          { revision: 1, state: { count: 1, serverOnly: "A:1" } },
          [
            {
              commandId: "B",
              admitted: 2,
              predict: (state) => ({ ...state, count: state.count + 1 }),
            },
          ],
          new Map(),
          { commandId: "A", admitted: 1, revision: 1 },
        ).visible,
      ).toEqual({ count: 2, serverOnly: "A:1" });
      expect(
        reconcile(
          initialReconciliation(),
          { revision: 1, state: { count: 1, serverOnly: "A:1" } },
          [
            {
              commandId: "B",
              admitted: undefined,
              predict: (state) => ({ ...state, count: state.count + 1 }),
            },
          ],
          new Map(),
          undefined,
        ),
      ).toEqual({
        base: { revision: 0, state: { count: 0, serverOnly: "initial" } },
        visible: { count: 0, serverOnly: "initial" },
        held: { revision: 1, state: { count: 1, serverOnly: "A:1" } },
      });
    }),
  );

  withStore("a stream commit before its receipt never double predicts", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(gatedBehavior(undefined, undefined));
      const release = yield* Deferred.make<void>();
      harness.controls.sends.set("A", { hold: release });
      const actor = yield* makeReference(harness);
      const sending = yield* Effect.forkScoped(actor.send(add("A"), { commandId: id("A") }));
      yield* yieldFibers;
      const streamed = yield* waitForApplied(actor, 1);
      expect(streamed).toEqual({ revision: 1, state: { count: 1 } });
      expect(harness.sendCalls).toHaveLength(1);

      const held = reconcile(
        initialReconciliation(),
        { revision: streamed.revision, state: { count: 1, serverOnly: "A:1" } },
        [
          {
            commandId: "A",
            admitted: undefined,
            predict: (state) => ({ ...state, count: state.count + 1 }),
          },
        ],
        new Map(),
        undefined,
      );
      expect(held.visible.count).toBe(0);
      expect(held.held?.revision).toBe(1);

      yield* Deferred.succeed(release, void 0);
      const receipt = yield* Fiber.join(sending);
      expect(receipt.admitted).toBe(1);
      const exact = yield* decodeReceiptState(harness, "A");
      expect(exact.state).toEqual({ count: 1, serverOnly: "A:1" });
      const settled = reconcile(
        held,
        streamed,
        [
          {
            commandId: "A",
            admitted: receipt.admitted,
            predict: (state) => ({ ...state, count: state.count + 1 }),
          },
        ],
        new Map([
          [
            "A",
            { commandId: "A", admitted: exact.receipt.admitted, revision: exact.receipt.revision },
          ],
        ]),
        undefined,
      );
      expect(settled.visible.count).toBe(1);
    }),
  );

  withStore("A's exact receipt keeps its server field while B is pending", () =>
    Effect.gen(function* () {
      const holdB = yield* Deferred.make<void>();
      const harness = yield* makeHarness(gatedBehavior(holdB, undefined));
      const actor = yield* makeReference(harness);
      const appliedA = yield* actor.call(add("A"), { commandId: id("A"), timeout: "1 second" });
      expect(appliedA).toEqual({ revision: 1, state: { count: 1 } });
      const exactA = yield* decodeReceiptState(harness, "A");
      expect(exactA.state.serverOnly).toBe("A:1");

      const b = yield* actor.send(add("B"), { commandId: id("B") });
      expect(b.admitted).toBe(2);
      yield* yieldFibers;
      const candidate = { revision: 1, state: exactA.state };
      const pending = [
        {
          commandId: "B",
          admitted: b.admitted,
          predict: (state: ServerState) => ({ ...state, count: state.count + 1 }),
        },
      ];
      const first = reconcile(initialReconciliation(), candidate, pending, new Map(), {
        commandId: "A",
        admitted: exactA.receipt.admitted,
        revision: exactA.receipt.revision,
      });
      expect(first.visible).toEqual({ count: 2, serverOnly: "A:1" });
      const repeated = reconcile(first, candidate, pending, new Map(), {
        commandId: "A",
        admitted: exactA.receipt.admitted,
        revision: exactA.receipt.revision,
      });
      expect(repeated.visible).toEqual({ count: 2, serverOnly: "A:1" });

      yield* Deferred.succeed(holdB, void 0);
      const exactB = yield* actor.call(add("B"), { commandId: id("B"), timeout: "1 second" });
      expect(exactB).toEqual({ revision: 2, state: { count: 2 } });
    }),
  );

  withStore("reverse durable admission order classifies each exact result", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(gatedBehavior(undefined, undefined));
      const holdB = yield* Deferred.make<void>();
      harness.controls.sends.set("B", { hold: holdB });
      const actor = yield* makeReference(harness);
      const admitA = yield* Deferred.make<void>();
      const logicalOrder: Array<string> = [];
      const sendingA = yield* Effect.forkScoped(
        Effect.gen(function* () {
          logicalOrder.push("A");
          yield* Deferred.await(admitA);
          return yield* actor.send(add("A"), { commandId: id("A") });
        }),
      );
      yield* yieldFibers;
      logicalOrder.push("B");
      const sendingB = yield* Effect.forkScoped(actor.send(add("B"), { commandId: id("B") }));
      yield* yieldFibers;
      yield* waitForApplied(actor, 1);
      yield* Deferred.succeed(admitA, void 0);
      const a = yield* Fiber.join(sendingA);
      yield* Deferred.succeed(holdB, void 0);
      const b = yield* Fiber.join(sendingB);
      expect(logicalOrder).toEqual(["A", "B"]);
      expect(harness.sendCalls.map((call) => call.commandId)).toEqual(["B", "A"]);
      expect(b.admitted).toBe(1);
      expect(a.admitted).toBe(2);

      const exactA = yield* decodeReceiptState(harness, "A");
      const exactB = yield* decodeReceiptState(harness, "B");
      expect(exactA.receipt.revision).toBe(2);
      expect(exactB.receipt.revision).toBe(1);
      expect(exactA.state.count).toBe(2);
      expect(exactB.state.count).toBe(1);
      const classified = reconcile(
        initialReconciliation(),
        { revision: exactA.receipt.revision, state: exactA.state },
        [
          {
            commandId: "B",
            admitted: b.admitted,
            predict: (state) => ({ ...state, count: state.count + 1 }),
          },
        ],
        new Map([
          ["A", { commandId: "A", admitted: a.admitted, revision: exactA.receipt.revision }],
        ]),
        { commandId: "A", admitted: a.admitted, revision: exactA.receipt.revision },
      );
      expect(classified.visible.count).toBe(2);

      const appliedA = yield* actor.call(add("A"), { commandId: id("A"), timeout: "1 second" });
      expect(appliedA).toEqual({ revision: 2, state: { count: 2 } });
      const appliedB = yield* actor.call(add("B"), { commandId: id("B"), timeout: "1 second" });
      expect(appliedB).toEqual({ revision: 1, state: { count: 1 } });
      expect(harness.sendCalls.map((call) => call.commandId)).toEqual(["B", "A"]);
    }),
  );

  withStore("unknown admission holds the prior coherent view", () =>
    Effect.gen(function* () {
      const autonomous = yield* Queue.unbounded<ServerState>();
      const harness = yield* makeHarness(gatedBehavior(undefined, autonomous));
      const holdB = yield* Deferred.make<void>();
      harness.controls.sends.set("B", { hold: holdB });
      const actor = yield* makeReference(harness);
      yield* actor.call(add("A"), { commandId: id("A"), timeout: "1 second" });
      const before = initialReconciliation({ count: 1, serverOnly: "A:1" });
      const sendingB = yield* Effect.forkScoped(actor.send(add("B"), { commandId: id("B") }));
      yield* yieldFibers;
      yield* waitForApplied(actor, 2);
      yield* Queue.offer(autonomous, { count: 99, serverOnly: "remote:99" });
      const candidate = yield* waitForApplied(actor, 3);
      expect(candidate).toEqual({ revision: 3, state: { count: 99 } });
      const held = reconcile(
        before,
        { revision: candidate.revision, state: { count: 99, serverOnly: "remote:99" } },
        [
          {
            commandId: "B",
            admitted: undefined,
            predict: (state) => ({ ...state, count: state.count + 1 }),
          },
        ],
        new Map(),
        undefined,
      );
      expect(held.visible).toEqual(before.visible);
      expect(held.held?.revision).toBe(3);
      yield* Deferred.succeed(holdB, void 0);
      const b = yield* Fiber.join(sendingB);
      const exactB = yield* decodeReceiptState(harness, "B");
      expect(b.admitted).toBe(2);
      const published = reconcile(
        held,
        { revision: candidate.revision, state: { count: 99, serverOnly: "remote:99" } },
        [
          {
            commandId: "B",
            admitted: exactB.receipt.admitted,
            predict: (state) => ({ ...state, count: state.count + 1 }),
          },
        ],
        new Map([
          [
            "B",
            {
              commandId: "B",
              admitted: exactB.receipt.admitted,
              revision: exactB.receipt.revision,
            },
          ],
        ]),
        undefined,
      );
      expect(published.visible).toEqual({ count: 99, serverOnly: "remote:99" });
    }),
  );

  withStore("autonomous revisions and late receipts never regress the newest base", () =>
    Effect.gen(function* () {
      const autonomous = yield* Queue.unbounded<ServerState>();
      const holdA = yield* Deferred.make<void>();
      const harness = yield* makeHarness(gatedBehavior(undefined, autonomous));
      harness.controls.sends.set("A", { hold: holdA });
      const actor = yield* makeReference(harness);
      const sendingA = yield* Effect.forkScoped(actor.send(add("A"), { commandId: id("A") }));
      yield* waitForApplied(actor, 1);
      yield* Queue.offer(autonomous, { count: 10, serverOnly: "autonomous:10" });
      yield* waitForApplied(actor, 2);
      yield* Deferred.succeed(holdA, void 0);
      const receiptA = yield* Fiber.join(sendingA);
      const exactA = yield* decodeReceiptState(harness, "A");
      expect(receiptA.admitted).toBe(1);
      expect(exactA.receipt.revision).toBe(1);

      const afterAutonomous = reconcile(
        initialReconciliation(),
        { revision: 2, state: { count: 10, serverOnly: "autonomous:10" } },
        [
          {
            commandId: "A",
            admitted: receiptA.admitted,
            predict: (state) => ({ ...state, count: state.count + 1 }),
          },
        ],
        new Map([["A", { commandId: "A", admitted: 1, revision: 1 }]]),
        undefined,
      );
      expect(afterAutonomous.visible).toEqual({ count: 10, serverOnly: "autonomous:10" });

      const appliedB = yield* actor.call(add("B"), { commandId: id("B"), timeout: "1 second" });
      expect(appliedB.revision).toBe(3);
      const exactB = yield* decodeReceiptState(harness, "B");
      const newest = reconcile(
        afterAutonomous,
        { revision: appliedB.revision, state: { count: 11, serverOnly: "B:11" } },
        [],
        new Map([
          [
            "B",
            {
              commandId: "B",
              admitted: exactB.receipt.admitted,
              revision: exactB.receipt.revision,
            },
          ],
        ]),
        undefined,
      );
      expect(newest.visible).toEqual({ count: 11, serverOnly: "B:11" });
      const lateA = reconcile(
        newest,
        { revision: exactA.receipt.revision, state: exactA.state },
        [],
        new Map([["A", { commandId: "A", admitted: 1, revision: 1 }]]),
        undefined,
      );
      expect(lateA).toEqual(newest);
    }),
  );

  withStore("a settled command retains its overlay until its stream base arrives", () =>
    Effect.gen(function* () {
      const holdChange = yield* Deferred.make<void>();
      const harness = yield* makeHarness(gatedBehavior(undefined, undefined));
      harness.controls.changes.set(1, { hold: holdChange });
      const stream = yield* Effect.forkScoped(
        Stream.runHead(harness.wrapped.changes(harness.address, 0)),
      );
      yield* yieldFibers;
      const applied = yield* harness.wrapped.call(
        harness.address,
        id("A"),
        encodedAdd("A"),
        "1 second",
        [],
      );
      expect(applied.projection).toEqual({ revision: 1, snapshot: '{"count":1}' });
      const exact = yield* decodeReceiptState(harness, "A");
      const pending = [
        {
          commandId: "A",
          admitted: exact.receipt.admitted,
          predict: (state: ServerState) => ({ ...state, count: state.count + 1 }),
        },
      ];
      const retained = reconcile(
        initialReconciliation(),
        { revision: 0, state: initialReconciliation().base.state },
        pending,
        new Map([
          [
            "A",
            { commandId: "A", admitted: exact.receipt.admitted, revision: exact.receipt.revision },
          ],
        ]),
        undefined,
      );
      expect(retained.base.revision).toBe(0);
      expect(retained.visible.count).toBe(1);
      const noBase = reconcile(
        retained,
        { revision: exact.receipt.revision, state: exact.state },
        pending,
        new Map([
          [
            "A",
            { commandId: "A", admitted: exact.receipt.admitted, revision: exact.receipt.revision },
          ],
        ]),
        undefined,
      );
      expect(noBase.visible.count).toBe(1);
      expect(harness.changeRevisions).toContain(1);
      yield* Deferred.succeed(holdChange, void 0);
      expect(yield* Fiber.join(stream)).toEqual(
        Option.some({ revision: 1, snapshot: '{"count":1}' }),
      );
      const incorporated = reconcile(
        noBase,
        { revision: 1, state: exact.state },
        pending,
        new Map([
          [
            "A",
            { commandId: "A", admitted: exact.receipt.admitted, revision: exact.receipt.revision },
          ],
        ]),
        undefined,
      );
      expect(incorporated.visible).toEqual(exact.state);
    }),
  );

  withStore("attempt eight stops automatic traffic and manual retry reuses bytes", () =>
    Effect.gen(function* () {
      const autonomous = yield* Queue.unbounded<ServerState>();
      const harness = yield* makeHarness(gatedBehavior(undefined, autonomous));
      const payload = encodedAdd("A");
      const commandId = id("A");
      const automatic = Effect.gen(function* () {
        for (let attempt = 1; attempt <= 8; attempt += 1) {
          yield* Effect.flip(harness.wrapped.send(harness.address, commandId, payload, []));
        }
      });
      for (let state = 1; state <= 16; state += 1) {
        yield* Queue.offer(autonomous, { count: state, serverOnly: `remote:${state}` });
      }
      harness.controls.sends.set("A", { drop: true });
      yield* automatic;
      const trafficAtEight = {
        sends: harness.sendCalls.length,
        calls: harness.callCalls.length,
      };
      expect(trafficAtEight).toEqual({ sends: 8, calls: 0 });
      yield* yieldFibers;
      expect(harness.sendCalls.length).toBe(8);
      expect(harness.callCalls.length).toBe(0);

      harness.controls.sends.set("A", {});
      const manual = yield* harness.wrapped.send(harness.address, commandId, payload, []);
      expect(manual.receipt.commandId).toBe(commandId);
      expect((yield* storedReceipt(harness, "A")).revision).toBe(1);
      expect(harness.sendCalls).toHaveLength(9);
      expect(new Set(harness.sendCalls.map((call) => call.commandId))).toEqual(new Set(["A"]));
      expect(new Set(harness.sendCalls.map((call) => call.payload))).toEqual(new Set([payload]));
    }),
  );

  withStore(
    "a supplied ID already committed before reference construction does not predict twice",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness(gatedBehavior(undefined, undefined));
        const payload = encodedAdd("A");
        const first = yield* harness.real.call(
          harness.address,
          id("supplied"),
          payload,
          "1 second",
          [],
        );
        expect(first.projection.revision).toBe(1);
        const actor = yield* makeReference(harness);
        expect(yield* actor.applied.get).toEqual({ revision: 1, state: { count: 1 } });
        expect(predictionPolicy("supplied")).toBe("await-receipt");
        expect(predictionPolicy("generated")).toBe("predict-immediately");
        const duplicate = yield* actor.send(add("A"), { commandId: id("supplied") });
        expect(duplicate.committed).toEqual(Option.some(1));
        expect(yield* harness.store.latest).toEqual(
          Option.some({ revision: 1, state: '{"count":1,"serverOnly":"A:1"}' }),
        );
        expect(harness.sendCalls).toHaveLength(1);
        expect(harness.sendCalls[0]?.payload).toBe(payload);
      }),
  );

  withStore("scope close ends the waiter while admitted durable work remains recoverable", () =>
    Effect.gen(function* () {
      const holdB = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const behavior: Behavior<ServerState, Add> = {
        initial: { count: 0, serverOnly: "initial" },
        open: () =>
          Effect.succeed({
            apply: (state, message) =>
              Effect.gen(function* () {
                if (message.label === "B") {
                  yield* Deferred.succeed(started, void 0);
                  yield* Deferred.await(holdB);
                }
                return {
                  count: state.count + message.amount,
                  serverOnly: `${message.label}:${state.count + message.amount}`,
                };
              }),
            changes: Stream.empty,
          }),
      };
      const store = yield* MailboxStore;
      const serverScope = yield* Scope.make();
      const implementation = implement(Counter, {
        behavior,
        state: stateCodec,
        snapshot: (state) => ({ count: state.count }),
      });
      const real = yield* ActorHost.make({
        implementations: [implementation],
        store: () => Layer.succeed(MailboxStore, store),
      }).pipe(Scope.provide(serverScope));
      const clientScope = yield* Scope.make();
      const actor = yield* ref(Counter, key).pipe(
        Effect.provideService(ActorTransport, real),
        Scope.provide(clientScope),
      );
      const waiting = yield* Effect.forkIn(
        Effect.flip(actor.call(add("B"), { commandId: id("B"), timeout: "1 hour" })),
        clientScope,
      );
      yield* Deferred.await(started);
      yield* Scope.close(clientScope, Exit.void);
      const waiterExit = yield* Effect.exit(Fiber.join(waiting));
      expect(Exit.isFailure(waiterExit)).toBe(true);
      expect(yield* store.pending).toEqual([id("B")]);

      yield* Deferred.succeed(holdB, void 0);
      const receipt = yield* Effect.repeat(store.receipt(id("B")), { until: Option.isSome });
      expect(Option.getOrThrow(receipt).revision).toBe(1);
      expect(yield* store.pending).toEqual([]);
      yield* Scope.close(serverScope, Exit.void);
    }),
  );

  withStore("refusal after a possible admission stays uncertain", () =>
    Effect.gen(function* () {
      const allowed = yield* Ref.make(true);
      const authorizer: AuthorizerService = {
        authorize: (address) =>
          Effect.flatMap(Ref.get(allowed), (isAllowed) => {
            if (isAllowed) return Effect.void;
            return Unauthorized.make({ contract: address.contract });
          }),
      };
      const harness = yield* makeHarness(gatedBehavior(undefined, undefined), authorizer);
      const payload = encodedAdd("A");
      harness.controls.sends.set("A", {
        drop: true,
        afterCommit: Effect.repeat(harness.store.receipt(id("A")), { until: Option.isSome }).pipe(
          Effect.asVoid,
        ),
      });
      const lost = yield* Effect.flip(harness.wrapped.send(harness.address, id("A"), payload, []));
      expect(lost._tag).toBe("Unreachable");
      yield* Ref.set(allowed, false);
      const refused = yield* Effect.flip(
        harness.wrapped.send(harness.address, id("A"), payload, []),
      );
      expect(refused._tag).toBe("Unauthorized");
      expect(classifyRefusalAfterPossibleAdmission(true)).toBe("uncertain");

      const store = yield* MailboxStore;
      const serverScope = yield* Scope.make();
      const actor = yield* durableForTest(gatedBehavior(undefined, undefined), store).pipe(
        Scope.provide(serverScope),
      );
      const admitted = yield* actor.send(add("S"), { commandId: id("S") });
      expect(admitted.admitted).toBe(2);
      yield* Scope.close(serverScope, Exit.void);
      const stopped = yield* Effect.flip(actor.send(add("S"), { commandId: id("S") }));
      expect(stopped._tag).toBe("ActorStopped");
      expect(classifyRefusalAfterPossibleAdmission(true)).toBe("uncertain");
    }),
  );
});

const durableForTest = (behavior: Behavior<ServerState, Add>, store: MailboxStore["Service"]) =>
  durable({ behavior, state: stateCodec, message: Counter.message }).pipe(
    Effect.provideService(MailboxStore, store),
  );
