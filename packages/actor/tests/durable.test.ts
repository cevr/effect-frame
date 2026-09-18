import { Effect, Exit, Fiber, Hash, Option, Schema, Scope } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "effect-bun-test";
import { Behavior, CommandId, MailboxStore, durable } from "@effect-frame/actor";
import type { DurableOptions } from "@effect-frame/actor";

const Add = Schema.TaggedStruct("Add", { amount: Schema.Finite });
type Add = Schema.Schema.Type<typeof Add>;

const counterBehavior = Behavior.reducer<number, Add>({
  initial: 0,
  reduce: (state, message) => state + message.amount,
});

const counterOptions: DurableOptions<number, Add, never> = {
  behavior: counterBehavior,
  state: Schema.fromJsonString(Schema.Finite),
  message: Schema.fromJsonString(Add),
  pollInterval: "100 millis",
};

const slowBehavior: Behavior.Behavior<number, Add> = {
  initial: 0,
  open: () =>
    Effect.succeed({
      apply: (state, message) => Effect.sleep("1 hour").pipe(Effect.as(state + message.amount)),
    }),
};

const id = Schema.decodeSync(CommandId);
const add = (amount: number): Add => ({ _tag: "Add", amount });

const withStore = it.scoped.layer(MailboxStore.layerMemory);

describe("durable actor", () => {
  withStore("call commits the command and returns the applied revision", () =>
    Effect.gen(function* () {
      const counter = yield* durable(counterOptions);
      const applied = yield* counter.call(add(3), {
        commandId: id("c1"),
        timeout: "1 second",
      });
      expect(applied).toEqual({ revision: 1, state: 3 });
      expect(yield* counter.state.get).toBe(3);
    }),
  );

  withStore("the same command ID with the same payload applies once", () =>
    Effect.gen(function* () {
      const counter = yield* durable(counterOptions);
      const first = yield* counter.call(add(3), {
        commandId: id("c1"),
        timeout: "1 second",
      });
      const retry = yield* counter.call(add(3), {
        commandId: id("c1"),
        timeout: "1 second",
      });
      expect(retry).toEqual(first);
      const receipt = yield* counter.send(add(3), { commandId: id("c1") });
      expect(receipt.committed).toEqual(Option.some(1));
      expect(yield* counter.state.get).toBe(3);
    }),
  );

  withStore("the same command ID with a different payload is a conflict", () =>
    Effect.gen(function* () {
      const counter = yield* durable(counterOptions);
      yield* counter.call(add(3), { commandId: id("c1"), timeout: "1 second" });
      const failure = yield* Effect.flip(counter.send(add(4), { commandId: id("c1") }));
      expect(failure._tag).toBe("CommandConflict");
    }),
  );

  withStore("a restart restores the committed state and answers the retried command", () =>
    Effect.gen(function* () {
      const store = yield* MailboxStore;

      const firstLife = yield* Scope.make();
      const before = yield* durable(counterOptions).pipe(Scope.provide(firstLife));
      yield* before.send(add(3), { commandId: id("c1") });
      yield* Effect.repeat(store.receipt(id("c1")), { until: Option.isSome });
      yield* Scope.close(firstLife, Exit.void);

      const after = yield* durable(counterOptions);
      expect(yield* after.state.get).toBe(3);
      const retried = yield* after.call(add(3), {
        commandId: id("c1"),
        timeout: "1 second",
      });
      expect(retried).toEqual({ revision: 1, state: 3 });
      const next = yield* after.call(add(5), {
        commandId: id("c2"),
        timeout: "1 second",
      });
      expect(next).toEqual({ revision: 2, state: 8 });
    }),
  );

  withStore("a command accepted before a restart is processed on wake", () =>
    Effect.gen(function* () {
      const store = yield* MailboxStore;
      const payload = yield* Schema.encodeEffect(Schema.fromJsonString(Add))(add(7));
      yield* store.append({ commandId: id("c1"), payload, payloadHash: Hash.string(payload) });
      expect(yield* store.pending).toEqual([id("c1")]);

      const counter = yield* durable(counterOptions);
      const applied = yield* counter.call(add(7), {
        commandId: id("c1"),
        timeout: "1 second",
      });
      expect(applied).toEqual({ revision: 1, state: 7 });
      expect(yield* store.pending).toEqual([]);
    }),
  );

  withStore("a timed-out call is Uncertain and the command still commits", () =>
    Effect.gen(function* () {
      const counter = yield* durable({ ...counterOptions, behavior: slowBehavior });
      const waiting = yield* Effect.forkScoped(
        Effect.flip(counter.call(add(1), { commandId: id("c1"), timeout: "1 second" })),
      );
      yield* TestClock.adjust("1 second");
      const failure = yield* Fiber.join(waiting);
      expect(failure._tag).toBe("Uncertain");

      yield* TestClock.adjust("1 hour");
      const retried = yield* counter.call(add(1), {
        commandId: id("c1"),
        timeout: "1 second",
      });
      expect(retried).toEqual({ revision: 1, state: 1 });
    }),
  );

  withStore("closing the scope fails a waiting call with ActorStopped", () =>
    Effect.gen(function* () {
      const life = yield* Scope.make();
      const counter = yield* durable({ ...counterOptions, behavior: slowBehavior }).pipe(
        Scope.provide(life),
      );
      const waiting = yield* Effect.forkScoped(
        Effect.flip(counter.call(add(1), { commandId: id("c1"), timeout: "1 minute" })),
      );
      yield* TestClock.adjust("10 millis");
      yield* Scope.close(life, Exit.void);
      const failure = yield* Fiber.join(waiting);
      expect(failure._tag).toBe("ActorStopped");
    }),
  );
});
