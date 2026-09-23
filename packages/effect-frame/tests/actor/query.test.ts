import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schema,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import { describe, expect, it } from "effect-bun-test";
import {
  ActorHost,
  Behavior,
  CommandId,
  HttpServer,
  Policies,
  Policy,
  PolicyNamesMissing,
  Query,
  implementQuery,
  implementTransparent,
} from "effect-frame/actor";
import {
  Authenticated,
  CurrentPrincipal,
  HttpTransport,
  ActorTransport,
  QueryCache,
  Unauthorized,
  Wire,
  contract,
  followQuery,
  keyOf,
  query,
  commandRef,
  queryCacheLayer,
  ref,
  useQuery,
} from "effect-frame/actor/client";
import type { PolicyTable, Subject } from "effect-frame/actor";
import type { Address, QueryEntry, QueryState, Source } from "effect-frame/actor/client";

/**
 * The Dashboard shape (#17): several queries, one live actor, one command
 * whose reply refreshes two queries in one round trip, over the same
 * in-process HTTP transport `tests/http.test.ts` uses. The entry lifetime
 * rows are #28's: an entry lives while a scope declares it.
 */

// ---------------------------------------------------------------------------
// The live actor: an order book that commands mutate
// ---------------------------------------------------------------------------

const PlaceOrder = Schema.TaggedStruct("PlaceOrder", {
  sku: Schema.String,
  amount: Schema.Finite,
});
type PlaceOrder = Schema.Schema.Type<typeof PlaceOrder>;

const OrderBookState = Schema.Struct({
  count: Schema.Finite,
  revenue: Schema.Finite,
  lastSku: Schema.String,
});
type OrderBookState = Schema.Schema.Type<typeof OrderBookState>;

const OrderBook = contract("OrderBook", {
  version: 1,
  // The same name the tenant-scoped queries carry: one rule guards both.
  policy: "tenant-member",
  key: Schema.Struct({ tenant: Schema.String }),
  snapshot: OrderBookState,
  message: Schema.Union([PlaceOrder]),
});

const OrderBookLive = implementTransparent(
  OrderBook,
  Behavior.reducer<OrderBookState, PlaceOrder>({
    initial: { count: 0, revenue: 0, lastSku: "" },
    reduce: (state, message) => ({
      count: state.count + 1,
      revenue: state.revenue + message.amount,
      lastSku: message.sku,
    }),
  }),
);

/** A second actor nothing on the dashboard depends on, to prove the scope. */
const Ping = Schema.TaggedStruct("Ping", {});
const Heartbeat = contract("Heartbeat", {
  version: 1,
  policy: "tenant-member",
  key: Schema.Struct({ tenant: Schema.String }),
  snapshot: Schema.Finite,
  message: Schema.Union([Ping]),
});
const HeartbeatLive = implementTransparent(
  Heartbeat,
  Behavior.reducer<number, Schema.Schema.Type<typeof Ping>>({
    initial: 0,
    reduce: (state) => state + 1,
  }),
);

// ---------------------------------------------------------------------------
// The queries: three reads, two of which depend on the order book
// ---------------------------------------------------------------------------

const TenantArgs = Schema.Struct({ tenant: Schema.String });

const Revenue = query("Revenue", {
  version: 1,
  args: TenantArgs,
  result: Schema.Struct({ total: Schema.Finite }),
  policy: "tenant-member",
  depends: [OrderBook],
});

const TopSku = query("TopSku", {
  version: 1,
  args: TenantArgs,
  result: Schema.Struct({ sku: Schema.String, orders: Schema.Finite }),
  policy: "tenant-member",
  depends: [OrderBook],
});

/**
 * Reads nothing an actor owns, so no commit refreshes it. It names no
 * version or dependency: the defaults are 1 and none. Its policy has no
 * default: `"public"` is written here, and the host's table registers it.
 */
const ExchangeRate = query("ExchangeRate", {
  policy: "public",
  args: Schema.Struct({ pair: Schema.String }),
  result: Schema.Struct({ rate: Schema.Finite }),
});

/** Counts server reads, so a test can prove one read served two declarations. */
const Counted = query("Counted", {
  version: 1,
  args: Schema.Struct({ tenant: Schema.String }),
  result: Schema.Finite,
  policy: "public",
  depends: [OrderBook],
});

/** A declared batch query used by the wire, cache, authorization, and refresh rows. */
const BatchedLookup = query.batched("BatchedLookup", {
  version: 1,
  args: Schema.Struct({ tenant: Schema.String, id: Schema.Finite }),
  result: Schema.Struct({ id: Schema.Finite, round: Schema.Finite }),
  policy: "tenant-member",
  depends: [OrderBook],
});

/** A chronology probe: its first read waits while a command refresh fails. */
const Chronology = query.batched("Chronology", {
  version: 1,
  args: Schema.Struct({ tenant: Schema.String, id: Schema.Finite }),
  result: Schema.Finite,
  policy: "tenant-member",
  depends: [OrderBook],
});

/** A query whose policy name no host resolves. The host must refuse it. */
const Unpoliced = query("Unpoliced", {
  version: 1,
  args: TenantArgs,
  result: Schema.Finite,
  policy: "nobody-defines-this",
  depends: [OrderBook],
});

// ---------------------------------------------------------------------------
// The server: handlers read the actor's snapshot through the transport
// ---------------------------------------------------------------------------

/**
 * Every query handler run, by query name. A handler that did not run did no
 * work, which is how a test proves a refresh never happened.
 */
const handlerRuns = new Map<string, number>();
const countRun = (name: string) =>
  Effect.sync(() => {
    handlerRuns.set(name, runsOf(name) + 1);
  });
const runsOf = (name: string): number =>
  Option.getOrElse(Option.fromNullishOr(handlerRuns.get(name)), () => 0);

const readBook = (tenant: string) =>
  Effect.gen(function* () {
    const book = yield* ref(OrderBook, { tenant });
    return yield* book.state.get;
  });

const RevenueLive = implementQuery(Revenue, (args) =>
  Effect.andThen(
    countRun(Revenue.name),
    Effect.map(readBook(args.tenant), (state) => ({ total: state.revenue })),
  ),
);

