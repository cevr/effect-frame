import { Actor, Behavior, Source, Value } from "effect-frame/actor/client";
import { Link, link } from "effect-frame/router";
import type { Route } from "effect-frame/router";
import { For, View } from "effect-frame/view";
import { Effect, Option } from "effect";
import { ack } from "./commands.js";
import type { Point } from "./queries.js";
import { rangeLabel } from "./queries.js";
import { overview } from "./segments.js";

/**
 * The overview: revenue, orders, the funnel behind a tab, the slowest
 * endpoints, the alerts, and the open-order count. It knows no rendering
 * mode. Every card but one registers with the shell's `Loading`; the
 * slowest endpoints have a `Loading` of their own, so the page paints
 * around the one slow read (#16).
 */

export type OverviewProps = Route.PropsOf<typeof overview>;

const total = (points: ReadonlyArray<Point>): number =>
  points.reduce((sum, point) => sum + point.total, 0);

/** Revenue, dimmed while a command on the order book is unsettled (#17). */
const RevenueCard = (props: OverviewProps) =>
  Effect.gen(function* () {
    const revenue = yield* View.readyWithStale(yield* View.orErrored(props.data.revenue.state), {
      points: [],
    });
    return (
      <section id="revenue-card" class="card">
        <h2>revenue</h2>
        <p
          id="revenue"
          class={View.bind(revenue, (shown) => {
            if (shown.stale) {
              return "stale";
            }
            return "fresh";
          })}
        >
          {View.bind(revenue, (shown) => total(shown.value.points))}
        </p>
      </section>
    );
  });

/** The orders in the window, and how many of them are open. An open one can be fulfilled here. */
const OrdersCard = (props: OverviewProps) =>
  Effect.gen(function* () {
    const shown = yield* View.ready(yield* View.orErrored(props.data.orders.state), { rows: [] });
    const rows = Source.select(shown, (result) => result.rows);
    return (
      <section id="orders-card" class="card">
        <h2>orders</h2>
        <ul id="orders">
          <For each={rows} keyBy={(order) => order.id}>
            {(order) => (
              <li data-order={View.bind(order, (value) => value.id)}>
                <span>{View.bind(order, (value) => `${value.id} ${value.status}`)}</span>
                <button
                  type="button"
                  class="fulfil"
                  onClick={View.event(
                    Effect.flatMap(order.get, (value) =>
                      Effect.flatMap(props.data.book.ref.get, (book) =>
                        Effect.asVoid(book.send({ _tag: "Fulfil", id: value.id })),
                      ),
                    ),
                  )}
                >
                  fulfil
                </button>
              </li>
            )}
          </For>
        </ul>
        <p id="open">
          {View.bind(rows, (all) => all.filter((order) => order.status === "open").length)}
        </p>
      </section>
    );
  });

/** The funnel. It mounts when its tab is revealed, after the page has painted. */
const FunnelCard = (props: OverviewProps) =>
  Effect.gen(function* () {
    const shown = yield* View.ready(yield* View.orErrored(props.data.funnel.state), { stages: [] });
    return (
      <section id="funnel-card" class="card">
        <h2>funnel</h2>
        <ul id="funnel">
          <For each={Source.select(shown, (result) => result.stages)} keyBy={(stage) => stage.name}>
            {(stage) => <li>{View.bind(stage, (value) => `${value.name} ${value.count}`)}</li>}
          </For>
        </ul>
      </section>
    );
  });

/** The slowest endpoints: the deliberately slow read, under its own `Loading`. */
const SlowestCard = (props: OverviewProps) =>
  View.loading({
    fallback: <p id="slowest-loading">measuring</p>,
    content: Effect.gen(function* () {
      const shown = yield* View.ready(yield* View.orErrored(props.data.slowest.state), {
        rows: [],
      });
      return (
        <section id="slowest-card" class="card">
          <h2>slowest</h2>
          <ul id="slowest">
            <For each={Source.select(shown, (result) => result.rows)} keyBy={(row) => row.endpoint}>
              {(row) => <li>{View.bind(row, (value) => `${value.endpoint} ${value.ms}ms`)}</li>}
            </For>
          </ul>
        </section>
      );
    }),
  });

/** The live alerts: the route's `Alerts` actor, followed as it changes. */
const AlertsCard = (props: OverviewProps) =>
  Effect.sync(() => {
    const items = Source.select(props.data.alerts.state, (snapshot) => snapshot.items);
    return (
      <section id="alerts-card" class="card">
        <h2>alerts</h2>
        <ul id="alerts">
          <For each={items} keyBy={(alert) => alert.id}>
            {(alert) => (
              <li data-alert={View.bind(alert, (value) => value.id)}>
                <span>{View.bind(alert, (value) => value.text)}</span>
                <span class="acked">{View.bind(alert, (value) => String(value.acked))}</span>
                <button
                  type="button"
                  class="ack"
                  onClick={View.event(
                    Effect.flatMap(alert.get, (value) =>
                      Effect.asVoid(ack(props.data.alerts.ref, props.data.tenant, value)),
                    ),
                  )}
                >
                  ack
                </button>
              </li>
            )}
          </For>
        </ul>
      </section>
    );
  });

export const OverviewView = (props: OverviewProps) =>
  Effect.gen(function* () {
    const week = yield* link(overview, props.params, { range: "7d" });
    const month = yield* link(overview, props.params, {});
    const ever = yield* link(overview, props.params, { range: "all" });
    const range = Source.select(props.search, (search) =>
      rangeLabel(Option.fromNullishOr(search.range)),
    );

    // The funnel tab. Its card is a row that exists only once revealed, so
    // its `ready` registers with the shell's scope after first paint.
    const revealed = yield* Actor.local(Behavior.value(false));
    const funnel = yield* View.list({
      each: Source.select(revealed.state, (open): ReadonlyArray<string> => {
        if (open) {
          return ["funnel"];
        }
        return [];
      }),
      keyBy: (name: string) => name,
      row: () => FunnelCard(props),
    });

    const revenue = yield* RevenueCard(props);
    const orders = yield* OrdersCard(props);
    const slowest = yield* SlowestCard(props);
    const alerts = yield* AlertsCard(props);
    return (
      <article id="overview">
        <nav id="ranges">
          <Link link={week}>7d</Link> <Link link={month}>30d</Link> <Link link={ever}>all</Link>
        </nav>
        <p id="range">{View.bind(range)}</p>
        {revenue}
        {orders}
        <button
          id="show-funnel"
          type="button"
          onClick={View.event(Effect.asVoid(revealed.send(Value.Set(true))))}
        >
          funnel
        </button>
        {funnel}
        {slowest}
        {alerts}
      </article>
    );
  });
