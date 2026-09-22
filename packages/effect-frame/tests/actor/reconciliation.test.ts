/* oxlint-disable effect/noNullish -- The private harness names absent replies and gates. */
/* oxlint-disable effect/noNodeBuiltinImport -- The test supplies a platform Crypto layer. */

import {
  Crypto,
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
import { randomBytes } from "node:crypto";
import { TestClock } from "effect/testing";
import { describe, expect, it, yieldFibers } from "effect-bun-test";
import {
  ActorHost,
  ActorTransport,
  CommandId,
  MailboxStore,
  contract,
  implement,
  ref,
} from "effect-frame/actor";
import type { ActorRef, Applied } from "effect-frame/actor";
import type { Address, Projection, TransportService } from "effect-frame/actor/client";
import { Unauthorized, Unreachable } from "effect-frame/actor/client";
import type { Behavior } from "../../src/actor/behavior.js";
import type { AuthorizerService } from "../../src/actor/host.js";
import {
  anchoredMembership,
  classifyRefusalAfterPossibleAdmission,
  exactMembership,
  makeCoordinator,
  predictionPolicy,
  reconcile,
} from "./reconciliation-prototype.js";
import type {
  Candidate,
  ClientCoordinator,
  CoordinatorOptions,
  Reconciliation,
} from "./reconciliation-prototype.js";

const Add = Schema.TaggedStruct("Add", { amount: Schema.Finite, label: Schema.String });
type Add = Schema.Schema.Type<typeof Add>;

const PublicSnapshot = Schema.Struct({ count: Schema.Finite, publicToken: Schema.String });
type PublicState = Schema.Schema.Type<typeof PublicSnapshot>;

const Counter = contract("ReconciliationCounter", {
  version: 1,
  key: Schema.String,
  snapshot: PublicSnapshot,
  message: Schema.Union([Add]),
});

const ServerState = Schema.Struct({
  count: Schema.Finite,
  serverOnly: Schema.String,
  publicToken: Schema.String,
});
type ServerState = Schema.Schema.Type<typeof ServerState>;

const stateCodec = Schema.fromJsonString(ServerState);
const decodeCommandId = Schema.decodeSync(CommandId);
const decodePrivateState = Schema.decodeSync(stateCodec);
const decodePublicState = Schema.decodeSync(Counter.snapshot);
const key = "alice";
const id = (value: string) => decodeCommandId(value);
const add = (label: string, amount = 1): Add => ({ _tag: "Add", amount, label });
const testCryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => randomBytes(size),
    digest: (_algorithm, data) => Effect.succeed(data),
  }),
);
const opaqueToken = (crypto: Crypto.Crypto) =>
  Effect.map(Effect.orDie(crypto.randomUUIDv4), (value) => `opaque:${value}`);
const encodedKey = Schema.encodeSync(Counter.key)(key);
const encodedAdd = (label: string, amount = 1) =>
  Schema.encodeSync(Counter.message)(add(label, amount));

type ChangeDirective = { readonly hold: Deferred.Deferred<void> };
type SendDirective = {
  readonly hold?: Deferred.Deferred<void>;
  readonly drop?: boolean;
  readonly afterCommit?: Effect.Effect<void>;
};
type CallDirective = { readonly hold?: Deferred.Deferred<void>; readonly drop?: boolean };

interface Controls {
  readonly sends: Map<string, SendDirective>;
  readonly calls: Map<string, CallDirective>;
  readonly changes: Map<number, ChangeDirective>;
  defaultSendHold: Deferred.Deferred<void> | undefined;
  defaultCallHold: Deferred.Deferred<void> | undefined;
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
): Behavior<ServerState, Add, Crypto.Crypto> => ({
  initial: { count: 0, serverOnly: "private:initial", publicToken: "public:initial" },
  open: () =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      return {
        apply: (state, message) =>
          Effect.gen(function* () {
            if (message.label === "B" && gate !== undefined) {
              yield* Deferred.await(gate);
            }
            const count = state.count + message.amount;
            const serverOnly = `private:${message.label}:${count}`;
            return {
              count,
              serverOnly,
              publicToken: yield* opaqueToken(crypto),
            };
          }),
        changes: (() => {
          if (autonomous === undefined) return Stream.empty;
          return Stream.fromQueue(autonomous);
        })(),
      };
    }),
});