const TopSkuLive = implementQuery(TopSku, (args) =>
  Effect.andThen(
    countRun(TopSku.name),
    Effect.map(readBook(args.tenant), (state) => ({
      sku: state.lastSku,
      orders: state.count,
    })),
  ),
);

/** A dependent whose handler a test can make throw, to fail one refresh. */
const Funnel = query("Funnel", {
  version: 1,
  args: TenantArgs,
  result: Schema.Struct({ orders: Schema.Finite }),
  policy: "tenant-member",
  depends: [OrderBook],
});

const funnelDown = { current: false };

const FunnelLive = implementQuery(Funnel, (args) =>
  Effect.gen(function* () {
    yield* countRun(Funnel.name);
    if (funnelDown.current) {
      return yield* Effect.fail("funnel store is down");
    }
    const state = yield* readBook(args.tenant);
    return { orders: state.count };
  }),
);

/**
 * Record arguments encode in the order the caller spelled them, so only the
 * canonical key makes `{a, b}` and `{b, a}` one entry.
 */
const Pair = query("Pair", {
  version: 1,
  args: Schema.Record(Schema.String, Schema.String),
  result: Schema.String,
  policy: "public",
  depends: [],
});

const PairLive = implementQuery(Pair, (args) =>
  Effect.as(countRun(Pair.name), `${args["a"]}${args["b"]}`),
);

const rates = new Map<string, number>([["USDEUR", 0.92]]);

/** A test may hold every rate read open, to observe a value in flight. */
const rateGate = { current: Option.none<Deferred.Deferred<void>>() };

const ExchangeRateLive = implementQuery(ExchangeRate, (args) =>
  Effect.andThen(
    Effect.suspend(() =>
      Option.match(rateGate.current, { onNone: () => Effect.void, onSome: Deferred.await }),
    ),
    Effect.succeed({
      rate: Option.getOrElse(Option.fromNullishOr(rates.get(args.pair)), () => 1),
    }),
  ),
);

const UnpolicedLive = implementQuery(Unpoliced, () => Effect.succeed(1));

let reads = 0;
const CountedLive = implementQuery(Counted, () =>
  Effect.sync(() => {
    reads += 1;
    return reads;
  }),
);

let batchCalls = 0;
let lastBatchIds: ReadonlyArray<number> = [];
const batchGate = { current: Option.none<Deferred.Deferred<void>>() };
const batchStarted = { current: Option.none<Deferred.Deferred<void>>() };
const BatchedLookupLive = Query.batched(BatchedLookup, {
  resolve: (args) =>
    Effect.gen(function* () {
      const started = batchStarted.current;
      if (Option.isSome(started)) {
        yield* Deferred.succeed(started.value, void 0);
      }
      const gate = batchGate.current;
      if (Option.isSome(gate)) {
        yield* Deferred.await(gate.value);
      }
      batchCalls += 1;
      const round = batchCalls;
      lastBatchIds = args.map((arg) => arg.id);
      const values = new Set(lastBatchIds);
      return (arg: (typeof args)[number]) => {
        if (arg.id < 0 || !values.has(arg.id)) {
          return Effect.fail(`no row for ${arg.id}`);
        }
        return Effect.succeed({ id: arg.id, round });
      };
    }),
});

interface ChronologyControl {
  readonly firstStarted: Deferred.Deferred<void>;
  readonly firstGate: Deferred.Deferred<void>;
  readonly firstFinished: Deferred.Deferred<void>;
  calls: number;
}

const chronologyControl = { current: Option.none<ChronologyControl>() };

const ChronologyLive = Query.batched(Chronology, {
  resolve: () =>
    Effect.gen(function* () {
      const control = chronologyControl.current;
      if (Option.isNone(control)) {
        return () => Effect.succeed(1);
      }
      const call = control.value.calls;
      control.value.calls += 1;
      if (call === 0) {
        yield* Deferred.succeed(control.value.firstStarted, void 0);
        yield* Effect.ensuring(
          Deferred.await(control.value.firstGate),
          Deferred.succeed(control.value.firstFinished, void 0),
        );
        return () => Effect.succeed(1);
      }
      return () => Effect.fail("refresh failed");
    }),
});

/**
 * Only the acme tenant, read from the subject alone: these rows are about
 * queries, not principals, so every caller here is anonymous. One rule
 * guards the actors and the queries alike.
 */
const acmeSubjects: Policy = {
  check: (_principal, subject: Subject) => {
    if (subject._tag === "Actor" && subject.address.key.includes('"acme"')) {
      return Effect.void;
    }
    if (subject._tag === "Query" && subject.key.args.includes('"acme"')) {
      return Effect.void;
    }
    return Effect.fail(Unauthorized.make({ contract: "tenant-member" }));
  },
};

/** One table for actors and queries. Allow-all is here by name, and only here. */
const table: PolicyTable = { "tenant-member": acmeSubjects, public: Policy.allowAll };
const policies = Layer.succeed(Policies, Policies.of(table));

const id = Schema.decodeSync(CommandId);
const acme = { tenant: "acme" };

// ---------------------------------------------------------------------------
// Wiring: one host serves actors and queries. The handlers read actors
// through the host's own transport, so a query sees the instances a command
// mutated. A second host would have opened a second set of instances.
// ---------------------------------------------------------------------------

const hostLayer = ActorHost.layerMemory(
  [OrderBookLive, HeartbeatLive],
  [
    RevenueLive,
    TopSkuLive,
    ExchangeRateLive,
    CountedLive,
    BatchedLookupLive,
    ChronologyLive,
    FunnelLive,
    PairLive,
  ],
).pipe(Layer.provide(policies));

let batchRequests = 0;
/** Actor reads over the wire: snapshot requests and change streams opened. */
let snapshotRequests = 0;
let changeStreams = 0;

/** One `/call` exchange as the wire carried it: the keys declared and the refreshes answered. */
interface CallExchange {
  readonly active: ReadonlyArray<string>;
  readonly refreshed: ReadonlyArray<Wire.WireRefreshed>;
}

