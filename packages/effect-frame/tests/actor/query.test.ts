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
  QueryPolicies,
  implementQuery,
  implementTransparent,
} from "effect-frame/actor";
import {
  HttpTransport,
  QueryCache,
  Unauthorized,
  contract,
  followQuery,
  keyOf,
  query,
  queryCacheLayer,
  ref,
  useQuery,
} from "effect-frame/actor/client";
import type { QueryPolicy } from "effect-frame/actor";
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

/** Reads nothing an actor owns, so no commit refreshes it. */
const ExchangeRate = query("ExchangeRate", {
  version: 1,
  args: Schema.Struct({ pair: Schema.String }),
  result: Schema.Struct({ rate: Schema.Finite }),
  policy: "public",
  depends: [],
});

/** Counts server reads, so a test can prove one read served two declarations. */
const Counted = query("Counted", {
  version: 1,
  args: Schema.Struct({ tenant: Schema.String }),
  result: Schema.Finite,
  policy: "public",
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

const readBook = (tenant: string) =>
  Effect.gen(function* () {
    const book = yield* ref(OrderBook, { tenant });
    return yield* book.state.get;
  });

const RevenueLive = implementQuery(Revenue, (args) =>
  Effect.map(readBook(args.tenant), (state) => ({ total: state.revenue })),
);

const TopSkuLive = implementQuery(TopSku, (args) =>
  Effect.map(readBook(args.tenant), (state) => ({
    sku: state.lastSku,
    orders: state.count,
  })),
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

/** Only the acme tenant may read a tenant-scoped query. */
const tenantMember: QueryPolicy = {
  check: (key) => {
    if (key.args.includes('"acme"')) {
      return Effect.void;
    }
    return Effect.fail(Unauthorized.make({ contract: key.query }));
  },
};

const policies = Layer.succeed(
  QueryPolicies,
  QueryPolicies.of({ "tenant-member": tenantMember, public: { check: () => Effect.void } }),
);

const acmeOnly = Layer.succeed(ActorHost.Authorizer, {
  authorize: (address: Address) => {
    if (address.key.includes('"acme"')) {
      return Effect.void;
    }
    return Effect.fail(Unauthorized.make({ contract: address.contract }));
  },
});

const id = Schema.decodeSync(CommandId);
const acme = { tenant: "acme" };

// ---------------------------------------------------------------------------
// Wiring: one host serves actors and queries. The handlers read actors
// through the host's own transport, so a query sees the instances a command
// mutated. A second host would have opened a second set of instances.
// ---------------------------------------------------------------------------

const hostLayer = ActorHost.layerMemory(
  [OrderBookLive, HeartbeatLive],
  [RevenueLive, TopSkuLive, ExchangeRateLive, UnpolicedLive, CountedLive],
).pipe(Layer.provide(acmeOnly), Layer.provide(policies));

const inProcess = Layer.unwrap(
  Effect.gen(function* () {
    const server = yield* HttpServer.make;
    const context = yield* Effect.context<never>();
    const run = Effect.runPromiseWith(context);
    const fetch: HttpTransport.FetchLike = (input, init) => run(server(new Request(input, init)));
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

      // One command. Its reply carries both dependent queries, refreshed.
      yield* book.call(
        { _tag: "PlaceOrder", sku: "widget", amount: 30 },
        { commandId: id("order-1"), timeout: "1 second" },
      );

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

  withDashboard("a commit to an actor no query depends on refreshes nothing", () =>
    Effect.gen(function* () {
      const revenue = yield* useQuery(Revenue, acme);
      yield* settledEntry(revenue);
      const heartbeat = yield* ref(Heartbeat, acme);
      yield* heartbeat.call({ _tag: "Ping" }, { commandId: id("beat-1"), timeout: "1 second" });
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
      const Pair = query("Pair", {
        version: 1,
        args: Schema.Struct({ b: Schema.String, a: Schema.String }),
        result: Schema.String,
        policy: "public",
        depends: [],
      });
      const first = yield* useQuery(Pair, { a: "1", b: "2" });
      const second = yield* useQuery(Pair, { b: "2", a: "1" });
      expect(keyOf(first.key)).toBe(keyOf(second.key));
      expect(first.key.args).toBe('{"a":"1","b":"2"}');
    }),
  );

  withDashboard("an explicit override shows a value as stale until a refresh lands", () =>
    Effect.gen(function* () {
      const revenue = yield* useQuery(Revenue, acme);
      yield* settledEntry(revenue);
      yield* revenue.override({ total: 999 });
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

  withDashboard("the host refuses a query whose policy it cannot resolve", () =>
    Effect.gen(function* () {
      const refused = yield* useQuery(Unpoliced, acme);
      yield* settledEntry(refused);
      const state = yield* refused.state.get;
      expect(state._tag).toBe("Failed");
      if (state._tag === "Failed") {
        expect(state.error._tag).toBe("PolicyMissing");
      }
    }),
  );

  withDashboard("a policy denies a read the Authorizer would also deny", () =>
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
