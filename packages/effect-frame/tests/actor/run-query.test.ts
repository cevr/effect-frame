import {
  Policies,
  Policy,
  QueryCache,
  implementQuery,
  query,
  runQuery,
  ActorHost,
} from "effect-frame/actor";
import { Effect, Exit, Layer, Schema } from "effect";
import { describe, expect, it } from "effect-bun-test";

/**
 * `runQuery` (#23 §1.1): one read of a query, as a value. A prerender
 * route's `inputs` read the list its pages come from with it, so a failed
 * read must fail the enumeration instead of listing no pages.
 */

const policies = Layer.succeed(Policies, Policies.of({ public: Policy.allowAll }));

const Titles = query("RunQueryTitles", {
  version: 1,
  policy: "public",
  args: Schema.Struct({ prefix: Schema.String }),
  result: Schema.Array(Schema.String),
  depends: [],
});

const Broken = query("RunQueryBroken", {
  version: 1,
  policy: "public",
  args: Schema.Struct({}),
  result: Schema.String,
  depends: [],
});

let titleReads = 0;

const layer = Layer.merge(
  QueryCache.layer,
  ActorHost.layer({
    implementations: [],
    queries: [
      implementQuery(Titles, {
        run: (args) =>
          Effect.sync(() => {
            titleReads += 1;
            return [`${args.prefix}-a`, `${args.prefix}-b`];
          }),
      }),
      implementQuery(Broken, { run: () => Effect.fail("the store is down") }),
    ],
    store: ActorHost.memoryStore,
  }),
).pipe(Layer.provide(policies));

describe("runQuery (#23 §1.1)", () => {
  it.scoped.layer(layer)("reads the value once and lets the key go", () =>
    Effect.gen(function* () {
      titleReads = 0;
      const titles = yield* runQuery(Titles, { prefix: "post" });
      expect(titles).toEqual(["post-a", "post-b"]);
      expect(titleReads).toBe(1);
      // The declaration lasted for the read only: nothing stays active.
      expect(yield* (yield* QueryCache).active).toEqual([]);
    }),
  );

  it.scoped.layer(layer)("a failed read fails with its QueryFailure", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(runQuery(Broken, {}));
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.findErrorOption(exit);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value._tag).toBe("QueryFailed");
      }
    }),
  );
});
