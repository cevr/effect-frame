import { Context, Effect, Layer, Schema, Stream } from "effect";
import { describe, expect, it } from "effect-bun-test";
import {
  ActorHost,
  contract,
  CommandId,
  implementTransparent,
  ref,
  spawn,
} from "effect-frame/actor";
import type { LocalActorRef } from "effect-frame/actor";
import type { Behavior } from "../../src/actor/behavior.js";

const Add = Schema.TaggedStruct("EngineAdd", { amount: Schema.Finite });
type Add = Schema.Schema.Type<typeof Add>;

class LocalValue extends Context.Service<LocalValue, { readonly amount: number }>()(
  "effect-frame/tests/actor/engine.test/LocalValue",
) {}

class HostValue extends Context.Service<HostValue, { readonly amount: number }>()(
  "effect-frame/tests/actor/engine.test/HostValue",
) {}

const Counter = contract("EngineCounter", {
  version: 1,
  key: Schema.String,
  snapshot: Schema.Finite,
  message: Add,
});

const localBehavior: Behavior<number, Add, LocalValue> = {
  initial: 0,
  open: () =>
    Effect.map(Effect.service(LocalValue), (service) => ({
      apply: (state, message) => Effect.succeed(state + message.amount + service.amount),
      changes: Stream.empty,
    })),
};

const hostedBehavior: Behavior<number, Add, HostValue> = {
  initial: 0,
  open: () =>
    Effect.map(Effect.service(HostValue), (service) => ({
      apply: (state, message) => Effect.succeed(state + message.amount + service.amount),
      changes: Stream.empty,
    })),
};

let opens = 0;
const concurrentBehavior: Behavior<number, Add> = {
  initial: 0,
  open: () =>
    Effect.sync(() => {
      opens += 1;
      return {
        apply: (state: number, message: Add) => Effect.succeed(state + message.amount),
        changes: Stream.empty,
      };
    }),
};

const Hosted = implementTransparent(Counter, hostedBehavior);
const Concurrent = implementTransparent(Counter, concurrentBehavior);
const hostedLayer = ActorHost.layerMemory([Hosted]).pipe(
  Layer.provide(Layer.succeed(HostValue, HostValue.of({ amount: 10 }))),
);
const concurrentLayer = ActorHost.layerMemory([Concurrent]);
const id = Schema.decodeSync(CommandId);

describe("private actor engines", () => {
  it.scoped("preserves local behavior services inside the local engine", () =>
    Effect.gen(function* () {
      const actor = yield* spawn(localBehavior).pipe(
        Effect.provideService(LocalValue, LocalValue.of({ amount: 4 })),
      );
      const applied = yield* actor.call({ _tag: "EngineAdd", amount: 3 });
      expect(applied).toEqual({ revision: 1, state: 7 });
      expect(actor.kind).toBe("local");
      const localRef: LocalActorRef<number, Add> = actor;
      expect(localRef.derive).toBeDefined();
    }),
  );

  it.scoped.layer(hostedLayer)("uses host construction services for hosted behavior", () =>
    Effect.gen(function* () {
      const run = Effect.gen(function* () {
        const actor = yield* ref(Counter, "same");
        return yield* actor.call(
          { _tag: "EngineAdd", amount: 1 },
          { commandId: id("host-context"), timeout: "1 second" },
        );
      });
      const applied = yield* run.pipe(
        Effect.provideService(HostValue, HostValue.of({ amount: 100 })),
      );
      expect(applied).toEqual({ revision: 1, state: 11 });
    }),
  );

  it.scoped.layer(concurrentLayer)("opens one hosted engine for concurrent requests", () =>
    Effect.gen(function* () {
      opens = 0;
      const actors = yield* Effect.all(
        [ref(Counter, "concurrent"), ref(Counter, "concurrent"), ref(Counter, "concurrent")],
        { concurrency: 3 },
      );
      expect(opens).toBe(1);
      const applied = yield* Effect.all(
        actors.map((actor, index) =>
          actor.call(
            { _tag: "EngineAdd", amount: index + 1 },
            { commandId: id(`concurrent-${index}`), timeout: "1 second" },
          ),
        ),
        { concurrency: 3 },
      );
      const states = new Set(applied.map((value) => value.state));
      expect(states.size).toBe(3);
      expect(states).toContain(6);
      expect(yield* actors[0].state.get).toBe(6);
    }),
  );
});
