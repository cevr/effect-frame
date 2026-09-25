import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Schema,
  SchemaTransformation,
  Scope,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "effect-bun-test";
import {
  ActorHost,
  MailboxStore,
  Policies,
  Policy,
  contract,
  CommandId,
  committedRevision,
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
  policy: "public",
  key: Schema.String,
  snapshot: Schema.Finite,
  message: Add,
});

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

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
const policies = Layer.succeed(Policies, Policies.of({ public: Policy.allowAll }));
const hostedLayer = ActorHost.layer({
  implementations: [Hosted],
  store: ActorHost.memoryStore,
}).pipe(
  Layer.provide(Layer.succeed(HostValue, HostValue.of({ amount: 10 }))),
  Layer.provide(policies),
);
const concurrentLayer = ActorHost.layer({
  implementations: [Concurrent],
  store: ActorHost.memoryStore,
}).pipe(Layer.provide(policies));
const id = Schema.decodeSync(CommandId);
const localSpawnEffect = spawn(localBehavior);
const localSpawnRequirements: Equals<
  Effect.Services<typeof localSpawnEffect>,
  LocalValue | Scope.Scope
> = true;

const hostedNumberBehavior: Behavior<number, number> = {
  initial: 0,
  open: () =>
    Effect.succeed({
      apply: (state: number, amount: number) => Effect.succeed(state + amount),
      changes: Stream.empty,
    }),
};

const hostedNumberImplementation = (message: Schema.Codec<number, string>) =>
  implementTransparent(
    contract("HostedEncodingProof", {
      version: 1,
      policy: "public",
      key: Schema.String,
      snapshot: Schema.Finite,
      message,
    }),
    hostedNumberBehavior,
  );

const hostedPayload = '"1"';

describe("private actor engines", () => {
  it.scoped("preserves local behavior services inside the local engine", () =>
    Effect.gen(function* () {
      const actor = yield* localSpawnEffect.pipe(
        Effect.provideService(LocalValue, LocalValue.of({ amount: 4 })),
      );
      const applied = yield* actor.call({ _tag: "EngineAdd", amount: 3 });
      expect(applied).toEqual({ revision: committedRevision(1), state: 7 });
      expect(actor.kind).toBe("local");
      const localRef: LocalActorRef<number, Add> = actor;
      expect(localRef.derive).toBeDefined();
      expect(localSpawnRequirements).toBe(true);
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
      expect(applied).toEqual({ revision: committedRevision(1), state: 11 });
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

  it.scoped("bounds hosted message preparation by the call timeout", () =>
    Effect.gen(function* () {
      const encodingStarted = yield* Deferred.make<void>();
      const encodingRelease = yield* Deferred.make<void>();
      const encodingFinalized = yield* Deferred.make<void>();
      let encodes = 0;
      const message = Schema.String.pipe(
        Schema.decodeTo(
          Schema.Finite,
          SchemaTransformation.transformEffect({
            decode: (value: string) => Effect.succeed(Number(value)),
            encode: (value: number) =>
              Effect.ensuring(
                Effect.gen(function* () {
                  encodes += 1;
                  yield* Deferred.succeed(encodingStarted, void 0);
                  yield* Deferred.await(encodingRelease);
                  return String(value);
                }),
                Deferred.succeed(encodingFinalized, void 0),
              ),
          }),
        ),
      );
      const lifetime = yield* Scope.make();
      yield* Effect.addFinalizer((exit) => Scope.close(lifetime, exit));
      const instance = yield* hostedNumberImplementation(message).open(
        MailboxStore.layerMemory,
        lifetime,
      );
      const waiting = yield* Effect.forkScoped(
        Effect.flip(instance.call(id("hosted-encoding-timeout"), hostedPayload, "10 millis")),
      );
      yield* Deferred.await(encodingStarted);
      yield* TestClock.adjust("10 millis");
      const failure = yield* Fiber.join(waiting);

      expect(failure._tag).toBe("Uncertain");
      expect(encodes).toBe(1);
      expect(yield* Deferred.isDone(encodingFinalized)).toBe(true);
    }),
  );

  it.scoped("stopped hosted send and call refuse before message encoding", () =>
    Effect.gen(function* () {
      let encodes = 0;
      const message = Schema.String.pipe(
        Schema.decodeTo(
          Schema.Finite,
          SchemaTransformation.transformEffect({
            decode: (value: string) => Effect.succeed(Number(value)),
            encode: (value: number) =>
              Effect.sync(() => {
                encodes += 1;
                return String(value);
              }),
          }),
        ),
      );
      const lifetime = yield* Scope.make();
      yield* Effect.addFinalizer((exit) => Scope.close(lifetime, exit));
      const instance = yield* hostedNumberImplementation(message).open(
        MailboxStore.layerMemory,
        lifetime,
      );
      yield* Scope.close(lifetime, Exit.void);

      const sendFailure = yield* Effect.flip(
        instance.send(id("hosted-stopped-send"), hostedPayload),
      );
      const callFailure = yield* Effect.flip(
        instance.call(id("hosted-stopped-call"), hostedPayload, "100 millis"),
      );

      expect(sendFailure._tag).toBe("ActorStopped");
      expect(callFailure._tag).toBe("ActorStopped");
      expect(encodes).toBe(0);
    }),
  );

  it.scoped("closing a hosted actor interrupts message preparation", () =>
    Effect.gen(function* () {
      const encodingStarted = yield* Deferred.make<void>();
      const encodingRelease = yield* Deferred.make<void>();
      const encodingFinalized = yield* Deferred.make<void>();
      let encodes = 0;
      const message = Schema.String.pipe(
        Schema.decodeTo(
          Schema.Finite,
          SchemaTransformation.transformEffect({
            decode: (value: string) => Effect.succeed(Number(value)),
            encode: (value: number) =>
              Effect.ensuring(
                Effect.gen(function* () {
                  encodes += 1;
                  yield* Deferred.succeed(encodingStarted, void 0);
                  yield* Deferred.await(encodingRelease);
                  return String(value);
                }),
                Deferred.succeed(encodingFinalized, void 0),
              ),
          }),
        ),
      );
      const lifetime = yield* Scope.make();
      yield* Effect.addFinalizer((exit) => Scope.close(lifetime, exit));
      const instance = yield* hostedNumberImplementation(message).open(
        MailboxStore.layerMemory,
        lifetime,
      );
      const waiting = yield* Effect.forkScoped(
        Effect.flip(instance.call(id("hosted-close-during-encode"), hostedPayload, "1 minute")),
      );
      yield* Deferred.await(encodingStarted);
      yield* Scope.close(lifetime, Exit.void);
      const failure = yield* Fiber.join(waiting);

      expect(failure._tag).toBe("ActorStopped");
      expect(encodes).toBe(1);
      expect(yield* Deferred.isDone(encodingFinalized)).toBe(true);
    }),
  );
});
