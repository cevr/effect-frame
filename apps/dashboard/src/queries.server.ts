import { implementQuery } from "effect-frame/actor";
import { ref } from "effect-frame/actor/client";
import { Context, Effect, Option } from "effect";
import type { Duration } from "effect";
import type { TenantId } from "./contract.js";
import { Alerts, Orders } from "./contract.js";
import type { Latency } from "./queries.js";
import { Funnel, OrderDetail, OrderList, Revenue, Slowest, TenantInfo, within } from "./queries.js";

/**
 * The query handlers (#17). A server module: a browser entry that reaches
 * it fails `bun run boundary`. The order and alert handlers read their
 * actor through the host they run in, as a client would; the tenant
 * directory and the latency table are data no actor owns.
 */

const ordersOf = (tenant: TenantId) =>
  Effect.flatMap(ref(Orders, { tenant }), (book) =>
    Effect.map(book.state.get, (snapshot) => snapshot.orders),
  ).pipe(Effect.scoped);

const directory = new Map([
  ["acme", { name: "Acme Co", plan: "growth" }],
  ["globex", { name: "Globex", plan: "enterprise" }],
]);

export const TenantInfoLive = implementQuery(TenantInfo, {
  run: ({ tenant }) =>
    Effect.gen(function* () {
      const found = Option.fromNullishOr(directory.get(tenant));
      if (Option.isNone(found)) {
        return yield* Effect.fail(`no tenant ${tenant}`);
      }
      const alerts = yield* ref(Alerts, { tenant });
      const snapshot = yield* alerts.state.get;
      return { ...found.value, alerts: snapshot.items.filter((item) => !item.acked).length };
    }).pipe(Effect.scoped),
});

export const RevenueLive = implementQuery(Revenue, {
  run: (args) =>
    Effect.map(ordersOf(args.tenant), (orders) => {
      const totals = new Map<number, number>();
      for (const order of orders.filter(within(Option.fromNullishOr(args.range)))) {
        if (order.status === "fulfilled") {
          totals.set(order.day, (totals.get(order.day) ?? 0) + order.amount);
        }
      }
      const points = [...totals.entries()]
        .map(([day, total]) => ({ day, total }))
        .toSorted((left, right) => left.day - right.day);
      return { points };
    }),
});

export const OrderListLive = implementQuery(OrderList, {
  run: (args) =>
    Effect.map(ordersOf(args.tenant), (orders) => ({
      rows: orders.filter(within(Option.fromNullishOr(args.range))),
    })),
});

export const FunnelLive = implementQuery(Funnel, {
  run: (args) =>
    Effect.map(ordersOf(args.tenant), (orders) => {
      const shown = orders.filter(within(Option.fromNullishOr(args.range)));
      const count = (status: string) => shown.filter((order) => order.status === status).length;
      return {
        stages: [
          { name: "placed", count: shown.length },
          { name: "open", count: count("open") },
          { name: "fulfilled", count: count("fulfilled") },
          { name: "cancelled", count: count("cancelled") },
        ],
      };
    }),
});

/**
 * How long the latency scan takes. It is the deliberately slow card: the
 * page paints around it. A test that holds the read itself sets it to zero.
 */
export const ScanTime = Context.Reference<Duration.Input>(
  "@effect-frame/example-dashboard/ScanTime",
  { defaultValue: () => "1200 millis" },
);

const latency: ReadonlyArray<Latency> = [
  { endpoint: "POST /checkout", ms: 2140 },
  { endpoint: "GET /orders", ms: 880 },
  { endpoint: "GET /search", ms: 610 },
];

export const SlowestLive = implementQuery(Slowest, {
  run: () =>
    Effect.andThen(Effect.flatMap(ScanTime, Effect.sleep), Effect.succeed({ rows: latency })),
});

export const OrderDetailLive = implementQuery(OrderDetail, {
  run: ({ tenant }) =>
    Effect.map(ordersOf(tenant), (orders) => ({
      rows: orders
        .filter((order) => order.status === "open")
        .toSorted((left, right) => right.day - left.day),
    })),
});

/** Every handler the host serves. A test taps these, as it taps the transport. */
export const queries = [
  TenantInfoLive,
  RevenueLive,
  OrderListLive,
  FunnelLive,
  SlowestLive,
  OrderDetailLive,
];