/** Every `/call` exchange, in order. A test reads the ones after its own mark. */
const calls: Array<CallExchange> = [];

const decodeCallBody = Schema.decodeUnknownEffect(Schema.fromJsonString(Wire.CallBody));
const decodeApplied = Schema.decodeUnknownEffect(Schema.fromJsonString(Wire.WireApplied));

const recordCall = (request: Request, response: Response) =>
  Effect.gen(function* () {
    const body = yield* Effect.orDie(decodeCallBody(yield* Effect.promise(() => request.text())));
    // A refused call has no refreshes to record.
    const reply = yield* Effect.option(
      decodeApplied(yield* Effect.promise(() => response.clone().text())),
    );
    if (Option.isSome(reply)) {
      calls.push({
        active: body.active.map((key) => keyOf(key)),
        refreshed: reply.value.refreshed,
      });
    }
  });

const inProcess = Layer.unwrap(
  Effect.gen(function* () {
    const server = yield* HttpServer.make({ principal: HttpServer.anonymous });
    const context = yield* Effect.context<never>();
    const run = Effect.runPromiseWith(context);
    const fetch: HttpTransport.FetchLike = (input, init) => {
      if (input.endsWith("/query/batch")) {
        batchRequests += 1;
      }
      if (input.endsWith("/snapshot")) {
        snapshotRequests += 1;
      }
      if (input.includes("/changes?")) {
        changeStreams += 1;
      }
      const request = new Request(input, init);
      if (input.endsWith("/call")) {
        return run(
          Effect.tap(server(request.clone()), (response) => recordCall(request, response)),
        );
      }
      return run(server(request));
    };
    return HttpTransport.layer({
      baseUrl: "http://actors.test/actors",
      reconnect: HttpTransport.defaultReconnect,
    }).pipe(Layer.provide(Layer.succeed(HttpTransport.Fetch, fetch)));
  }),
).pipe(Layer.provide(hostLayer));

/** The client runtime: one transport, one query cache, wired at one root. */
const clientLayer = Layer.merge(inProcess, queryCacheLayer);
const withDashboard = it.scoped.layer(clientLayer);

/**
 * Wait until a query has stopped being in flight. `open` starts the first
 * read and returns at once, so a test that wants the value waits here, the
 * way a readiness scope does.
 */
const settled = <A, E>(state: Source<QueryState<A, E>>) =>
  state.changes.pipe(
    Stream.filter((current) => current._tag !== "Loading"),
    Stream.take(1),
    Stream.runDrain,
  );

const settledEntry = <A, E>(entry: QueryEntry<A, E>) => settled(entry.state);

/** Asserts a query is Ready and hands back its value. */
const valueOf = <A, E>(state: QueryState<A, E>): Option.Option<A> => {
  expect(state._tag).toBe("Ready");
  if (state._tag === "Ready") {
    return Option.some(state.value);
  }
  return Option.none();
};

