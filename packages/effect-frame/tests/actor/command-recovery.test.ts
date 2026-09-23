import { Context, Effect, Exit, Layer, Option, Ref, Schema, Scope, Stream } from "effect";
import { describe, expect, it } from "effect-bun-test";
import {
  ActorHost,
  MailboxStore,
  Policies,
  Policy,
  implementTransparent,
} from "effect-frame/actor";
import { ActorTransport, committedRevision, contract, ref } from "effect-frame/actor/client";
import type { TransportService } from "effect-frame/actor/client";
import { CommandPolicy } from "../../src/actor/command-owner.js";

/**
 * A host closes while a command it admitted is still pending. The row lives
 * in the store, not in the host. A second host over the same store drains
 * it. The client keeps one command record across both hosts: a stopped host
 * after possible admission is uncertainty, never a refusal.
 */
const Counter = contract("RecoveredCounter", {
  version: 1,
  policy: "public",
  key: Schema.String,
  snapshot: Schema.Finite,
  message: Schema.Finite,
});

let life = 1;
let applies = 0;

/** The first host never finishes a turn. The second host applies at once. */
const CounterLive = implementTransparent(Counter, {
  initial: 0,
  open: () =>
    Effect.succeed({
      apply: (state: number, amount: number) =>
        Effect.suspend(() => {
          if (life === 1) {
            return Effect.never;
          }
          applies += 1;
          return Effect.succeed(state + amount);
        }),
      changes: Stream.empty,
    }),
});

const hostOver = (store: Context.Context<MailboxStore>) =>
  ActorHost.make({
    implementations: [CounterLive],
    store: () => Layer.succeedContext(store),
  }).pipe(Effect.provideService(Policies, { public: Policy.allowAll }));

describe("process recovery", () => {
  it.scopedLive("a pending command survives its host and settles once on the next host", () =>
    Effect.gen(function* () {
      life = 1;
      applies = 0;
      const store = yield* Layer.build(MailboxStore.layerMemory);
      const firstLife = yield* Scope.make();
      const first = yield* hostOver(store).pipe(Scope.provide(firstLife));
      const current = yield* Ref.make<TransportService>(first);
      const through = <A, E>(use: (transport: TransportService) => Effect.Effect<A, E>) =>
        Effect.flatMap(Ref.get(current), use);
      // The client's one transport. Swapping its target is the process
      // restart; the reference and its command record stay.
      const swappable: TransportService = {
        send: (...args) => through((transport) => transport.send(...args)),
        call: (...args) => through((transport) => transport.call(...args)),
        snapshot: (...args) => through((transport) => transport.snapshot(...args)),
        query: (...args) => through((transport) => transport.query(...args)),
        queryBatch: (...args) => through((transport) => transport.queryBatch(...args)),
        changes: (address, after) =>
          Stream.unwrap(Effect.map(Ref.get(current), (target) => target.changes(address, after))),
      };

      const counter = yield* ref(Counter, "one").pipe(
        Effect.provideService(ActorTransport, swappable),
        Effect.provideService(CommandPolicy, {
          passes: 8,
          passDeadline: "150 millis",
          baseDelay: "20 millis",
          maxDelay: "50 millis",
        }),
      );
      const command = yield* counter.send(1);
      const admittedPass = yield* Effect.map(
        Stream.runHead(
          Stream.filter(
            command.state.changes,
            (state) => state._tag === "Uncertain" && Option.isSome(state.admitted),
          ),
        ),
        Option.getOrThrow,
      );
      const storeService = Context.get(store, MailboxStore);
      expect(yield* storeService.pending).toEqual([command.commandId]);

      // The first host goes away with the row still pending. A pass against
      // the stopped host stays Uncertain: the row can still commit.
      yield* Scope.close(firstLife, Exit.void);
      const afterStop = yield* Effect.map(
        Stream.runHead(
          Stream.filter(
            command.state.changes,
            (state) =>
              state._tag === "Uncertain" &&
              admittedPass._tag === "Uncertain" &&
              state.attempt > admittedPass.attempt,
          ),
        ),
        Option.getOrThrow,
      );
      expect(afterStop._tag).toBe("Uncertain");
      life = 2;
      const second = yield* hostOver(store);
      yield* Ref.set(current, second);

      const settled = yield* command.settled;
      expect(settled).toEqual({
        _tag: "Applied",
        admitted: 1,
        revision: committedRevision(1),
        state: 1,
      });
      expect(applies).toBe(1);
      expect(yield* storeService.pending).toEqual([]);
    }),
  );
});
