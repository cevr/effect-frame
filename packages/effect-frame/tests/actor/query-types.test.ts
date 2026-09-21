import {
  ActorHost,
  ActorTransport,
  Behavior,
  Query,
  contract,
  implementQuery,
  implementTransparent,
  query,
} from "effect-frame/actor";
import { ref } from "effect-frame/actor/client";
import { Context, Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "effect-bun-test";

class ApplicationValue extends Context.Service<ApplicationValue, { readonly value: number }>()(
  "effect-frame/tests/actor/query-types.test/ApplicationValue",
) {}

const ProbeMessage = Schema.TaggedStruct("ProbeMessage", {});
type ProbeMessage = Schema.Schema.Type<typeof ProbeMessage>;

const Probe = contract("ApplicationServiceProbe", {
  version: 1,
  key: Schema.Struct({ id: Schema.Finite }),
  snapshot: Schema.Finite,
  message: Schema.Union([ProbeMessage]),
});

const ProbeLive = implementTransparent(
  Probe,
  Behavior.reducer<number, ProbeMessage>({
    initial: 7,
    reduce: (state) => state,
  }),
);

const Single = query("ApplicationServiceSingle", {
  args: Schema.Struct({}),
  result: Schema.Struct({ value: Schema.Finite }),
});

const Batched = query.batched("ApplicationServiceBatch", {
  args: Schema.Struct({ id: Schema.Finite }),
  result: Schema.Struct({ value: Schema.Finite }),
});

const ActorReading = query("ActorReading", {
  args: Schema.Struct({ id: Schema.Finite }),
  result: Schema.Finite,
});

const batchReleases = { current: 0 };

const SingleLive = implementQuery(Single, () =>
  Effect.map(Effect.service(ApplicationValue), (service) => ({ value: service.value })),
);

const BatchedLive = Query.batched(Batched, {
  resolve: () =>
    Effect.acquireRelease(
      Effect.map(
        Effect.service(ApplicationValue),
        (service) => (args: { readonly id: number }) =>
          Effect.succeed({ value: service.value + args.id }),
      ),
      () =>
        Effect.sync(() => {
          batchReleases.current += 1;
        }),
    ),
});

const ActorReadingLive = implementQuery(ActorReading, (args) =>
  Effect.gen(function* () {
    const actor = yield* ref(Probe, { id: args.id });
    return yield* actor.state.get;
  }),
);

const host = ActorHost.layerMemory([ProbeLive], [SingleLive, BatchedLive, ActorReadingLive]).pipe(
  Layer.provide(Layer.succeed(ApplicationValue, ApplicationValue.of({ value: 40 }))),
);

const hostWithoutApplicationValue = ActorHost.layerMemory([], [SingleLive]);
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** The missing service remains visible until the application provides it. */
const missingApplicationValueIsVisible: Equals<
  Layer.Services<typeof hostWithoutApplicationValue>,
  ApplicationValue
> = true;

/** Providing the service discharges only that application requirement. */
const hostRequirementsAreDischarged: Equals<Layer.Services<typeof host>, never> = true;

describe("query implementation service requirements", () => {
  it.scoped.layer(host)("preserves application services through ActorHost", () =>
    Effect.gen(function* () {
      const transport = yield* ActorTransport;
      expect(missingApplicationValueIsVisible).toBe(true);
      expect(hostRequirementsAreDischarged).toBe(true);
      batchReleases.current = 0;
      const single = yield* transport.query({ query: Single.name, version: 1, args: "{}" });
      expect(single).toBe('{"value":40}');
      const actorReading = yield* transport.query({
        query: ActorReading.name,
        version: 1,
        args: '{"id":1}',
      });
      expect(actorReading).toBe("7");
      const batch = yield* transport.queryBatch([
        { query: Batched.name, version: 1, args: '{"id":2}' },
      ]);
      expect(batch[0]?._tag).toBe("Refreshed");
      if (batch[0]?._tag === "Refreshed") {
        expect(batch[0].result).toBe('{"value":42}');
      }
      expect(batchReleases.current).toBe(1);
    }),
  );
});
