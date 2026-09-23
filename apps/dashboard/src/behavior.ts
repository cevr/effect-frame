import { Behavior } from "effect-frame/actor/client";
import { Match } from "effect";
import type {
  MemoMessage,
  MemoSnapshot,
  Order,
  OrdersMessage,
  OrdersSnapshot,
} from "./contract.js";

/**
 * The order book's and the memo's behaviors, hosted by the server. The page
 * commands both through send-only references, so nothing here predicts in
 * the browser. The alerts are a machine, beside their contract. Every tenant starts
 * from the same book and the same alerts: this is a memory store, not a
 * database (#25 §4).
 */

const seedOrders: ReadonlyArray<Order> = [
  { id: "o1", amount: 120, day: 1, status: "fulfilled" },
  { id: "o2", amount: 80, day: 3, status: "fulfilled" },
  { id: "o3", amount: 45, day: 5, status: "cancelled" },
  { id: "o4", amount: 200, day: 12, status: "fulfilled" },
  { id: "o5", amount: 60, day: 20, status: "fulfilled" },
  { id: "o6", amount: 30, day: 0, status: "open" },
  { id: "o7", amount: 90, day: 2, status: "open" },
  { id: "o8", amount: 150, day: 40, status: "open" },
];

const openCount = (orders: ReadonlyArray<Order>): number =>
  orders.filter((order) => order.status === "open").length;

/** Move one open order to `status`. An order that is not open stays as it is. */
const settle = (state: OrdersSnapshot, id: string, status: Order["status"]): OrdersSnapshot => {
  const orders = state.orders.map((order) => {
    if (order.id === id && order.status === "open") {
      return { ...order, status };
    }
    return order;
  });
  return { open: openCount(orders), orders };
};

export const ordersBehavior = Behavior.reducer<OrdersSnapshot, OrdersMessage>({
  initial: { open: openCount(seedOrders), orders: seedOrders },
  reduce: (state, message) =>
    Match.type<OrdersMessage>().pipe(
      Match.tagsExhaustive({
        Fulfil: (fulfil) => settle(state, fulfil.id, "fulfilled"),
        Cancel: (cancel) => settle(state, cancel.id, "cancelled"),
      }),
    )(message),
});

export const memoBehavior = Behavior.reducer<MemoSnapshot, MemoMessage>({
  initial: { text: "" },
  reduce: (_state, write) => ({ text: write.text }),
});
