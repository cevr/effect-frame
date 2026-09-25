import { Source } from "effect-frame/actor/client";
import type { QueryState } from "effect-frame/actor/client";
import type { Route } from "effect-frame/router";
import { For, View } from "effect-frame/view";
import { Effect, Option } from "effect";
import type { TenantInfoValue } from "./commands.js";
import type { Order, OrdersMessage } from "./contract.js";
import type { order, orders, ordersIndex } from "./segments.js";

/**
 * The orders branch: a layout and two leaves under the dashboard's shell,
 * three deep. Every view here inherits the shell's `TenantInfo` binding:
 * one entry for the whole branch. A `Fulfil` here refreshes `Orders` and
 * `OrderDetail`, and not `Revenue`, which is not on screen (#17, #28).
 */

/** The tenant's name, once its header has loaded. */
const nameOf = (state: QueryState<TenantInfoValue, unknown>): string => {
  if (state._tag === "Ready") {
    return state.value.name;
  }
  return "";
};

/** The status of the order `id` names, or nothing when it is not in the book. */
const statusOf = (id: string, rows: ReadonlyArray<Order>): string =>
  Option.match(Option.fromNullishOr(rows.find((row) => row.id === id)), {
    onNone: () => "no such order",
    onSome: (row) => row.status,
  });

/** Every order, which both leaves sit under. Each can be fulfilled or cancelled here. */
export const OrdersLayout = <ChildR,>(props: Route.LayoutPropsOf<typeof orders, ChildR>) =>
  Effect.gen(function* () {
    // The order book is commanded, not drawn: a send-only route binding.
    const send = (message: OrdersMessage) =>
      Effect.flatMap(props.data.book.ref.get, (book) => Effect.asVoid(book.send(message)));
    const all = yield* View.ready(yield* View.orErrored(props.data.orders.state), { rows: [] });
    const outlet = yield* props.outlet;
    return (
      <article id="orders-page">
        <h2 id="orders-of">{View.bind(props.data.tenant.state, nameOf)}</h2>
        <ul id="rows">
          <For each={Source.select(all, (result) => result.rows)} keyBy={(row) => row.id}>
            {(row) => (
              <li data-order={View.bind(row, (value) => value.id)}>
                <span>{View.bind(row, (value) => `${value.id} ${value.status}`)}</span>
                <button
                  type="button"
                  class="fulfil"
                  onClick={View.event(
                    Effect.flatMap(row.get, (value) => send({ _tag: "Fulfil", id: value.id })),
                  )}
                >
                  fulfil
                </button>
                <button
                  type="button"
                  class="cancel"
                  onClick={View.event(
                    Effect.flatMap(row.get, (value) => send({ _tag: "Cancel", id: value.id })),
                  )}
                >
                  cancel
                </button>
              </li>
            )}
          </For>
        </ul>
        {outlet}
      </article>
    );
  });

/** The open orders, oldest first. */
export const OrdersIndex = (props: Route.PropsOf<typeof ordersIndex>) =>
  Effect.gen(function* () {
    const detail = yield* View.ready(yield* View.orErrored(props.data.detail.state), { rows: [] });
    return (
      <ul id="detail">
        <For each={Source.select(detail, (result) => result.rows)} keyBy={(row) => row.id}>
          {(row) => <li>{View.bind(row, (value) => `${value.id} ${value.amount}`)}</li>}
        </For>
      </ul>
    );
  });

/**
 * One order. Its heading reads the leaf's own `TenantInfo` declaration,
 * the key the shell already holds: no second entry and no second read.
 */
export const OrderView = (props: Route.PropsOf<typeof order>) =>
  Effect.gen(function* () {
    const info = yield* View.ready(yield* View.orErrored(props.data.info.state), {
      name: "",
      plan: "",
      alerts: 0,
    });
    const all = yield* View.ready(yield* View.orErrored(props.data.orders.state), { rows: [] });
    const status = Source.zip(props.params, all, (now, result) => statusOf(now.order, result.rows));
    return (
      <section id="order">
        <h3 id="order-of">
          {View.bind(
            Source.zip(info, props.params, (value, now) => `${value.name} / ${now.order}`),
          )}
        </h3>
        <p id="order-status">{View.bind(status)}</p>
      </section>
    );
  });