describe("Query: the Dashboard shape", () => {
  it.effect("a contract that names no version or dependency gets the defaults", () =>
    Effect.sync(() => {
      expect(ExchangeRate.version).toBe(1);
      expect(ExchangeRate.policy).toBe("public");
      expect(ExchangeRate.depends).toEqual([]);
      expect(BatchedLookup.mode).toBe("batched");
    }),
  );

  withDashboard("one command reply refreshes the two queries that declared the dependency", () =>
    Effect.gen(function* () {
      const revenue = yield* useQuery(Revenue, acme);
      const topSku = yield* useQuery(TopSku, acme);
      const rate = yield* useQuery(ExchangeRate, { pair: "USDEUR" });
      const book = yield* ref(OrderBook, acme);
      yield* Effect.all([settledEntry(revenue), settledEntry(topSku), settledEntry(rate)]);

      expect(valueOf(yield* revenue.state.get)).toEqual(Option.some({ total: 0 }));
      expect(valueOf(yield* topSku.state.get)).toEqual(Option.some({ sku: "", orders: 0 }));
      expect(valueOf(yield* rate.state.get)).toEqual(Option.some({ rate: 0.92 }));
      const mark = calls.length;
      const revenueRuns = runsOf(Revenue.name);
      const topSkuRuns = runsOf(TopSku.name);

      // One command. Its reply carries both dependent queries, refreshed.
      yield* book.call(
        { _tag: "PlaceOrder", sku: "widget", amount: 30 },
        { commandId: id("order-1"), timeout: "1 second" },
      );

      // One call on the wire. It declared the three active keys and its reply
      // answered the two that depend on the order book, and only those.
      const exchanges = calls.slice(mark);
      expect(exchanges).toHaveLength(1);
      expect(exchanges[0]?.active.toSorted()).toEqual(
        [revenue.key, topSku.key, rate.key].map(keyOf).toSorted(),
      );
      expect(exchanges[0]?.refreshed.map((one) => [one._tag, keyOf(one.key)]).toSorted()).toEqual(
        [
          ["Refreshed", keyOf(revenue.key)],
          ["Refreshed", keyOf(topSku.key)],
        ].toSorted(),
      );
      // Each dependent handler ran once, for the reply; no second read followed.
      expect(runsOf(Revenue.name) - revenueRuns).toBe(1);
      expect(runsOf(TopSku.name) - topSkuRuns).toBe(1);

      const afterRevenue = yield* revenue.state.get;
      const afterTopSku = yield* topSku.state.get;
      expect(afterRevenue).toEqual({ _tag: "Ready", value: { total: 30 }, stale: false });
      expect(afterTopSku).toEqual({
        _tag: "Ready",
        value: { sku: "widget", orders: 1 },
        stale: false,
      });
      // The query that declared no dependency is untouched and not stale.
      expect(yield* rate.state.get).toEqual({
        _tag: "Ready",
        value: { rate: 0.92 },
        stale: false,
      });
    }),
  );

  withDashboard("the same command refreshes nothing when neither dependent is active", () =>
    Effect.gen(function* () {
      const cache = yield* QueryCache;
      // Both dependents were on screen once, and their views have gone.
      const screen = yield* Scope.make();
      const [shownRevenue, shownTopSku] = yield* Scope.provide(
        Effect.all([useQuery(Revenue, acme), useQuery(TopSku, acme)]),
        screen,
      );
      yield* Effect.all([settledEntry(shownRevenue), settledEntry(shownTopSku)]);
      yield* Scope.close(screen, Exit.void);
      const rate = yield* useQuery(ExchangeRate, { pair: "USDEUR" });
      yield* settledEntry(rate);
      expect((yield* cache.active).map(keyOf)).toEqual([keyOf(rate.key)]);
      const mark = calls.length;
      const revenueRuns = runsOf(Revenue.name);
      const topSkuRuns = runsOf(TopSku.name);

      const book = yield* ref(OrderBook, acme);
      yield* book.call(
        { _tag: "PlaceOrder", sku: "offscreen", amount: 3 },
        { commandId: id("order-offscreen"), timeout: "1 second" },
      );

      const exchanges = calls.slice(mark);
      expect(exchanges).toEqual([{ active: [keyOf(rate.key)], refreshed: [] }]);
      expect(runsOf(Revenue.name)).toBe(revenueRuns);
      expect(runsOf(TopSku.name)).toBe(topSkuRuns);
    }),
  );

  withDashboard("a commit to an actor no query depends on refreshes nothing", () =>
    Effect.gen(function* () {
      const revenue = yield* useQuery(Revenue, acme);
      const topSku = yield* useQuery(TopSku, acme);
      yield* Effect.all([settledEntry(revenue), settledEntry(topSku)]);
      const mark = calls.length;
      const runs = [...handlerRuns.entries()];
      const heartbeat = yield* ref(Heartbeat, acme);
      yield* heartbeat.call({ _tag: "Ping" }, { commandId: id("beat-1"), timeout: "1 second" });
      // The call declared both active keys; the host found no dependent of
      // Heartbeat among them, so its reply is empty and no handler ran.
      const exchanges = calls.slice(mark);
      expect(exchanges).toHaveLength(1);
      expect(exchanges[0]?.active).toHaveLength(2);
      expect(exchanges[0]?.refreshed).toEqual([]);
      expect([...handlerRuns.entries()]).toEqual(runs);
      // Not stale: Heartbeat is in no `depends` list, so nothing invalidated.
      expect(yield* revenue.state.get).toEqual({
        _tag: "Ready",
        value: { total: 0 },
        stale: false,
      });
    }),
  );

  withDashboard("the cache key is canonical: field order does not split an entry", () =>
    Effect.gen(function* () {
      const cache = yield* QueryCache;
      const before = runsOf(Pair.name);
      const first = yield* useQuery(Pair, { a: "1", b: "2" });
      const second = yield* useQuery(Pair, { b: "2", a: "1" });
      expect(keyOf(first.key)).toBe(keyOf(second.key));
      expect(first.key.args).toBe('{"a":"1","b":"2"}');
      // One entry: one active key and one server read serve both declarations.
      expect((yield* cache.active).map(keyOf)).toEqual([keyOf(first.key)]);
      yield* Effect.all([settledEntry(first), settledEntry(second)]);
      expect(runsOf(Pair.name) - before).toBe(1);
      expect(yield* second.state.get).toEqual({ _tag: "Ready", value: "12", stale: false });
    }),
  );

  withDashboard("a failed refresh answers RefreshFailed and does not undo the command", () =>
    Effect.gen(function* () {
      const revenue = yield* useQuery(Revenue, acme);
      const funnel = yield* useQuery(Funnel, acme);
      yield* Effect.all([settledEntry(revenue), settledEntry(funnel)]);
      const book = yield* ref(OrderBook, acme);
      const before = yield* book.state.get;
      const mark = calls.length;
      const commandId = id("order-funnel-down");
      const message: PlaceOrder = { _tag: "PlaceOrder", sku: "gear", amount: 7 };

      funnelDown.current = true;
      const applied = yield* Effect.ensuring(
        book.call(message, { commandId, timeout: "1 second" }),
        Effect.sync(() => {
          funnelDown.current = false;
        }),
      );

      // The command committed. Its reply carries the good refresh and the
      // failed one side by side; the failure never became the command's.
      expect(applied.state).toEqual({
        count: before.count + 1,
        revenue: before.revenue + 7,
        lastSku: "gear",
      });
      const exchanges = calls.slice(mark);
      expect(exchanges).toHaveLength(1);
      const refreshed = exchanges[0]?.refreshed ?? [];
      expect(refreshed.find((one) => keyOf(one.key) === keyOf(revenue.key))).toEqual({
        _tag: "Refreshed",
        key: revenue.key,
        result: yield* Schema.encodeEffect(Revenue.result)({ total: before.revenue + 7 }),
      });
      expect(refreshed.find((one) => keyOf(one.key) === keyOf(funnel.key))).toMatchObject({
        _tag: "RefreshFailed",
        key: funnel.key,
        error: { _tag: "QueryFailed", query: Funnel.name, detail: "funnel store is down" },
      });
      const failed = yield* funnel.state.get;
      expect(failed._tag).toBe("Failed");
      if (failed._tag === "Failed") {
        expect(failed.error._tag).toBe("QueryFailed");
      }
      expect(yield* revenue.state.get).toEqual({
        _tag: "Ready",
        value: { total: before.revenue + 7 },
        stale: false,
      });

      // The stored receipt still carries the commit: the same ID answers with
      // it and applies nothing a second time.
      const again = yield* book.send(message, { commandId });
      const resettled = yield* again.settled;
      expect(resettled).toMatchObject({ _tag: "Applied", revision: applied.revision });
      expect(yield* book.state.get).toEqual(applied.state);
    }),
  );

  withDashboard("a command reference sends with no snapshot and no change stream", () =>
    Effect.gen(function* () {
      const revenue = yield* useQuery(Revenue, acme);
      yield* settledEntry(revenue);
      const before = Option.getOrThrow(valueOf(yield* revenue.state.get)).total;
      const actorReads = { snapshots: snapshotRequests, streams: changeStreams };

      const book = yield* commandRef(OrderBook, acme);
      const handle = yield* book.send(
        { _tag: "PlaceOrder", sku: "command-only", amount: 7 },
        { commandId: id("command-only-1") },
      );
      const settlement = yield* handle.settled;
      expect(settlement._tag).toBe("Applied");

      // The reply refreshed the dependent the page declared, as a full
      // reference's would.
      const last = calls.at(-1);
      expect(last?.active).toEqual([
        keyOf({ query: "Revenue", version: 1, args: '{"tenant":"acme"}' }),
      ]);
      expect(yield* revenue.state.get).toEqual({
        _tag: "Ready",
        value: { total: before + 7 },
        stale: false,
      });
      // And it read nothing of the actor: no snapshot, no change stream.
      expect({ snapshots: snapshotRequests, streams: changeStreams }).toEqual(actorReads);
      // A full reference, for contrast, reads the snapshot and follows.
      yield* ref(OrderBook, acme);
      yield* Effect.yieldNow;
      expect(snapshotRequests).toBe(actorReads.snapshots + 1);
    }),
  );

  withDashboard("an explicit override shows a value as stale until a refresh lands", () =>
    Effect.gen(function* () {
      const revenue = yield* useQuery(Revenue, acme);
      yield* settledEntry(revenue);
      yield* revenue.override(() => ({ total: 999 }));
      expect(yield* revenue.state.get).toEqual({
        _tag: "Ready",
        value: { total: 999 },
        stale: true,
      });
      yield* revenue.refresh;
      expect(yield* revenue.state.get).toEqual({
        _tag: "Ready",
        value: { total: 0 },
        stale: false,
      });
    }),
  );

  withDashboard("an override is dropped by any authoritative value", () =>
    Effect.gen(function* () {
      const revenue = yield* useQuery(Revenue, acme);
      yield* settledEntry(revenue);
      const book = yield* ref(OrderBook, acme);

      // A command reply's refresh. The cache cannot tell which command an
      // override was for, so any refreshed value replaces it.
      yield* revenue.override(() => ({ total: -1 }));
      const applied = yield* book.call(
        { _tag: "PlaceOrder", sku: "override-drop", amount: 4 },
        { commandId: id("override-drop-1"), timeout: "1 second" },
      );
      const total = applied.state.revenue;
      expect(yield* revenue.state.get).toEqual({ _tag: "Ready", value: { total }, stale: false });

      // An unrelated refresh.
      yield* revenue.override(() => ({ total: -2 }));
      expect(yield* revenue.state.get).toEqual({
        _tag: "Ready",
        value: { total: -2 },
        stale: true,
      });
      yield* revenue.refresh;
      expect(yield* revenue.state.get).toEqual({ _tag: "Ready", value: { total }, stale: false });

      // A new declaration after the last one was released reads again.
      const screen = yield* Scope.make();
      const topSku = yield* Scope.provide(useQuery(TopSku, acme), screen);
      yield* settledEntry(topSku);
      const before = yield* topSku.state.get;
      yield* topSku.override(() => ({ sku: "guess", orders: 99 }));
      yield* Scope.close(screen, Exit.void);
      const reopened = yield* useQuery(TopSku, acme);
      yield* settledEntry(reopened);
      expect(yield* reopened.state.get).toEqual(before);
    }),
  );

  it.effect("the host refuses a query whose policy it cannot resolve", () =>
    Effect.gen(function* () {
      // Refused before it serves anything: the host does not build (#20 §3).
      const refused = yield* Effect.flip(
        Effect.scoped(
          ActorHost.make({ implementations: [], queries: [UnpolicedLive] }).pipe(
            Effect.provideService(Policies, table),
          ),
        ),
      );
      expect(refused).toEqual(
        PolicyNamesMissing.make({
          missing: [{ subject: "query", name: "Unpoliced", policy: "nobody-defines-this" }],
        }),
      );
    }),
  );

  withDashboard("a policy denies a read from another tenant", () =>
    Effect.gen(function* () {
      const denied = yield* useQuery(Revenue, { tenant: "other" });
      yield* settledEntry(denied);
      const state = yield* denied.state.get;
      expect(state._tag).toBe("Failed");
      if (state._tag === "Failed") {
        expect(state.error._tag).toBe("Unauthorized");
      }
    }),
  );

  withDashboard("a client with no query cache still commands, and gets no refreshes", () =>
    Effect.gen(function* () {
      const cache = yield* QueryCache;
      // The cache exists here, but nothing was opened, so nothing is active.
      expect(yield* cache.active).toEqual([]);
      const book = yield* ref(OrderBook, acme);
      const applied = yield* book.call(
        { _tag: "PlaceOrder", sku: "bolt", amount: 5 },
        { commandId: id("order-2"), timeout: "1 second" },
      );
      expect(applied.state.revenue).toBe(5);
    }),
  );

  withDashboard("open starts the first read and returns before it lands", () =>
    Effect.gen(function* () {
      const revenue = yield* useQuery(Revenue, acme);
      expect((yield* revenue.state.get)._tag).toBe("Loading");
      yield* settledEntry(revenue);
      expect(yield* revenue.state.get).toEqual({
        _tag: "Ready",
        value: { total: 0 },
        stale: false,
      });
    }),
  );

  withDashboard("two declarations of one key share one entry and one read", () =>
    Effect.gen(function* () {
      const before = reads;
      const first = yield* useQuery(Counted, acme);
      const second = yield* useQuery(Counted, acme);
      yield* settledEntry(first);
      yield* settledEntry(second);
      expect(reads - before).toBe(1);
      expect(yield* first.state.get).toEqual(yield* second.state.get);
      // A refresh through one face is seen through the other.
      yield* first.refresh;
      expect(reads - before).toBe(2);
      expect(yield* second.state.get).toEqual({ _tag: "Ready", value: reads, stale: false });
    }),
  );

  withDashboard("a refresh marks the value stale and holds it until the new one lands", () =>
    Effect.gen(function* () {
      const counted = yield* useQuery(Counted, acme);
      yield* settledEntry(counted);
      const shown = yield* counted.state.get;
      const first = Option.getOrElse(valueOf(shown), () => -1);
      const seen: Array<QueryState<number, unknown>> = [];
      yield* Effect.forkScoped(
        Stream.runForEach(counted.state.changes, (state) =>
          Effect.sync(() => void seen.push(state)),
        ),
      );
      yield* Effect.yieldNow;
      yield* counted.refresh;
      yield* Effect.yieldNow;
      expect(seen).toEqual([
        { _tag: "Ready", value: first, stale: false },
        { _tag: "Ready", value: first, stale: true },
        { _tag: "Ready", value: first + 1, stale: false },
      ]);
    }),
  );

  withDashboard("two concurrent refreshes cost one read", () =>
    Effect.gen(function* () {
      const counted = yield* useQuery(Counted, acme);
      yield* settledEntry(counted);
      const before = reads;
      yield* Effect.all([counted.refresh, counted.refresh], { concurrency: "unbounded" });
      expect(reads - before).toBe(1);
    }),
  );

  withDashboard("an entry is released when its last declaring scope closes", () =>
    Effect.gen(function* () {
      const cache = yield* QueryCache;
      const outer = yield* Scope.make();
      const inner = yield* Scope.make();
      const key = (yield* Scope.provide(useQuery(Counted, acme), outer)).key;
      yield* Scope.provide(useQuery(Counted, acme), inner);
      expect((yield* cache.active).map(keyOf)).toEqual([keyOf(key)]);

      yield* Scope.close(inner, Exit.void);
      // The outer declaration still holds it.
      expect((yield* cache.active).map(keyOf)).toEqual([keyOf(key)]);

      yield* Scope.close(outer, Exit.void);
      expect(yield* cache.active).toEqual([]);
    }),
  );

  withDashboard("a released entry's read in flight is interrupted", () =>
    Effect.gen(function* () {
      const cache = yield* QueryCache;
      const scope = yield* Scope.make();
      const entry = yield* Scope.provide(useQuery(Counted, acme), scope);
      // A refresh joins the read in flight; closing the scope ends both.
      const waiting = yield* Effect.forkChild(entry.refresh);
      yield* Scope.close(scope, Exit.void);
      const exit = yield* Effect.exit(Fiber.join(waiting));
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(yield* cache.active).toEqual([]);
    }),
  );

  withDashboard("a followed query's override writes the entry its arguments name now", () =>
    Effect.gen(function* () {
      const args = yield* SubscriptionRef.make<Option.Option<{ readonly pair: string }>>(
        Option.some({ pair: "USDEUR" }),
      );
      const followed = yield* followQuery(ExchangeRate, {
        get: SubscriptionRef.get(args),
        changes: SubscriptionRef.changes(args),
      });
      yield* settled(followed.state);
      const euro = yield* useQuery(ExchangeRate, { pair: "USDEUR" });

      // Shown at once, stale, on the followed source and on the entry itself.
      yield* followed.override(() => ({ rate: 1.5 }));
      expect(yield* followed.state.get).toEqual({
        _tag: "Ready",
        value: { rate: 1.5 },
        stale: true,
      });
      expect(yield* euro.state.get).toEqual({ _tag: "Ready", value: { rate: 1.5 }, stale: true });

      // Any authoritative value drops it.
      yield* followed.refresh;
      expect(yield* followed.state.get).toEqual({
        _tag: "Ready",
        value: { rate: 0.92 },
        stale: false,
      });

      // After the arguments move, it writes the new key's entry, not the old.
      rates.set("USDGBP", 0.79);
      yield* SubscriptionRef.set(args, Option.some({ pair: "USDGBP" }));
      yield* followed.state.changes.pipe(
        Stream.filter((state) => state._tag === "Ready" && !state.stale),
        Stream.take(1),
        Stream.runDrain,
      );
      yield* followed.override(() => ({ rate: 2 }));
      expect(yield* followed.state.get).toEqual({ _tag: "Ready", value: { rate: 2 }, stale: true });
      expect(yield* euro.state.get).toEqual({ _tag: "Ready", value: { rate: 0.92 }, stale: false });

      // With no arguments there is no entry, and nothing is written.
      yield* SubscriptionRef.set(args, Option.none());
      yield* Effect.yieldNow;
      yield* followed.override(() => ({ rate: 3 }));
      expect((yield* followed.state.get)._tag).toBe("Loading");
    }),
  );

  withDashboard("followQuery keeps the last value, stale, while the next key loads", () =>
    Effect.gen(function* () {
      const cache = yield* QueryCache;
      const args = yield* SubscriptionRef.make<Option.Option<{ readonly pair: string }>>(
        Option.some({ pair: "USDEUR" }),
      );
      const followed = yield* followQuery(ExchangeRate, {
        get: SubscriptionRef.get(args),
        changes: SubscriptionRef.changes(args),
      });
      expect((yield* followed.state.get)._tag).toBe("Loading");
      yield* settled(followed.state);
      expect(yield* followed.state.get).toEqual({
        _tag: "Ready",
        value: { rate: 0.92 },
        stale: false,
      });

      // Another key: the old value stays, marked stale, until the new lands.
      rates.set("USDGBP", 0.79);
      const gate = yield* Deferred.make<void>();
      rateGate.current = Option.some(gate);
      yield* SubscriptionRef.set(args, Option.some({ pair: "USDGBP" }));
      yield* followed.state.changes.pipe(
        Stream.filter((state) => state._tag === "Ready" && state.stale),
        Stream.take(1),
        Stream.runDrain,
      );
      expect(yield* followed.state.get).toEqual({
        _tag: "Ready",
        value: { rate: 0.92 },
        stale: true,
      });
      yield* Deferred.succeed(gate, void 0);
      rateGate.current = Option.none();
      yield* followed.state.changes.pipe(
        Stream.filter((state) => state._tag === "Ready" && !state.stale),
        Stream.take(1),
        Stream.runDrain,
      );
      expect(yield* followed.state.get).toEqual({
        _tag: "Ready",
        value: { rate: 0.79 },
        stale: false,
      });
      // Only the key on screen is active.
      expect((yield* cache.active).map((key) => key.args)).toEqual(['{"pair":"USDGBP"}']);

      // No arguments: nothing declared, and nothing to show.
      yield* SubscriptionRef.set(args, Option.none());
      yield* Effect.yieldNow;
      expect((yield* followed.state.get)._tag).toBe("Loading");
      expect(yield* cache.active).toEqual([]);
    }),
  );
});

