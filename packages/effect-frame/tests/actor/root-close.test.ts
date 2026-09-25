import { Deferred, Effect, Exit, Layer, Schema, Scope } from "effect";
import * as Frame from "../../src/frame.js";
import * as QueryTest from "../../src/actor/testing/query.js";
import { query } from "../../src/actor/query.js";
import { implementQuery } from "../../src/actor/query-host.js";
import { useQuery } from "../../src/actor/query-client.js";
import { Policies, Policy } from "../../src/actor/policy.js";
import { describe, expect, it } from "effect-bun-test";

const RootCloseQuery = query("InspectionRootCloseProbe", {
  version: 1,
  policy: "public",
  args: Schema.String,
  result: Schema.String,
  depends: [],
});

describe("QueryTest root ownership", () => {
  it.scoped("closes a blocked handler when its root closes while its consumer stays live", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let released = 0;
      const layer = QueryTest.layer({
        queries: [
          implementQuery(RootCloseQuery, {
            run: () =>
              Effect.gen(function* () {
                yield* Effect.addFinalizer<never>(() =>
                  Effect.sync(() => {
                    released += 1;
                  }),
                );
                yield* Deferred.succeed(started, void 0);
                return yield* Effect.never;
              }),
          }),
        ],
      }).pipe(
        Layer.provide(Layer.succeed(Policies, Policies.of({ public: Policy.allowAll }))),
        Layer.provideMerge(Frame.layer({ name: "root-close" })),
      );
      const root = yield* Scope.make();
      const consumer = yield* Scope.make();
      const context = yield* Scope.provide(Layer.build(layer), root);
      yield* Effect.provideContext(
        Scope.provide(useQuery(RootCloseQuery, "blocked"), consumer),
        context,
      );
      yield* Deferred.await(started);

      yield* Scope.close(root, Exit.void);
      expect(released).toBe(1);
      yield* Scope.close(consumer, Exit.void);
      expect(released).toBe(1);
    }),
  );
});
