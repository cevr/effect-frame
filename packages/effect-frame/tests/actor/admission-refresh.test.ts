import { Context, Deferred, Effect, Layer, Option, Ref, Schema, Stream } from "effect";
import { describe, expect, it } from "effect-bun-test";
import {
  ActorHost,
  CommandId,
  MailboxStore,
  Policies,
  Policy,
  implementQuery,
  implementTransparent,
} from "effect-frame/actor";
import {
  ActorTransport,
  QueryCache,
  committedRevision,
  contract,
  query,
  ref,
  useQuery,
} from "effect-frame/actor/client";
import type { QueryEntry } from "effect-frame/actor/client";

const HeldCounter = contract("AdmissionRefreshHeldCounter", {
  version: 1,
  policy: "public",
  key: Schema.String,
  snapshot: Schema.Finite,
  message: Schema.Finite,
});

const CounterValue = query("AdmissionRefreshCounterValue", {
  policy: "public",
  args: Schema.String,
  result: Schema.Finite,
  depends: [HeldCounter],
});

class AdmissionControl extends Context.Service<
  AdmissionControl,
  {
    readonly started: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
    readonly queryReads: Ref.Ref<number>;
  }
>()("effect-frame/tests/actor/admission-refresh.test/AdmissionControl") {}

const admissionControlLayer = Layer.effect(
  AdmissionControl,
  Effect.gen(function* () {
    return AdmissionControl.of({
      started: yield* Deferred.make<void>(),
      release: yield* Deferred.make<void>(),
      queryReads: yield* Ref.make(0),
    });
  }),
);

const heldBehavior = {
  initial: 0,
  open: () =>
    Effect.gen(function* () {
      const control = yield* AdmissionControl;
      return {
        apply: (state: number, amount: number) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(control.started, void 0);
            yield* Deferred.await(control.release);
            return state + amount;
          }),
        changes: Stream.empty,
      };
    }),
};

const HeldCounterLive = implementTransparent(HeldCounter, heldBehavior);

const id = Schema.decodeSync(CommandId);
const address = {
  contract: HeldCounter.name,
  version: HeldCounter.version,
  key: '"one"',
};

const CounterValueLive = implementQuery(CounterValue, () =>
  Effect.gen(function* () {
    const control = yield* AdmissionControl;
    yield* Ref.update(control.queryReads, (reads) => reads + 1);
    const transport = yield* ActorTransport;
    const projection = yield* transport.snapshot(address);
    return yield* Schema.decodeEffect(HeldCounter.snapshot)(projection.snapshot);
  }),
);

const appLayer = QueryCache.layerTest(
  ActorHost.make({
    implementations: [HeldCounterLive],
    store: () => MailboxStore.layerMemory,
    queries: [CounterValueLive],
  }),
).pipe(
  Layer.provide(Layer.succeed(Policies, Policies.of({ public: Policy.allowAll }))),
  Layer.provideMerge(admissionControlLayer),
);

const withHost = it.scoped.layer(appLayer);

const settled = <A, E>(entry: QueryEntry<A, E>) =>
  entry.state.changes.pipe(
    Stream.filter((state) => state._tag !== "Loading"),
    Stream.take(1),
    Stream.runDrain,
  );

describe("ActorHost command admission refresh", () => {
  withHost("does not refresh dependent queries before application commits", () =>
    Effect.gen(function* () {
      const control = yield* AdmissionControl;
      const value = yield* useQuery(CounterValue, "one");
      yield* settled(value);
      expect(yield* value.state.get).toEqual({
        _tag: "Ready",
        value: 0,
        stale: false,
      });
      expect(yield* Ref.get(control.queryReads)).toBe(1);

      const counter = yield* ref(HeldCounter, "one");
      const commandId = id("held-before-commit");
      const handle = yield* counter.send(1, { commandId });
      yield* Deferred.await(control.started);
      const admitted = yield* Stream.runHead(
        Stream.filter(handle.state.changes, (state) => state._tag === "Admitted"),
      );

      expect(handle.commandId).toBe(commandId);
      expect(admitted).toEqual(Option.some({ _tag: "Admitted", admitted: 1 }));
      expect(yield* counter.state.get).toBe(0);
      expect(yield* value.state.get).toEqual({
        _tag: "Ready",
        value: 0,
        stale: true,
      });
      expect(yield* Ref.get(control.queryReads)).toBe(1);

      yield* Deferred.succeed(control.release, void 0);
      const applied = yield* counter.call(1, { commandId, timeout: "1 second" });
      expect(applied).toEqual({ revision: committedRevision(1), state: 1 });
      expect(yield* counter.state.get).toBe(1);
      expect(yield* value.state.get).toEqual({
        _tag: "Ready",
        value: 1,
        stale: false,
      });
      expect(yield* Ref.get(control.queryReads)).toBe(2);

      expect(yield* handle.settled).toEqual({
        _tag: "Applied",
        admitted: 1,
        revision: committedRevision(1),
        state: 1,
      });

      const duplicate = yield* counter.send(1, { commandId });
      expect(yield* duplicate.settled).toEqual({
        _tag: "Applied",
        admitted: 1,
        revision: committedRevision(1),
        state: 1,
      });
      expect(yield* counter.state.get).toBe(1);
      expect(yield* value.state.get).toEqual({
        _tag: "Ready",
        value: 1,
        stale: false,
      });
      expect(yield* Ref.get(control.queryReads)).toBe(3);
    }),
  );
});
