import {
  ActorHost,
  ActorTransport,
  Behavior,
  Policies,
  Policy,
  Query,
  contract,
  implementQuery,
  implementTransparent,
  query,
} from "effect-frame/actor";
import { ref } from "effect-frame/actor/client";
import { QueryTest } from "effect-frame/actor/testing";
import { Dom, View } from "effect-frame/view";
import { Empty } from "effect-frame/view/jsx-runtime";
import { Context, Effect, Layer, Schema, type Scope } from "effect";
import { describe, expect, it } from "effect-bun-test";
import * as Frame from "../../src/frame.js";

class ApplicationValue extends Context.Service<ApplicationValue, { readonly value: number }>()(
  "effect-frame/tests/actor/query-types.test/ApplicationValue",
) {}

const ProbeMessage = Schema.TaggedStruct("ProbeMessage", {});
type ProbeMessage = Schema.Schema.Type<typeof ProbeMessage>;

const Probe = contract("ApplicationServiceProbe", {
  version: 1,
  policy: "public",
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
  version: 1,
  policy: "public",
  args: Schema.Struct({}),
  result: Schema.Struct({ value: Schema.Finite }),
  depends: [],
});

const Batched = query.batched("ApplicationServiceBatch", {
  version: 1,
  policy: "public",
  args: Schema.Struct({ id: Schema.Finite }),
  result: Schema.Struct({ value: Schema.Finite }),
  depends: [],
});

const ActorReading = query("ActorReading", {
  version: 1,
  policy: "public",
  args: Schema.Struct({ id: Schema.Finite }),
  result: Schema.Finite,
  depends: [],
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

const TestLayerQuery = implementQuery(Single, () =>
  Effect.map(Effect.service(ApplicationValue), (service) => ({ value: service.value })),
);

// @ts-expect-error A handler receives the contract's decoded argument shape.
implementQuery(Single, (args: { readonly wrong: string }) => Effect.succeed({ value: args.wrong }));

// @ts-expect-error A handler returns the contract's declared result shape.
implementQuery(Single, () => Effect.succeed({ value: "wrong" }));

const policies = Layer.succeed(Policies, Policies.of({ public: Policy.allowAll }));

const testLayerWithApplicationRequirement = QueryTest.layer({
  queries: [TestLayerQuery],
}).pipe(Layer.provide(policies));

const host = ActorHost.layer({
  implementations: [ProbeLive],
  queries: [SingleLive, BatchedLive, ActorReadingLive],
  store: ActorHost.memoryStore,
}).pipe(
  Layer.provide(Layer.succeed(ApplicationValue, ApplicationValue.of({ value: 40 }))),
  Layer.provide(policies),
);

const hostWithoutApplicationValue = ActorHost.layer({
  implementations: [],
  queries: [SingleLive],
  store: ActorHost.memoryStore,
}).pipe(Layer.provide(policies));

// Declarations the types refuse. Never run: each would fail at run time.
const refusedDeclarations = () => {
  // A host names its mailbox store: there is no in-memory default to lose
  // durability to.
  // @ts-expect-error `store` is required
  const hostWithoutStore = ActorHost.layer({ implementations: [ProbeLive] });

  // A query names its version and its dependencies: neither has a default.
  // @ts-expect-error `version` is required
  const withoutVersion = query("NoVersion", {
    args: Schema.String,
    result: Schema.String,
    policy: "public",
    depends: [],
  });
  // @ts-expect-error `depends` is required; `depends: []` is written on purpose
  const withoutDepends = query("NoDepends", {
    version: 1,
    args: Schema.String,
    result: Schema.String,
    policy: "public",
  });
  return [hostWithoutStore, withoutVersion, withoutDepends];
};
void refusedDeclarations;
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const viewWithApplicationChannels: View.View<
  Record<string, never>,
  "view-error",
  ApplicationValue
> = () => Effect.fail("view-error");

const viewWithFrameInspection: View.View<Record<string, never>, never, Frame.Service> = () =>
  Effect.map(Frame.Service, () => Empty);

const mountApplicationView = (root: Node) =>
  View.mount(viewWithApplicationChannels, {}, Dom.host, root);
const mountApplicationViewWithFrame = (root: Node) =>
  // @effect-diagnostics-next-line strictEffectProvide:off -- type proof for optional inspection
  Effect.provide(mountApplicationView(root), Frame.layer());
const mountFrameView = (root: Node) => View.mount(viewWithFrameInspection, {}, Dom.host, root);
const mountFrameViewWithLayer = (root: Node) =>
  // @effect-diagnostics-next-line strictEffectProvide:off -- type proof for the public mount channel
  Effect.provide(mountFrameView(root), Frame.layer());

/** `mount` preserves the view's error and service channels. */
const mountedApplicationEffect: Equals<
  ReturnType<typeof mountApplicationView>,
  Effect.Effect<void, "view-error", ApplicationValue | Scope.Scope>
> = true;
const mountedApplicationEffectWithFrame: Equals<
  ReturnType<typeof mountApplicationViewWithFrame>,
  Effect.Effect<void, "view-error", ApplicationValue | Scope.Scope>
> = true;
const mountedFrameEffect: Equals<
  ReturnType<typeof mountFrameView>,
  Effect.Effect<void, never, Frame.Service | Scope.Scope>
> = true;
const mountedFrameEffectWithInspection: Equals<
  ReturnType<typeof mountFrameViewWithLayer>,
  Effect.Effect<void, never, Scope.Scope>
> = true;

/** View effects keep both application failures and services visible at their call site. */
const viewErrorIsPreserved: Equals<
  Effect.Error<ReturnType<typeof viewWithApplicationChannels>>,
  "view-error"
> = true;
const viewRequirementsArePreserved: Equals<
  Effect.Services<ReturnType<typeof viewWithApplicationChannels>>,
  ApplicationValue
> = true;

/** Frame inspection requires only its public Frame service. */
const inspectionRequirementsArePreserved: Equals<
  Effect.Services<typeof Frame.inspect>,
  Frame.Service
> = true;

/** The missing service remains visible until the application provides it. */
const missingApplicationValueIsVisible: Equals<
  Layer.Services<typeof hostWithoutApplicationValue>,
  ApplicationValue
> = true;

/** Providing the service discharges only that application requirement. */
const hostRequirementsAreDischarged: Equals<Layer.Services<typeof host>, never> = true;

const queryTestRequirementsArePreserved: Equals<
  Layer.Services<typeof testLayerWithApplicationRequirement>,
  ApplicationValue
> = true;

describe("query implementation service requirements", () => {
  it.scoped.layer(host)("preserves application services through ActorHost", () =>
    Effect.gen(function* () {
      const transport = yield* ActorTransport;
      expect(missingApplicationValueIsVisible).toBe(true);
      expect(hostRequirementsAreDischarged).toBe(true);
      expect(queryTestRequirementsArePreserved).toBe(true);
      expect(viewErrorIsPreserved).toBe(true);
      expect(viewRequirementsArePreserved).toBe(true);
      expect(mountedApplicationEffect).toBe(true);
      expect(mountedApplicationEffectWithFrame).toBe(true);
      expect(mountedFrameEffect).toBe(true);
      expect(mountedFrameEffectWithInspection).toBe(true);
      expect(inspectionRequirementsArePreserved).toBe(true);
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
