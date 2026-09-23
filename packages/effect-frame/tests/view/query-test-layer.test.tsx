import { registerDom } from "./dom-setup.js";

registerDom();

import {
  Behavior,
  CommandId,
  QueryCache,
  Query as HostQuery,
  contract,
  implementQuery,
  implementTransparent,
  query,
  ref,
  useQuery,
  Policies,
  Policy,
} from "effect-frame/actor";
import type { QueryEntry, QueryFailure, QueryState, Source } from "effect-frame/actor";
import { QueryTest } from "effect-frame/actor/testing";
import { Dom, Loading, Query, View, ViewTest, mount, readyWithStale } from "effect-frame/view";
import { Deferred, Effect, Layer, Exit, Fiber, Option, Schema, Scope, Stream } from "effect";
import { describe, expect, it } from "effect-bun-test";

/** The one policy table: every contract and query here declares `public`. */
const policies = Layer.succeed(Policies, Policies.of({ public: Policy.allowAll }));

const Increment = Schema.TaggedStruct("Increment", { amount: Schema.Finite });
type Increment = Schema.Schema.Type<typeof Increment>;

const Counter = contract("QueryTestCounter", {
  version: 1,
  policy: "public",
  key: Schema.Struct({ id: Schema.String }),
  snapshot: Schema.Finite,
  message: Schema.Union([Increment]),
});

const CounterLive = implementTransparent(
  Counter,
  Behavior.reducer<number, Increment>({
    initial: 0,
    reduce: (state, message) => state + message.amount,
  }),
);

const Count = query("QueryTestCount", {
  policy: "public",
  args: Schema.Struct({ id: Schema.String }),
  result: Schema.Struct({ count: Schema.Finite }),
  depends: [Counter],
});

const Rows = query.batched("QueryTestRows", {
  policy: "public",
  args: Schema.Struct({ id: Schema.Finite }),
  result: Schema.Struct({ id: Schema.Finite, value: Schema.String }),
});

const Failure = query("QueryTestFailure", {
  policy: "public",
  args: Schema.Struct({}),
  result: Schema.String,
});

interface CountControl {
  readonly gate: Deferred.Deferred<void>;
}

const countControl = { current: Option.none<CountControl>() };
let rowBatchGroups: ReadonlyArray<ReadonlyArray<number>> = [];

const testLayer = QueryTest.layer({
  queries: [
    implementQuery(Count, (args) =>
      Effect.gen(function* () {
        const counter = yield* ref(Counter, args);
        const state = yield* counter.state.get;
        const control = countControl.current;
        if (Option.isSome(control)) {
          yield* Deferred.await(control.value.gate);
        }
        return { count: state };
      }),
    ),
    HostQuery.batched(Rows, {
      resolve: (args) => {
        rowBatchGroups = [...rowBatchGroups, args.map((arg) => arg.id)];
        return Effect.succeed((arg: (typeof args)[number]) => {
          if (arg.id === 2) {
            return Effect.fail("row failed");
          }
          return Effect.succeed({ id: arg.id, value: `row-${String(arg.id)}` });
        });
      },
    }),
    implementQuery(Failure, () => Effect.fail("expected failure")),
  ],
  implementations: [CounterLive],
}).pipe(Layer.provide(policies));

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const localLayerHasNoTransportRequirement: Equals<Layer.Services<typeof testLayer>, never> = true;

const key = { id: "main" };
const commandId = Schema.decodeSync(CommandId);

const settled = <A, E>(state: Source<QueryState<A, E>>) =>
  state.changes.pipe(
    Stream.filter((current) => current._tag !== "Loading"),
    Stream.take(1),
    Stream.runDrain,
  );

const makeRoot = Effect.sync(() => document.createElement("main"));

const textAt = (root: Node, selector: string): string => {
  if (!(root instanceof HTMLElement)) {
    return "";
  }
  return root.querySelector(selector)?.textContent ?? "";
};