const makeHarness = Effect.fn("ReconciliationTest.makeHarness")(function* (
  behavior: Behavior<ServerState, Add, Crypto.Crypto>,
  authorizer: AuthorizerService | undefined = undefined,
) {
  const store = yield* MailboxStore;
  const controls: Controls = {
    sends: new Map(),
    calls: new Map(),
    changes: new Map(),
    defaultSendHold: undefined,
    defaultCallHold: undefined,
  };
  const sendCalls: Array<{ readonly commandId: string; readonly payload: string }> = [];
  const callCalls: Array<{ readonly commandId: string; readonly payload: string }> = [];
  const changeRevisions: Array<number> = [];
  const implementation = implement(Counter, {
    behavior,
    state: stateCodec,
    snapshot: (state) => ({ count: state.count, publicToken: state.publicToken }),
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
        const hold = directive?.hold ?? controls.defaultSendHold;
        if (hold !== undefined) {
          yield* Deferred.await(hold);
        }
        if (directive?.drop === true) {
          return yield* Unreachable.make({ reason: "test dropped real reply" });
        }
        return result;
      }),
    call: (address, commandId, payload, timeout, active) =>
      Effect.gen(function* () {
        callCalls.push({ commandId, payload });
        const result = yield* real.call(address, commandId, payload, timeout, active);
        const directive = controls.calls.get(commandId);
        const hold = directive?.hold ?? controls.defaultCallHold;
        if (hold !== undefined) {
          yield* Deferred.await(hold);
        }
        if (directive?.drop === true) {
          return yield* Unreachable.make({ reason: "test dropped real call reply" });
        }
        return result;
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

const decodePrivateReceipt = (harness: Harness, commandId: string) =>
  Effect.map(storedReceipt(harness, commandId), (receipt) => ({
    receipt,
    state: decodePrivateState(receipt.state),
  }));

const decodePublicProjection = (projection: Projection): Candidate<PublicState> => ({
  revision: projection.revision,
  state: decodePublicState(projection.snapshot),
});

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

const initialReconciliation = (
  state: PublicState = { count: 0, publicToken: "public:initial" },
): Reconciliation<PublicState> => ({
  base: { revision: 0, state },
  visible: state,
  held: undefined,
});

const makeClient = (harness: Harness) => {
  const options: CoordinatorOptions<PublicState, Add> = {
    transport: harness.wrapped,
    address: harness.address,
    encode: (message) => Effect.orDie(Schema.encodeEffect(Counter.message)(message)),
    decode: (projection) => Effect.sync(() => decodePublicProjection(projection)),
    timeout: "1 hour",
    retryDelay: "1 second",
    maxAttempts: 8,
  };
  return makeCoordinator(options);
};

const filterChanges = (harness: Harness, keep: (projection: Projection) => boolean): Harness => ({
  ...harness,
  wrapped: {
    ...harness.wrapped,
    changes: (address, after) => harness.wrapped.changes(address, after).pipe(Stream.filter(keep)),
  },
});

const command = <State, Message>(
  coordinator: ClientCoordinator<State, Message>,
  commandId: CommandId,
) => Effect.map(coordinator.command(commandId), Option.getOrThrow);

const withStore = it.scoped.layer(Layer.merge(MailboxStore.layerMemory, testCryptoLayer));

describe("issue 67 reconciliation prototype", () => {
  it.effect("classifies the complete admission and revision comparison table", () =>
    Effect.sync(() => {
      expect(exactMembership(1, 1)).toBe("included");
      expect(exactMembership(2, 1)).toBe("excluded");
      const anchor = { admitted: 2, revision: 2 };
      const cases = [
        [3, 1, "included"],
        [3, 2, "included"],
        [3, 3, "unknown"],
        [2, 1, "included"],
        [2, 2, "included"],
        [2, 3, "excluded"],
        [1, 1, "unknown"],
        [1, 2, "excluded"],
        [1, 3, "excluded"],
      ] satisfies ReadonlyArray<readonly [number, number, "included" | "excluded" | "unknown"]>;
      for (const [candidateRevision, admission, expected] of cases) {
        expect(anchoredMembership(anchor, candidateRevision, admission)).toBe(expected);
      }
      expect(anchoredMembership(anchor, 1, undefined)).toBe("unknown");
      expect(anchoredMembership(undefined, 1, 1)).toBe("unknown");
    }),
  );

  it.effect("keeps a newer held candidate while later evidence releases it", () =>
    Effect.sync(() => {
      const state = (count: number): PublicState => ({ count, publicToken: `token:${count}` });
      const pending = [
        {
          commandId: "B",
          admitted: 2,
          predict: (current: PublicState): PublicState => ({
            ...current,
            count: current.count + 1,
          }),
        },
      ];
      const held = reconcile(
        {
          base: { revision: 0, state: state(0) },
          visible: state(0),
          held: { revision: 5, state: state(5) },
        },
        { revision: 3, state: state(3) },
        pending,
        new Map(),
        { commandId: "A", admitted: 1, revision: 3 },
      );
      expect(held.base).toEqual({ revision: 3, state: state(3) });
      expect(held.visible).toEqual({ count: 4, publicToken: "token:3" });
      expect(held.held).toEqual({ revision: 5, state: state(5) });

      const published = reconcile(
        held,
        { revision: 3, state: state(3) },
        pending,
        new Map([["B", { commandId: "B", admitted: 2, revision: 5 }]]),
        { commandId: "A", admitted: 1, revision: 3 },
      );
      expect(published.base).toEqual({ revision: 5, state: state(5) });
      expect(published.visible).toEqual({ count: 5, publicToken: "token:5" });
      expect(published.held).toBeUndefined();
    }),
  );

  withStore("a classified old held value retains a newer unknown candidate", () =>
    Effect.gen(function* () {
      const autonomous = yield* Queue.unbounded<ServerState>();
      const serverB = yield* Deferred.make<void>();
      const callA = yield* Deferred.make<void>();
      const callB = yield* Deferred.make<void>();
      const harness = yield* makeHarness(gatedBehavior(serverB, autonomous));
      harness.controls.sends.set("A", { drop: true });
      harness.controls.calls.set("A", { hold: callA });
      harness.controls.calls.set("B", { hold: callB });
      const coordinator = yield* makeClient(
        filterChanges(harness, (projection) => projection.revision !== 2),
      );

      yield* coordinator.submitSupplied(id("A"), add("A"), (state) => ({
        ...state,
        count: state.count + 1,
      }));
      yield* yieldFibers;
      yield* coordinator.submitSupplied(id("B"), add("B"), (state) => ({
        ...state,
        count: state.count + 1,
      }));
      yield* yieldFibers;
      expect((yield* coordinator.view).held?.revision).toBe(1);
      expect((yield* command(coordinator, id("B"))).admitted).toBe(2);

      harness.controls.sends.set("A", {});
      yield* TestClock.adjust("1 second");
      yield* yieldFibers;
      expect((yield* command(coordinator, id("A"))).admitted).toBe(1);
      expect((yield* command(coordinator, id("A"))).exact).toBeUndefined();
      expect((yield* coordinator.view).held?.revision).toBe(1);

      yield* Deferred.succeed(serverB, void 0);
      yield* yieldFibers;
      yield* Queue.offer(autonomous, {
        count: 99,
        serverOnly: "private:99",
        publicToken: "public:99",
      });
      yield* yieldFibers;
      const before = yield* coordinator.view;
      yield* Deferred.succeed(callB, void 0);
      yield* yieldFibers;
      const after = yield* coordinator.view;
      expect(before.base.revision).toBe(1);
      expect(before.visible.count).toBe(2);
      expect(before.held?.revision).toBe(3);
      expect(after.base.revision).toBe(3);
      expect(after.visible.count).toBe(99);
    }),
  );

  withStore("a conclusive first-send refusal removes generated prediction", () =>
    Effect.gen(function* () {
      const authorizer: AuthorizerService = {
        authorize: (address, action) => {
          if (action === "send") return Unauthorized.make({ contract: address.contract });
          return Effect.void;
        },
      };
      const harness = yield* makeHarness(gatedBehavior(undefined, undefined), authorizer);
      const coordinator = yield* makeClient(harness);
      const submitted = yield* coordinator.submitGenerated(add("A"), (state) => ({
        ...state,
        count: state.count + 1,
      }));
      yield* yieldFibers;
      const status = yield* command(coordinator, submitted.commandId);
      expect(status.phase).toBe("rejected");
      expect(status.attempts).toBe(1);
      expect(status.possibleAdmission).toBe(false);
      expect((yield* coordinator.view).visible.count).toBe(0);
    }),
  );

  withStore("a real older candidate stays unknown before a newer anchor", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(gatedBehavior(undefined, undefined));
      const actor = yield* makeReference(harness);
      const b = yield* actor.send(add("B"), { commandId: id("B") });
      const holdB = yield* Deferred.make<void>();
      harness.controls.calls.set("B", { hold: holdB });
      const waitingB = yield* Effect.forkScoped(
        actor.call(add("B"), { commandId: id("B"), timeout: "1 second" }),
      );
      const candidateB = yield* waitForApplied(actor, 1);
      const a = yield* actor.send(add("A"), { commandId: id("A") });
      const exactA = yield* actor.call(add("A"), { commandId: id("A"), timeout: "1 second" });
      const publicA: Candidate<PublicState> = exactA;
      const delayed = reconcile(
        initialReconciliation(),
        candidateB,
        [
          {
            commandId: "B",
            admitted: b.admitted,
            predict: (state) => ({ ...state, count: state.count + 1 }),
          },
        ],
        new Map([["A", { commandId: "A", admitted: a.admitted, revision: publicA.revision }]]),
        { commandId: "A", admitted: a.admitted, revision: publicA.revision },
      );
      expect(candidateB.revision).toBe(1);
      expect(publicA.revision).toBe(2);
      expect(delayed.visible).toEqual(initialReconciliation().visible);
      expect(delayed.held).toEqual(candidateB);

      yield* Deferred.succeed(holdB, void 0);
      const exactB = yield* Fiber.join(waitingB);
      expect(exactB.revision).toBe(1);
      const published = reconcile(
        delayed,
        candidateB,
        [
          {
            commandId: "B",
            admitted: b.admitted,
            predict: (state) => ({ ...state, count: state.count + 1 }),
          },
        ],
        new Map([
          ["A", { commandId: "A", admitted: a.admitted, revision: publicA.revision }],
          ["B", { commandId: "B", admitted: b.admitted, revision: exactB.revision }],
        ]),
        { commandId: "A", admitted: a.admitted, revision: publicA.revision },
      );
      expect(published.visible).toEqual(candidateB.state);
    }),
  );

  withStore("a generated coordinator prediction survives a stream before its receipt", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(gatedBehavior(undefined, undefined));
      const release = yield* Deferred.make<void>();
      harness.controls.defaultSendHold = release;
      const coordinator = yield* makeClient(harness);
      const submitted = yield* coordinator.submitGenerated(add("A"), (state) => ({
        ...state,
        count: state.count + 1,
      }));
      expect(submitted.identity).toBe("generated");
      expect(submitted.commandId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect((yield* coordinator.view).visible).toEqual({
        count: 1,
        publicToken: "public:initial",
      });
      yield* yieldFibers;
      expect(harness.sendCalls).toHaveLength(1);
      expect(harness.sendCalls[0]?.commandId).toBe(submitted.commandId);
      expect(harness.changeRevisions).toContain(1);
      expect((yield* coordinator.view).visible.count).toBe(1);
      expect((yield* command(coordinator, submitted.commandId)).phase).toBe("pending");

      harness.controls.defaultSendHold = undefined;
      yield* Deferred.succeed(release, void 0);
      yield* yieldFibers;
      const settled = yield* command(coordinator, submitted.commandId);
      expect(settled.phase).toBe("applied");
      expect(settled.exact?.state.count).toBe(1);
      expect((yield* coordinator.view).visible.count).toBe(1);
      expect((yield* coordinator.view).visible.publicToken).toMatch(/^opaque:/);
      expect(harness.callCalls).toHaveLength(1);
    }),
  );

  withStore("a public server field remains visible while a later command is pending", () =>
    Effect.gen(function* () {
      const holdB = yield* Deferred.make<void>();
      const holdA = yield* Deferred.make<void>();
      const harness = yield* makeHarness(gatedBehavior(holdB, undefined));
      harness.controls.defaultCallHold = holdA;
      const coordinator = yield* makeClient(harness);
      const first = yield* coordinator.submitGenerated(add("A"), (state) => ({
        ...state,
        count: state.count + 1,
      }));
      yield* yieldFibers;
      const second = yield* coordinator.submitGenerated(add("B"), (state) => ({
        ...state,
        count: state.count + 1,
      }));
      yield* yieldFibers;
      expect((yield* command(coordinator, second.commandId)).admitted).toBe(2);
      expect((yield* coordinator.view).visible).toEqual({
        count: 2,
        publicToken: "public:initial",
      });
      expect((yield* command(coordinator, second.commandId)).phase).toBe("pending");
      expect(yield* harness.store.pending).toEqual([id(second.commandId)]);

      harness.controls.defaultCallHold = undefined;
      yield* Deferred.succeed(holdA, void 0);
      yield* yieldFibers;
      const firstCommand = yield* command(coordinator, first.commandId);
      expect(firstCommand.phase).toBe("applied");
      const firstExact = Option.getOrThrow(Option.fromNullishOr(firstCommand.exact));
      expect(firstExact.state.publicToken).toMatch(/^opaque:/);
      const privateFirst = yield* decodePrivateReceipt(harness, first.commandId);
      expect(privateFirst.state.serverOnly).toContain("private:A");
      expect(Object.hasOwn(firstCommand.exact?.state ?? {}, "serverOnly")).toBe(false);
      expect((yield* command(coordinator, second.commandId)).phase).toBe("pending");
      expect((yield* coordinator.view).visible).toEqual({
        count: 2,
        publicToken: firstExact.state.publicToken,
      });

      yield* Deferred.succeed(holdB, void 0);
      yield* yieldFibers;
      const secondCommand = yield* command(coordinator, second.commandId);
      expect(secondCommand.phase).toBe("applied");
      expect(secondCommand.exact?.state.publicToken).not.toBe(firstExact.state.publicToken);
    }),
  );

  withStore("reverse durable admission keeps each real exact public result", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(gatedBehavior(undefined, undefined));
      const releaseA = yield* Deferred.make<void>();
      const transport: TransportService = {
        ...harness.wrapped,
        send: (address, commandId, payload, active) => {
          if (commandId === id("A")) {
            return Deferred.await(releaseA).pipe(
              Effect.flatMap(() => harness.wrapped.send(address, commandId, payload, active)),
            );
          }
          return harness.wrapped.send(address, commandId, payload, active);
        },
      };
      const coordinator = yield* makeClient({ ...harness, wrapped: transport });
      const a = yield* coordinator.submitSupplied(id("A"), add("A"), (state) => ({
        ...state,
        count: state.count + 1,
      }));
      const b = yield* coordinator.submitSupplied(id("B"), add("B"), (state) => ({
        ...state,
        count: state.count + 1,
      }));
      yield* yieldFibers;
      const bCommand = yield* command(coordinator, b.commandId);
      expect(harness.sendCalls.map((call) => call.commandId)).toEqual(["B"]);
      expect(bCommand.phase).toBe("applied");
      expect(bCommand.exact?.revision).toBe(1);

      yield* Deferred.succeed(releaseA, void 0);
      yield* yieldFibers;
      const aCommand = yield* command(coordinator, a.commandId);
      expect(harness.sendCalls.map((call) => call.commandId)).toEqual(["B", "A"]);
      expect(aCommand.phase).toBe("applied");
      expect(aCommand.exact?.revision).toBe(2);
      expect(aCommand.exact?.state.count).toBe(2);
      expect(bCommand.exact?.state.publicToken).not.toBe(aCommand.exact?.state.publicToken);
      const exactA = Option.getOrThrow(Option.fromNullishOr(aCommand.exact));
      expect((yield* coordinator.view).base).toEqual(exactA);
      expect((yield* coordinator.view).visible.count).toBe(2);
    }),
  );

  withStore("unknown admission holds real autonomous projections until receipt evidence", () =>
    Effect.gen(function* () {
      const autonomous = yield* Queue.unbounded<ServerState>();
      const harness = yield* makeHarness(gatedBehavior(undefined, autonomous));
      const holdB = yield* Deferred.make<void>();
      harness.controls.sends.set("B", { hold: holdB });
      const coordinator = yield* makeClient(harness);
      const submitted = yield* coordinator.submitSupplied(id("B"), add("B"), (state) => ({
        ...state,
        count: state.count + 1,
      }));
      yield* yieldFibers;
      expect((yield* command(coordinator, submitted.commandId)).admitted).toBeUndefined();
      expect((yield* coordinator.view).visible.count).toBe(0);
      yield* Queue.offer(autonomous, {
        count: 99,
        serverOnly: "private:remote:99",
        publicToken: "opaque:private:remote:99",
      });
      yield* yieldFibers;
      const held = yield* coordinator.view;
      expect(held.visible.count).toBe(0);
      expect(held.held?.state.count).toBe(99);
      yield* Deferred.succeed(holdB, void 0);
      yield* yieldFibers;
      const settled = yield* command(coordinator, submitted.commandId);
      expect(settled.phase).toBe("applied");
      expect(settled.exact?.revision).toBe(1);
      expect((yield* coordinator.view).base.revision).toBe(2);
      expect((yield* coordinator.view).visible.count).toBe(99);
    }),
  );

  withStore("autonomous and late public receipts keep the newest base", () =>
    Effect.gen(function* () {
      const autonomous = yield* Queue.unbounded<ServerState>();
      const harness = yield* makeHarness(gatedBehavior(undefined, autonomous));
      const holdA = yield* Deferred.make<void>();
      const coordinator = yield* makeClient(harness);
      const a = yield* coordinator.submitGenerated(add("A"), (state) => ({
        ...state,
        count: state.count + 1,
      }));
      harness.controls.calls.set(a.commandId, { hold: holdA });
      yield* yieldFibers;
      expect((yield* coordinator.view).held?.revision).toBe(1);
      yield* Queue.offer(autonomous, {
        count: 10,
        serverOnly: "private:autonomous:10",
        publicToken: "opaque:private:autonomous:10",
      });
      yield* yieldFibers;
      expect((yield* coordinator.view).held?.revision).toBe(2);
      expect((yield* coordinator.view).held?.state.count).toBe(10);
      yield* Deferred.succeed(holdA, void 0);
      yield* yieldFibers;
      const aCommand = yield* command(coordinator, a.commandId);
      expect(aCommand.phase).toBe("applied");
      expect(aCommand.exact?.revision).toBe(1);
      expect((yield* coordinator.view).base.revision).toBe(2);
      expect((yield* coordinator.view).visible).toEqual({
        count: 10,
        publicToken: "opaque:private:autonomous:10",
      });
    }),
  );

  withStore("an actual other-client command stays newer than a late receipt", () =>
    Effect.gen(function* () {
      const callA = yield* Deferred.make<void>();
      const harness = yield* makeHarness(gatedBehavior(undefined, undefined));
      const coordinator = yield* makeClient(harness);
      const a = yield* coordinator.submitGenerated(add("A"), (state) => ({
        ...state,
        count: state.count + 1,
      }));
      harness.controls.calls.set(a.commandId, { hold: callA });
      yield* yieldFibers;
      const remote = yield* harness.real.call(
        harness.address,
        id("remote"),
        encodedAdd("remote", 10),
        "1 second",
        [],
      );
      yield* yieldFibers;
      expect((yield* command(coordinator, a.commandId)).phase).toBe("pending");
      expect((yield* coordinator.view).visible.count).toBe(1);
      expect((yield* coordinator.view).held?.revision).toBe(2);

      yield* Deferred.succeed(callA, void 0);
      yield* yieldFibers;
      const aCommand = yield* command(coordinator, a.commandId);
      expect(aCommand.phase).toBe("applied");
      expect(aCommand.exact?.revision).toBe(1);
      expect((yield* coordinator.view).base).toEqual(decodePublicProjection(remote.projection));
      expect((yield* coordinator.view).visible.count).toBe(11);
    }),
  );

  withStore("a settled public command keeps its overlay until its stream base arrives", () =>
    Effect.gen(function* () {
      const serverB = yield* Deferred.make<void>();
      const sendB = yield* Deferred.make<void>();
      const callA = yield* Deferred.make<void>();
      const callB = yield* Deferred.make<void>();
      const harness = yield* makeHarness(gatedBehavior(serverB, undefined));
      harness.controls.defaultCallHold = callA;
      harness.controls.sends.set("B", { hold: sendB });
      harness.controls.calls.set("B", { hold: callB });
      const coordinator = yield* makeClient(harness);
      const a = yield* coordinator.submitGenerated(add("A"), (state) => ({
        ...state,
        count: state.count + 1,
      }));
      yield* yieldFibers;
      const b = yield* coordinator.submitSupplied(id("B"), add("B"), (state) => ({
        ...state,
        count: state.count + 1,
      }));
      yield* yieldFibers;
      expect((yield* command(coordinator, b.commandId)).admitted).toBeUndefined();

      harness.controls.defaultCallHold = undefined;
      yield* Deferred.succeed(callA, void 0);
      yield* yieldFibers;
      const aCommand = yield* command(coordinator, a.commandId);
      expect(aCommand.phase).toBe("applied");
      expect(aCommand.exact?.revision).toBe(1);
      expect((yield* coordinator.view).base.revision).toBe(0);
      expect((yield* coordinator.view).visible.count).toBe(1);
      expect((yield* coordinator.view).held?.revision).toBe(1);

      yield* Deferred.succeed(serverB, void 0);
      yield* Deferred.succeed(sendB, void 0);
      yield* yieldFibers;
      expect((yield* coordinator.view).held?.revision).toBe(2);
      yield* Deferred.succeed(callB, void 0);
      yield* yieldFibers;
      const bCommand = yield* command(coordinator, b.commandId);
      expect(bCommand.phase).toBe("applied");
      expect(bCommand.exact?.revision).toBe(2);
      expect((yield* coordinator.view).base.revision).toBe(2);
      expect((yield* coordinator.view).visible.count).toBe(2);
    }),
  );

  withStore(
    "the coordinator stops at attempt eight despite a busy stream and retries exact bytes",
    () =>
      Effect.gen(function* () {
        const autonomous = yield* Queue.unbounded<ServerState>();
        const harness = yield* makeHarness(gatedBehavior(undefined, autonomous));
        let encoded = 0;
        const coordinator = yield* makeCoordinator({
          transport: harness.wrapped,
          address: harness.address,
          encode: (message: Add) => {
            encoded += 1;
            return Effect.orDie(
              Schema.encodeEffect(Counter.message)({
                ...message,
                label: `A:${encoded}`,
              }),
            );
          },
          decode: (projection: Projection) => Effect.sync(() => decodePublicProjection(projection)),
          timeout: "1 second",
          retryDelay: "1 second",
          maxAttempts: 8,
        });
        const commandId = id("A");
        harness.controls.sends.set("A", { drop: true });
        const submitted = yield* coordinator.submitSupplied(commandId, add("A"), (state) => ({
          ...state,
          count: state.count + 1,
        }));
        const payload = submitted.payload;
        yield* yieldFibers;
        for (let attempt = 1; attempt < 8; attempt += 1) {
          yield* Queue.offer(autonomous, {
            count: 100 + attempt,
            serverOnly: `private:${attempt}`,
            publicToken: `public:${attempt}`,
          });
          yield* TestClock.adjust("1 second");
          yield* yieldFibers;
        }
        const exhausted = yield* command(coordinator, commandId);
        expect(exhausted.attempts).toBe(8);
        expect(exhausted.phase).toBe("uncertain");
        const priorChanges = harness.changeRevisions.length;
        for (let state = 8; state < 12; state += 1) {
          yield* Queue.offer(autonomous, {
            count: 100 + state,
            serverOnly: `private:${state}`,
            publicToken: `public:${state}`,
          });
          yield* TestClock.adjust("10 seconds");
          yield* yieldFibers;
        }
        expect(harness.changeRevisions.length).toBeGreaterThan(priorChanges);
        expect(harness.sendCalls).toHaveLength(8);
        expect(harness.callCalls).toHaveLength(0);
        expect((yield* coordinator.workers).activeCommands).toBe(0);

        harness.controls.sends.set("A", {});
        yield* coordinator.retry(commandId);
        yield* yieldFibers;
        const retried = yield* command(coordinator, commandId);
        expect(retried.phase).toBe("applied");
        expect(retried.attempts).toBe(1);
        expect(harness.sendCalls).toHaveLength(9);
        expect(harness.callCalls).toHaveLength(1);
        expect(encoded).toBe(1);
        expect(
          [...harness.sendCalls, ...harness.callCalls].every(
            (call) => call.commandId === "A" && call.payload === payload,
          ),
        ).toBe(true);
      }),
  );

  withStore("a supplied ID waits for real evidence and never predicts a prior commit", () =>
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
      const coordinator = yield* makeClient(harness);
      expect((yield* coordinator.view).visible).toEqual(
        decodePublicProjection(first.projection).state,
      );
      const submitted = yield* coordinator.submitSupplied(id("supplied"), add("A"), (state) => ({
        ...state,
        count: state.count + 1,
      }));
      expect(submitted.identity).toBe("supplied");
      expect((yield* coordinator.view).visible.count).toBe(1);
      yield* yieldFibers;
      expect((yield* coordinator.view).visible.count).toBe(1);
      const settled = yield* command(coordinator, id("supplied"));
      expect(settled.phase).toBe("applied");
      expect(settled.exact?.state.count).toBe(1);
      expect(harness.sendCalls).toHaveLength(1);
      expect(harness.sendCalls[0]?.payload).toBe(payload);
      expect(predictionPolicy("supplied")).toBe("await-receipt");
      expect(predictionPolicy("generated")).toBe("predict-immediately");
      const privateState = yield* decodePrivateReceipt(harness, "supplied");
      expect(privateState.receipt.revision).toBe(1);
    }),
  );

  withStore("closing the coordinator scope stops stream and command workers", () =>
    Effect.gen(function* () {
      const holdB = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const behavior: Behavior<ServerState, Add, Crypto.Crypto> = {
        initial: { count: 0, serverOnly: "private:initial", publicToken: "public:initial" },
        open: () =>
          Effect.gen(function* () {
            const crypto = yield* Crypto.Crypto;
            return {
              apply: (state, message) =>
                Effect.gen(function* () {
                  if (message.label === "B") {
                    yield* Deferred.succeed(started, void 0);
                    yield* Deferred.await(holdB);
                  }
                  const count = state.count + message.amount;
                  const serverOnly = `private:${message.label}:${count}`;
                  return { count, serverOnly, publicToken: yield* opaqueToken(crypto) };
                }),
              changes: Stream.empty,
            };
          }),
      };
      const store = yield* MailboxStore;
      const serverScope = yield* Scope.make();
      const implementation = implement(Counter, {
        behavior,
        state: stateCodec,
        snapshot: (state) => ({ count: state.count, publicToken: state.publicToken }),
      });
      const real = yield* ActorHost.make({
        implementations: [implementation],
        store: () => Layer.succeed(MailboxStore, store),
      }).pipe(Scope.provide(serverScope));
      const harness: Harness = {
        store,
        real,
        wrapped: real,
        controls: {
          sends: new Map(),
          calls: new Map(),
          changes: new Map(),
          defaultSendHold: undefined,
          defaultCallHold: undefined,
        },
        address: { contract: Counter.name, version: Counter.version, key: encodedKey },
        sendCalls: [],
        callCalls: [],
        changeRevisions: [],
      };
      const clientScope = yield* Scope.make();
      const coordinator = yield* makeClient(harness).pipe(Scope.provide(clientScope));
      const submitted = yield* coordinator.submitGenerated(add("B"), (state) => ({
        ...state,
        count: state.count + 1,
      }));
      yield* Deferred.await(started);
      yield* yieldFibers;
      const before = yield* coordinator.workers;
      expect(before.activeStream).toBe(1);
      expect(before.activeCommands).toBe(1);
      yield* Scope.close(clientScope, Exit.void);
      yield* yieldFibers;
      const after = yield* coordinator.workers;
      expect(after.activeStream).toBe(0);
      expect(after.activeCommands).toBe(0);
      expect(after.streamStops).toBe(1);
      expect(after.commandStops).toBe(1);
      expect(yield* store.pending).toEqual([submitted.commandId]);
      yield* Deferred.succeed(holdB, void 0);
      const receipt = yield* Effect.repeat(store.receipt(submitted.commandId), {
        until: Option.isSome,
      });
      expect(Option.getOrThrow(receipt).revision).toBe(1);
      yield* Scope.close(serverScope, Exit.void);
    }),
  );

  withStore("a refusal after a lost possible admission remains uncertain", () =>
    Effect.gen(function* () {
      const allowed = yield* Ref.make(true);
      const lostReply = yield* Deferred.make<void>();
      const authorizer: AuthorizerService = {
        authorize: (address) =>
          Effect.flatMap(Ref.get(allowed), (isAllowed) => {
            if (isAllowed) return Effect.void;
            return Unauthorized.make({ contract: address.contract });
          }),
      };
      const harness = yield* makeHarness(gatedBehavior(undefined, undefined), authorizer);
      harness.controls.sends.set("A", {
        drop: true,
        afterCommit: Effect.gen(function* () {
          yield* Effect.repeat(harness.store.receipt(id("A")), { until: Option.isSome });
          yield* Ref.set(allowed, false);
          yield* Deferred.succeed(lostReply, void 0);
        }),
      });
      const coordinator = yield* makeClient(harness);
      yield* coordinator.submitSupplied(id("A"), add("A"), (state) => ({
        ...state,
        count: state.count + 1,
      }));
      yield* Deferred.await(lostReply);
      yield* TestClock.adjust("1 second");
      yield* yieldFibers;
      const uncertain = yield* command(coordinator, id("A"));
      expect(uncertain.phase).toBe("uncertain");
      expect(uncertain.possibleAdmission).toBe(true);
      expect(classifyRefusalAfterPossibleAdmission(uncertain.possibleAdmission)).toBe("uncertain");
      expect(harness.sendCalls).toHaveLength(2);
      expect(harness.callCalls).toHaveLength(0);
      expect((yield* storedReceipt(harness, "A")).revision).toBe(1);
    }),
  );
});
