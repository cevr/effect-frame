import { registerDom } from "./dom-setup.js";

registerDom();

import {
  Actor,
  ActorHost,
  Behavior,
  HttpServer,
  implementBatchedQuery,
  QueryCache,
  Value,
  Policies,
  Policy,
  batchedQuery,
} from "effect-frame/actor";
import type { Source } from "effect-frame/actor";
import { HttpTransport } from "effect-frame/actor/client";
import { Dom, View } from "effect-frame/view";
import { ViewTest } from "effect-frame/view/testing";
import { Deferred, Effect, Exit, Layer, Option, Ref, Schema, Sink, Stream } from "effect";
import { describe, expect, it } from "effect-bun-test";

/** The one policy table: every contract and query here declares `public`. */
const policies = Layer.succeed(Policies, Policies.of({ public: Policy.allowAll }));

const RowQuery = batchedQuery("ViewListRow", {
  version: 1,
  policy: "public",
  args: Schema.Struct({ id: Schema.Finite }),
  result: Schema.Struct({ id: Schema.Finite }),
  depends: [],
});

class TestFetchFailure extends Schema.TaggedError<TestFetchFailure>()("TestFetchFailure", {
  reason: Schema.String,
}) {}

interface BatchControl {
  readonly started: Deferred.Deferred<void>;
  readonly gate: Deferred.Deferred<void>;
  readonly cleaned: Deferred.Deferred<void>;
}

interface RowDisposal {
  readonly disposed: Ref.Ref<number>;
  readonly allDisposed: Deferred.Deferred<void>;
}

const batchControl = { current: Option.none<BatchControl>() };
let batchCalls = 0;
let batchRequests = 0;
let batchAborts = 0;
let singleRequests = 0;
let lastBatchIds: ReadonlyArray<number> = [];

const RowLive = implementBatchedQuery(RowQuery, {
  resolve: (args) =>
    Effect.gen(function* () {
      const control = batchControl.current;
      if (Option.isSome(control)) {
        yield* Effect.ensuring(
          Effect.andThen(
            Deferred.succeed(control.value.started, void 0),
            Deferred.await(control.value.gate),
          ),
          Deferred.succeed(control.value.cleaned, void 0),
        );
      }
      batchCalls += 1;
      lastBatchIds = args.map((arg) => arg.id);
      return (arg: (typeof args)[number]) => Effect.succeed({ id: arg.id });
    }),
});

const hostLayer = ActorHost.layer({
  implementations: [],
  queries: [RowLive],
  store: ActorHost.memoryStore,
}).pipe(Layer.provide(policies));

const inProcess = Layer.unwrap(
  Effect.gen(function* () {
    const server = yield* HttpServer.make({ principal: HttpServer.anonymous });
    const context = yield* Effect.context<never>();
    const run = Effect.runPromiseWith(context);
    const fetch: HttpTransport.FetchLike = (input, init) => {
      if (input.endsWith("/query/batch")) {
        batchRequests += 1;
      } else if (input.endsWith("/query")) {
        singleRequests += 1;
      }
      return run(
        Effect.callback<Response, TestFetchFailure>((resume, effectSignal) => {
          const signal = Option.fromNullishOr(init?.signal);
          const fiber = Effect.runForkWith(context)(server(new Request(input, init)));
          let settled = false;
          const removeAbort = () =>
            Option.match(signal, {
              onNone: () => {},
              onSome: (value) => value.removeEventListener("abort", abort),
            });
          const removeEffectAbort = () => effectSignal.removeEventListener("abort", abort);
          const abort = () => {
            if (settled) {
              return;
            }
            settled = true;
            removeAbort();
            removeEffectAbort();
            if (input.endsWith("/query/batch")) {
              batchAborts += 1;
            }
            fiber.interruptUnsafe();
            resume(Effect.fail(TestFetchFailure.make({ reason: "request aborted" })));
          };
          Option.match(signal, {
            onNone: () => {},
            onSome: (value) => value.addEventListener("abort", abort, { once: true }),
          });
          fiber.addObserver((exit) => {
            if (settled) {
              return;
            }
            settled = true;
            removeAbort();
            removeEffectAbort();
            if (Exit.isSuccess(exit)) {
              resume(Effect.succeed(exit.value));
            } else {
              resume(Effect.fail(TestFetchFailure.make({ reason: String(exit.cause) })));
            }
          });
          Option.match(signal, {
            onNone: () => {},
            onSome: (value) => {
              if (value.aborted) {
                abort();
              }
            },
          });
          effectSignal.addEventListener("abort", abort, { once: true });
          return Effect.sync(() => {
            if (!settled) {
              settled = true;
              removeAbort();
              removeEffectAbort();
              fiber.interruptUnsafe();
            }
          });
        }),
      );
    };
    return HttpTransport.layer({
      baseUrl: "http://actors.test/actors",
      reconnect: HttpTransport.defaultReconnect,
    }).pipe(Layer.provide(Layer.succeed(HttpTransport.Fetch, fetch)));
  }),
).pipe(Layer.provide(hostLayer));