describe("Query: declared batches", () => {
  withDashboard("coalesces one scheduler turn and shares duplicate keys", () =>
    Effect.gen(function* () {
      const beforeRequests = batchRequests;
      const beforeCalls = batchCalls;
      const first = yield* useQuery(BatchedLookup, { ...acme, id: 1 });
      const duplicate = yield* useQuery(BatchedLookup, { ...acme, id: 1 });
      const second = yield* useQuery(BatchedLookup, { ...acme, id: 2 });
      yield* Effect.all([settledEntry(first), settledEntry(duplicate), settledEntry(second)], {
        concurrency: "unbounded",
      });

      expect(keyOf(first.key)).toBe(keyOf(duplicate.key));
      expect(yield* first.state.get).toEqual(yield* duplicate.state.get);
      expect(yield* first.state.get).toEqual({
        _tag: "Ready",
        value: { id: 1, round: beforeCalls + 1 },
        stale: false,
      });
      expect(yield* second.state.get).toEqual({
        _tag: "Ready",
        value: { id: 2, round: beforeCalls + 1 },
        stale: false,
      });
      expect(batchRequests - beforeRequests).toBe(1);
      expect(batchCalls - beforeCalls).toBe(1);
    }),
  );

  withDashboard("keeps success and per-key failure in one batch", () =>
    Effect.gen(function* () {
      const beforeRequests = batchRequests;
      const beforeCalls = batchCalls;
      const success = yield* useQuery(BatchedLookup, { ...acme, id: 3 });
      const failure = yield* useQuery(BatchedLookup, { ...acme, id: -1 });
      yield* Effect.all([settledEntry(success), settledEntry(failure)], {
        concurrency: "unbounded",
      });

      expect(yield* success.state.get).toEqual({
        _tag: "Ready",
        value: { id: 3, round: beforeCalls + 1 },
        stale: false,
      });
      const failed = yield* failure.state.get;
      expect(failed._tag).toBe("Failed");
      if (failed._tag === "Failed") {
        expect(failed.error._tag).toBe("QueryFailed");
      }
      expect(batchRequests - beforeRequests).toBe(1);
      expect(batchCalls - beforeCalls).toBe(1);
    }),
  );

  withDashboard("isolates invalid, stale-version, and unauthorized keys", () =>
    Effect.gen(function* () {
      const beforeRequests = batchRequests;
      const beforeCalls = batchCalls;
      const transport = yield* ActorTransport;
      const results = yield* transport.queryBatch([
        { query: "BatchedLookup", version: 1, args: '{"id":1,"tenant":"acme"}' },
        { query: "BatchedLookup", version: 1, args: '{"id":"bad","tenant":"acme"}' },
        { query: "BatchedLookup", version: 1, args: '{"id":2,"tenant":"other"}' },
        { query: "BatchedLookup", version: 2, args: '{"id":3,"tenant":"acme"}' },
      ]);

      expect(results).toHaveLength(4);
      expect(results.map((result) => result._tag)).toEqual([
        "Refreshed",
        "RefreshFailed",
        "RefreshFailed",
        "RefreshFailed",
      ]);
      expect(lastBatchIds).toEqual([1]);
      if (results[0]?._tag === "Refreshed") {
        expect(results[0].result).toContain('"id":1');
      }
      if (results[1]?._tag === "RefreshFailed") {
        expect(results[1].error._tag).toBe("InvalidQueryArgs");
      }
      if (results[2]?._tag === "RefreshFailed") {
        expect(results[2].error._tag).toBe("Unauthorized");
      }
      if (results[3]?._tag === "RefreshFailed") {
        expect(results[3].error._tag).toBe("QueryVersionMismatch");
      }
      expect(batchRequests - beforeRequests).toBe(1);
      expect(batchCalls - beforeCalls).toBe(1);
    }),
  );

  withDashboard("cancelling one key leaves another live key in the batch", () =>
    Effect.gen(function* () {
      const firstScope = yield* Scope.make();
      const secondScope = yield* Scope.make();
      const gate = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const beforeCalls = batchCalls;
      batchGate.current = Option.some(gate);
      batchStarted.current = Option.some(started);

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* Scope.provide(useQuery(BatchedLookup, { ...acme, id: 4 }), firstScope);
          const second = yield* Scope.provide(
            useQuery(BatchedLookup, { ...acme, id: 5 }),
            secondScope,
          );
          yield* Deferred.await(started);
          yield* Scope.close(firstScope, Exit.void);
          yield* Deferred.succeed(gate, void 0);
          yield* settledEntry(second);
          expect(yield* second.state.get).toEqual({
            _tag: "Ready",
            value: { id: 5, round: beforeCalls + 1 },
            stale: false,
          });
          expect(batchCalls - beforeCalls).toBe(1);
        }),
        Effect.gen(function* () {
          batchGate.current = Option.none();
          batchStarted.current = Option.none();
          yield* Scope.close(firstScope, Exit.void);
          yield* Scope.close(secondScope, Exit.void);
        }),
      );
    }),
  );

  withDashboard("refreshes all active dependent keys through one batch resolver", () =>
    Effect.gen(function* () {
      const first = yield* useQuery(BatchedLookup, { ...acme, id: 6 });
      const second = yield* useQuery(BatchedLookup, { ...acme, id: 7 });
      yield* Effect.all([settledEntry(first), settledEntry(second)], { concurrency: "unbounded" });
      const beforeCalls = batchCalls;
      const book = yield* ref(OrderBook, acme);
      yield* book.call(
        { _tag: "PlaceOrder", sku: "batch-refresh", amount: 1 },
        { commandId: id("batch-refresh"), timeout: "1 second" },
      );

      expect(batchCalls - beforeCalls).toBe(1);
      expect(yield* first.state.get).toEqual({
        _tag: "Ready",
        value: { id: 6, round: beforeCalls + 1 },
        stale: false,
      });
      expect(yield* second.state.get).toEqual({
        _tag: "Ready",
        value: { id: 7, round: beforeCalls + 1 },
        stale: false,
      });
    }),
  );

  withDashboard("a command refresh failure supersedes an older read still in flight", () =>
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const firstGate = yield* Deferred.make<void>();
      const firstFinished = yield* Deferred.make<void>();
      chronologyControl.current = Option.some({
        firstStarted,
        firstGate,
        firstFinished,
        calls: 0,
      });

      yield* Effect.ensuring(
        Effect.gen(function* () {
          const chronology = yield* useQuery(Chronology, { ...acme, id: 1 });
          yield* Deferred.await(firstStarted);
          const book = yield* ref(OrderBook, acme);
          yield* book.call(
            { _tag: "PlaceOrder", sku: "chronology", amount: 1 },
            { commandId: id("chronology-failure"), timeout: "1 second" },
          );

          const failed = yield* chronology.state.get;
          expect(failed._tag).toBe("Failed");
          if (failed._tag === "Failed") {
            expect(failed.error._tag).toBe("QueryFailed");
          }

          yield* Deferred.succeed(firstGate, void 0);
          yield* Deferred.await(firstFinished);
          yield* Effect.yieldNow;
          expect(yield* chronology.state.get).toEqual(failed);
        }),
        Effect.gen(function* () {
          chronologyControl.current = Option.none();
          yield* Deferred.succeed(firstGate, void 0);
        }),
      );
    }),
  );
});

