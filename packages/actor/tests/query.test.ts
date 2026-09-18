import { Effect, Layer, Option, Schema } from "effect";
import { describe, expect, it } from "effect-bun-test";
import {
  ActorHost,
  Behavior,
  CommandId,
  HttpServer,
  QueryPolicies,
  implementQuery,
  implementTransparent,
} from "@effect-frame/actor";
import {
  HttpTransport,
  QueryCache,
  Unauthorized,
  contract,
  keyOf,
  query,
  queryCacheLayer,
  ref,
  useQuery,
} from "@effect-frame/actor/client";
import type { QueryPolicy } from "@effect-frame/actor";
import type { Address, QueryState } from "@effect-frame/actor/client";

/**
 * PROTOTYPE (ticket #17). The Dashboard shape: several queries, one live
 * actor, one command whose reply refreshes two queries in one round trip,
 * over the same in-process HTTP transport `tests/http.test.ts` uses.
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

const ExchangeRateLive = implementQuery(ExchangeRate, (args) =>
  Effect.succeed({ rate: Option.getOrElse(Option.fromNullishOr(rates.get(args.pair)), () => 1) }),
);

const UnpolicedLive = implementQuery(Unpoliced, () => Effect.succeed(1));

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
  [RevenueLive, TopSkuLive, ExchangeRateLive, UnpolicedLive],
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
});