const clientLayer = Layer.merge(inProcess, QueryCache.layer);

interface RowsProps {
  readonly items: Source<ReadonlyArray<number>>;
  readonly disposal: Option.Option<RowDisposal>;
}

/** A real View.list row suspends on its first item source value before opening its query. */
const Rows = (props: RowsProps) =>
  Effect.gen(function* () {
    const rows = yield* View.list({
      each: props.items,
      keyBy: (item) => String(item),
      row: (item) =>
        Effect.gen(function* () {
          if (Option.isSome(props.disposal)) {
            const { disposed, allDisposed } = props.disposal.value;
            yield* Effect.addFinalizer(() =>
              Effect.flatMap(
                Ref.updateAndGet(disposed, (count) => count + 1),
                (count) => {
                  if (count === 2) {
                    return Deferred.succeed(allDisposed, void 0);
                  }
                  return Effect.void;
                },
              ),
            );
          }
          const [first] = yield* Stream.peel(item.changes, Sink.head());
          const id = yield* Option.match(first, {
            onNone: () => item.get,
            onSome: Effect.succeed,
          });
          const entry = yield* QueryCache.use((cache) => cache.open(RowQuery, { id }));
          return <li data-id={String(id)}>{View.bind(entry.state, (state) => state._tag)}</li>;
        }),
    });
    return <ul>{rows}</ul>;
  });

const makeRoot = Effect.sync(() => document.createElement("main"));

const withClient = it.scoped.layer(clientLayer);

describe("View.list and declared query batches", () => {
  withClient("opens every row in one real query batch", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      document.body.appendChild(root);
      const items = yield* Actor.local(Behavior.value<ReadonlyArray<number>>([1, 2]));
      const started = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const cleaned = yield* Deferred.make<void>();
      batchControl.current = Option.some({ started, gate, cleaned });

      const page = yield* ViewTest.make({
        host: Dom.host,
        root,
        setup: (host, mountRoot) =>
          View.mount(Rows, { items: items.state, disposal: Option.none() }, host, mountRoot),
      });
      yield* Deferred.await(started);
      expect(batchRequests).toBe(1);
      expect(singleRequests).toBe(0);
      expect(batchCalls).toBe(0);
      expect(lastBatchIds).toEqual([]);

      yield* page.act(Effect.andThen(Deferred.succeed(gate, void 0), Deferred.await(cleaned)), {
        label: "both query rows are ready",
        until: (actualRoot) =>
          actualRoot instanceof HTMLElement && actualRoot.querySelectorAll("li").length === 2,
      });
      expect(batchCalls).toBe(1);
      expect(lastBatchIds).toEqual([1, 2]);
      expect(root.querySelectorAll("li")).toHaveLength(2);
      expect(Array.from(root.querySelectorAll("li")).map((row) => row.dataset["id"])).toEqual([
        "1",
        "2",
      ]);
      root.remove();
      batchControl.current = Option.none();
    }),
  );

  withClient(
    "closing every row while its batch is in flight releases both rows and cleans the request",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        document.body.appendChild(root);
        const items = yield* Actor.local(Behavior.value<ReadonlyArray<number>>([1, 2]));
        const disposed = yield* Ref.make(0);
        const allDisposed = yield* Deferred.make<void>();
        const started = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const cleaned = yield* Deferred.make<void>();
        const beforeRequests = batchRequests;
        const beforeCalls = batchCalls;
        const beforeAborts = batchAborts;
        lastBatchIds = [];
        batchControl.current = Option.some({ started, gate, cleaned });

        yield* Effect.ensuring(
          Effect.gen(function* () {
            const page = yield* ViewTest.make({
              host: Dom.host,
              root,
              setup: (host, mountRoot) =>
                View.mount(
                  Rows,
                  { items: items.state, disposal: Option.some({ disposed, allDisposed }) },
                  host,
                  mountRoot,
                ),
            });
            yield* Deferred.await(started);
            yield* page.act(items.call(Value.Set([])), {
              label: "all query rows are removed",
              until: (actualRoot) =>
                actualRoot instanceof HTMLElement && actualRoot.querySelectorAll("li").length === 0,
            });
            yield* Deferred.await(allDisposed);
            expect(yield* Ref.get(disposed)).toBe(2);
            expect(root.querySelectorAll("li")).toHaveLength(0);

            const cache = yield* QueryCache;
            expect(yield* cache.active).toEqual([]);

            yield* Deferred.await(cleaned);
            expect(yield* Deferred.isDone(cleaned)).toBe(true);
            expect(batchAborts - beforeAborts).toBe(1);
            yield* Deferred.succeed(gate, void 0);
            yield* Deferred.await(cleaned);
            expect(batchRequests - beforeRequests).toBe(1);
            expect(batchCalls - beforeCalls).toBe(0);
            expect(lastBatchIds).toEqual([]);
          }),
          Effect.sync(() => {
            batchControl.current = Option.none();
            root.remove();
          }),
        );
      }),
  );
});