// ---------------------------------------------------------------------------
// Arguments the server cannot decode
// ---------------------------------------------------------------------------

/**
 * The same name and version as `ExchangeRate`, with a different argument
 * shape. A client built from it encodes arguments the server's contract
 * refuses. This is the only way bad arguments reach a host: a skewed build.
 */
const SkewedExchangeRate = query("ExchangeRate", {
  version: 1,
  args: Schema.Struct({ pair: Schema.Finite }),
  result: Schema.Struct({ rate: Schema.Finite }),
  policy: "public",
  depends: [],
});

describe("Query: arguments the host cannot decode", () => {
  withDashboard("are a typed refusal, not a defect in the host", () =>
    Effect.gen(function* () {
      const refused = yield* useQuery(SkewedExchangeRate, { pair: 1 });
      yield* settledEntry(refused);
      const state = yield* refused.state.get;
      expect(state._tag).toBe("Failed");
      if (state._tag === "Failed") {
        expect(state.error._tag).toBe("InvalidQueryArgs");
        if (state.error._tag === "InvalidQueryArgs") {
          expect(state.error.query).toBe("ExchangeRate");
          expect(state.error.detail).toContain("pair");
        }
      }
    }),
  );
});

// ---------------------------------------------------------------------------
// One policy for actors and queries (#20 §2)
// ---------------------------------------------------------------------------