describe("local query test transport", () => {
  it.scoped.layer(testLayer)("serves real cache entries through readiness and controls", () =>
    Effect.gen(function* () {
      expect(localLayerHasNoTransportRequirement).toBe(true);
      const root = yield* makeRoot;
      const entryReady =
        yield* Deferred.make<QueryEntry<{ readonly count: number }, QueryFailure>>();
      const Page = () =>
        Loading({
          fallback: <p id="loading">loading</p>,
          children: Effect.gen(function* () {
            const entry = yield* useQuery(Count, key);
            yield* Deferred.succeed(entryReady, entry);
            const state = yield* readyWithStale(entry.state, { count: -1 });
            return (
              <Query
                state={entry.state}
                loading={<p id="query-loading">loading</p>}
                ready={(value, stale) => (
                  <p id="value">
                    {View.bind(value, (current) => String(current.count))}:
                    {View.bind(stale, String)}:
                    {View.bind(state, (current) => String(current.value.count))}
                  </p>
                )}
                failed={() => <p id="failed">failed</p>}
              />
            );
          }),
        });

      const page = yield* ViewTest.make({
        host: Dom.host,
        root,
        setup: (host, mountRoot) => mount(Page, {}, host, mountRoot),
      });
      expect(root.querySelector("#loading")?.textContent).toBe("loading");
      yield* page.waitFor({
        label: "initial query value",
        until: (actualRoot) => textAt(actualRoot, "#value") === "0:false:0",
      });

      const gate = yield* Deferred.make<void>();
      countControl.current = Option.some({ gate });
      const counter = yield* ref(Counter, key);
      const calling = yield* Effect.forkChild(
        counter.call(
          { _tag: "Increment", amount: 1 },
          { commandId: commandId("query-test-command"), timeout: "1 second" },
        ),
      );
      const entry = yield* Deferred.await(entryReady);
      yield* Stream.runHead(
        Stream.filter(entry.state.changes, (state) => state._tag === "Ready" && state.stale),
      );
      yield* page.waitFor({
        label: "stale query value",
        until: (actualRoot) => textAt(actualRoot, "#value") === "0:true:0",
      });

      yield* Deferred.succeed(gate, void 0);
      yield* Fiber.join(calling);
      yield* page.waitFor({
        label: "settled query value",
        until: (actualRoot) => textAt(actualRoot, "#value") === "1:false:1",
      });
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          countControl.current = Option.none();
        }),
      ),
    ),
  );

  it.scoped.layer(testLayer)("keeps batch failures per key and releases cache scopes", () =>
    Effect.gen(function* () {
      rowBatchGroups = [];
      const first = yield* useQuery(Rows, { id: 1 });
      const second = yield* useQuery(Rows, { id: 2 });
      yield* Effect.all([settled(first.state), settled(second.state)], {
        concurrency: "unbounded",
      });
      expect(yield* first.state.get).toEqual({
        _tag: "Ready",
        value: { id: 1, value: "row-1" },
        stale: false,
      });
      const secondState = yield* second.state.get;
      expect(secondState._tag).toBe("Failed");
      if (secondState._tag === "Failed") {
        expect(secondState.error._tag).toBe("QueryFailed");
      }
      expect(rowBatchGroups).toEqual([[1, 2]]);

      const failed = yield* useQuery(Failure, {});
      yield* settled(failed.state);
      const failure = yield* failed.state.get;
      expect(failure._tag).toBe("Failed");
      if (failure._tag === "Failed") {
        expect(failure.error._tag).toBe("QueryFailed");
      }

      const cache = yield* QueryCache;
      expect((yield* cache.active).length).toBe(3);
      const scope = yield* Scope.make();
      yield* Scope.provide(useQuery(Rows, { id: 3 }), scope);
      expect((yield* cache.active).length).toBe(4);
      yield* Scope.close(scope, Exit.void);
      expect((yield* cache.active).length).toBe(3);
    }),
  );
});
