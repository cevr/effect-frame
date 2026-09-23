import { select } from "effect-frame/actor/client";
import type { Route } from "effect-frame/router";
import { For, View, orErrored, ready } from "effect-frame/view";
import { Effect } from "effect";
import { cancel, fulfil } from "./commands.js";
import type { Order } from "./contract.js";
import type { orders } from "./segments.js";

/**
 * Every order, and the open ones in detail. It inherits the layout's
 * `TenantInfo` binding with the shell: one entry for the whole branch. A
 * `Fulfil` here refreshes `Orders` and `OrderDetail`, and not `Revenue`,
 * which is not on screen (#17, #28).
 */

export type OrdersProps = Route.PropsOf<typeof orders>;

export const OrdersView = (props: OrdersProps) =>
  Effect.gen(function* () {
    const all = yield* ready(yield* orErrored(props.data.orders.state), { rows: [] });
    const detail = yield* ready(yield* orErrored(props.data.detail.state), { rows: [] });
    const tenant = select(props.data.tenant.state, (state) => {
      if (state._tag === "Ready") {
        return state.value.name;
      }
      return "";
    });
    return (
      <article id="orders-page">
        <h2 id="orders-of">{View.bind(tenant)}</h2>
        <ul id="rows">
          <For each={select(all, (result) => result.rows)} keyBy={(order: Order) => order.id}>
            {(order) => (
              <li data-order={View.bind(order, (value) => value.id)}>
                <span>{View.bind(order, (value) => `${value.id} ${value.status}`)}</span>
                <button
                  type="button"
                  class="fulfil"
                  onClick={View.event(() =>
                    Effect.flatMap(order.get, (value) =>
                      Effect.asVoid(fulfil(props.data.book, value.id)),
                    ),
                  )}
                >
                  fulfil
                </button>
                <button
                  type="button"
                  class="cancel"
                  onClick={View.event(() =>
                    Effect.flatMap(order.get, (value) =>
                      Effect.asVoid(cancel(props.data.book, value.id)),
                    ),
                  )}
                >
                  cancel
                </button>
              </li>
            )}
          </For>
        </ul>
        <ul id="detail">
          <For each={select(detail, (result) => result.rows)} keyBy={(order: Order) => order.id}>
            {(order) => <li>{View.bind(order, (value) => `${value.id} ${value.amount}`)}</li>}
          </For>
        </ul>
      </article>
    );
  });