const decodeBookKey = Schema.decodeUnknownOption(OrderBook.key);
const decodeTenantArgs = Schema.decodeUnknownOption(Revenue.args);

/** The tenant a subject names: an order book's key, or a tenant query's args. */
const tenantOf = (subject: Subject): Option.Option<string> => {
  if (subject._tag === "Actor") {
    return Option.map(decodeBookKey(subject.address.key), (key) => key.tenant);
  }
  return Option.map(decodeTenantArgs(subject.key.args), (args) => args.tenant);
};

/** A member of the tenant a subject names, by the claims the principal carries. */
const memberOfTenant = Policy.of(tenantOf, (who, tenant) =>
  Effect.succeed(who.claims["tenant"] === tenant),
);

const memberOf = (tenant: string) =>
  Authenticated.make({ subject: `${tenant}-member`, claims: { tenant } });

describe("Query: one policy for actors and queries", () => {
  it.scoped("one policy name refuses the same tenant through both a command and a query", () =>
    Effect.gen(function* () {
      const host = yield* ActorHost.make({
        implementations: [OrderBookLive],
        queries: [RevenueLive],
      }).pipe(Effect.provideService(Policies, { "tenant-member": memberOfTenant }));
      const order = yield* Effect.orDie(
        Schema.encodeEffect(OrderBook.message)({ _tag: "PlaceOrder", sku: "bolt", amount: 3 }),
      );
      const outcome = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
        Effect.map(Effect.result(effect), (result) => {
          if (result._tag === "Success") {
            return "allowed";
          }
          return result.failure._tag;
        });
      /** A command to the tenant's book, then a read of the tenant's revenue. */
      const attempt = (tenant: string, label: string) =>
        Effect.gen(function* () {
          const key = yield* Effect.orDie(Schema.encodeEffect(OrderBook.key)({ tenant }));
          const address: Address = { contract: OrderBook.name, version: OrderBook.version, key };
          const args = yield* Effect.orDie(Schema.encodeEffect(Revenue.args)({ tenant }));
          const commandId = id(`order-${label}`);
          const command = yield* outcome(host.call(address, commandId, order, "1 second", []));
          const read = yield* outcome(
            host.query({ query: Revenue.name, version: Revenue.version, args }),
          );
          return [command, read];
        });

      // A member of acme reaches acme's book both ways.
      const own = yield* attempt("acme", "own").pipe(
        Effect.provideService(CurrentPrincipal, memberOf("acme")),
      );
      expect(own).toEqual(["allowed", "allowed"]);

      // The same member is refused on another tenant, both ways, by one rule.
      const rival = yield* attempt("rival", "rival").pipe(
        Effect.provideService(CurrentPrincipal, memberOf("acme")),
      );
      expect(rival).toEqual(["Unauthorized", "Unauthorized"]);

      // Nobody in particular is refused both ways on acme's own book.
      const anonymous = yield* attempt("acme", "anonymous");
      expect(anonymous).toEqual(["Unauthorized", "Unauthorized"]);
    }),
  );
});
