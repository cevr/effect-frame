import { registerDom } from "./dom-setup.js";

registerDom();

import { QueryCache } from "effect-frame/actor/client";
import { Effect, Option } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { routes } from "../src/routes.js";
import type { Wiretap } from "./fixture.js";
import { click, keyText, mountApp, settle, submit, tappedHost, textOf } from "./fixture.js";

/**
 * #17 and #28 at width: a command's cost is the intersection of the keys
 * on screen and its contract's dependents, stated as integers. On
 * `/d/acme` the page declares five keys. A `Fulfil` refreshes the three
 * that name `Orders`; an `Ack` refreshes the one that names `Alerts`; from
 * `/d/acme/orders` a `Fulfil` refreshes the two on that page and not
 * `Revenue`, which is not on screen; a `Write` to the memo, which no query
 * names, refreshes none and runs no handler. Each refresh arrives in the
 * command's own reply: no dependent is read a second time.
 */

const origin = "http://dashboard.test";
const overview = `${origin}/d/acme`;
const ordersPage = `${origin}/d/acme/orders`;

const tenantInfo = 'TenantInfo{"tenant":"acme"}';
const revenue = 'Revenue{"tenant":"acme"}';
const orders = 'Orders{"tenant":"acme"}';
const funnel = 'Funnel{"tenant":"acme"}';
const slowest = 'Slowest{"tenant":"acme"}';
const allOrders = 'Orders{"range":"all","tenant":"acme"}';
const orderDetail = 'OrderDetail{"tenant":"acme"}';

const onOverview = [tenantInfo, revenue, orders, funnel, slowest].toSorted();
const onOrdersPage = [tenantInfo, allOrders, orderDetail].toSorted();

/**
 * The one request of a command that declares keys: its settling `call`.
 * The admitting `send` before it declares nothing and refreshes nothing, so
 * the command's whole cost is this reply.
 */
const settlementOf = (wire: Wiretap, label: string) => {
  const seen = wire.sightingsOf(label);
  expect(seen.map((one) => one.verb)).toEqual(["send", "call"]);
  expect(seen[0]?.active).toEqual([]);
  expect(seen[0]?.refreshed).toEqual([]);
  return seen[1];
};

const activeKeys = Effect.gen(function* () {
  const cache = yield* QueryCache;
  return (yield* cache.active).map(keyText).toSorted();
});

/** The overview, painted: every card but the funnel's, whose tab is closed. */
const overviewPainted = (root: HTMLElement) =>
  settle(
    Effect.sync(
      () =>
        textOf(root, "#revenue") === "460" &&
        textOf(root, "#tenant-alerts") === "3" &&
        textOf(root, "#slowest").length > 0,
    ),
    "the overview painted",
  );

describe("single flight at width (#17, #28)", () => {
  it.scopedLive("a Fulfil from the overview refreshes exactly its three dependents", () =>
    Effect.gen(function* () {
      const { handlers, wire } = yield* tappedHost();
      const app = yield* mountApp({ transport: wire.transport, href: overview, routes });
      yield* overviewPainted(app.root);
      expect(yield* app.run(activeKeys)).toEqual(onOverview);
      const before = handlers.runs();

      yield* click(app.root, '#orders li[data-order="o6"] .fulfil');
      yield* settle(
        Effect.sync(() => textOf(app.root, "#revenue") === "490"),
        "revenue after the fulfil",
      );

      const sighting = settlementOf(wire, "Fulfil o6");
      expect(sighting?.active).toEqual(onOverview);
      expect(sighting?.refreshed).toEqual([funnel, orders, revenue]);
      // Each dependent handler ran once, for the reply; nothing else ran.
      const ran = [...handlers.runs()].map(([name, count]) => [
        name,
        count - (before.get(name) ?? 0),
      ]);
      expect(Object.fromEntries(ran)).toEqual({
        TenantInfo: 0,
        Revenue: 1,
        Orders: 1,
        Funnel: 1,
        Slowest: 0,
      });
      // The refreshed values landed from the reply: the client read none again.
      expect([revenue, orders, funnel].map(wire.readsOf)).toEqual([1, 1, 1]);
      expect(textOf(app.root, "#open")).toBe("2");
      expect(textOf(app.root, "#revenue")).toBe("490");
    }),
  );

  it.scopedLive("an Ack from the overview refreshes exactly the one query that names Alerts", () =>
    Effect.gen(function* () {
      const { handlers, wire } = yield* tappedHost();
      const app = yield* mountApp({ transport: wire.transport, href: overview, routes });
      yield* overviewPainted(app.root);
      const before = handlers.runs();

      yield* click(app.root, '#alerts li[data-alert="a1"] .ack');
      yield* settle(
        Effect.sync(() => textOf(app.root, "#tenant-alerts") === "2"),
        "the alert count after the ack",
      );

      const sighting = settlementOf(wire, "Ack a1");
      expect(sighting?.active).toEqual(onOverview);
      expect(sighting?.refreshed).toEqual([tenantInfo]);
      expect(handlers.runsOf("TenantInfo") - (before.get("TenantInfo") ?? 0)).toBe(1);
      for (const name of ["Revenue", "Orders", "Funnel", "Slowest"]) {
        expect({ name, ran: handlers.runsOf(name) - (before.get(name) ?? 0) }).toEqual({
          name,
          ran: 0,
        });
      }
      expect(wire.readsOf(tenantInfo)).toBe(1);
      // The live stream carried the ack to the alerts card.
      yield* settle(
        Effect.sync(() => textOf(app.root, '#alerts li[data-alert="a1"] .acked') === "true"),
        "the acked alert",
      );
    }),
  );

  it.scopedLive("a Fulfil from the orders page refreshes its two dependents, not Revenue", () =>
    Effect.gen(function* () {
      const { handlers, wire } = yield* tappedHost();
      const app = yield* mountApp({ transport: wire.transport, href: ordersPage, routes });
      yield* settle(
        Effect.sync(() => textOf(app.root, "#detail").includes("o7")),
        "the orders page painted",
      );
      expect(yield* app.run(activeKeys)).toEqual(onOrdersPage);
      const revenueRuns = handlers.runsOf("Revenue");

      yield* click(app.root, '#rows li[data-order="o7"] .fulfil');
      yield* settle(
        Effect.sync(() => !textOf(app.root, "#detail").includes("o7")),
        "the detail after the fulfil",
      );

      const sighting = settlementOf(wire, "Fulfil o7");
      expect(sighting?.active).toEqual(onOrdersPage);
      expect(sighting?.refreshed).toEqual([orderDetail, allOrders]);
      // Revenue is not on screen, so nothing asked for it and nothing read it.
      expect(handlers.runsOf("Revenue")).toBe(revenueRuns);
      expect(revenueRuns).toBe(0);
      expect([allOrders, orderDetail].map(wire.readsOf)).toEqual([1, 1]);
    }),
  );

  it.scopedLive(
    "a Write to the memo, which no query names, refreshes none and runs no handler",
    () =>
      Effect.gen(function* () {
        const { handlers, wire } = yield* tappedHost();
        const app = yield* mountApp({ transport: wire.transport, href: overview, routes });
        yield* overviewPainted(app.root);
        const before = handlers.runs();

        yield* Effect.sync(() => {
          const draft = app.root.querySelector("#memo-draft");
          if (draft instanceof HTMLInputElement) {
            draft.value = "ship friday";
          }
        });
        yield* submit(app.root, "#memo-form");
        yield* settle(
          Effect.sync(() => textOf(app.root, "#memo-text") === "ship friday"),
          "the memo",
        );
        yield* settle(
          Effect.sync(() => wire.settlementsOf("Write").length === 1),
          "the write's reply",
        );

        // The page declared its five keys; the host found no dependent of Memo
        // among them and answered at once: an empty reply, and no handler ran.
        const sighting = settlementOf(wire, "Write");
        expect(sighting?.active).toEqual(onOverview);
        expect(sighting?.refreshed).toEqual([]);
        expect(Option.isSome(sighting?.committed ?? Option.none())).toBe(true);
        expect(handlers.runs()).toEqual(before);
        // Nothing was marked stale: Memo is in no `depends` list.
        expect(app.root.querySelector("#revenue")?.getAttribute("class")).toBe("fresh");
      }),
  );

  it.scopedLive("a failed refresh answers RefreshFailed, and the Fulfil still commits", () =>
    Effect.gen(function* () {
      const { handlers, wire } = yield* tappedHost();
      const app = yield* mountApp({ transport: wire.transport, href: overview, routes });
      yield* overviewPainted(app.root);

      // The funnel's handler throws from now on; its tab is closed, so the
      // page shows nothing of it, but its key is on screen and declared.
      yield* handlers.fail("Funnel");
      yield* click(app.root, '#orders li[data-order="o6"] .fulfil');
      yield* settle(
        Effect.sync(() => wire.settlementsOf("Fulfil o6").length === 1),
        "the fulfil's reply",
      );

      const sighting = settlementOf(wire, "Fulfil o6");
      // The reply carries the good refreshes and the failed one side by side.
      expect(sighting?.refreshed).toEqual([funnel, orders, revenue]);
      expect(sighting?.failed).toEqual([funnel]);
      // The failure never became the command's: its receipt carries the commit.
      expect(Option.isSome(sighting?.committed ?? Option.none())).toBe(true);
      yield* settle(
        Effect.sync(() => textOf(app.root, "#revenue") === "490"),
        "revenue after the fulfil",
      );
      expect(textOf(app.root, "#open")).toBe("2");
      expect(textOf(app.root, '#orders li[data-order="o6"] span')).toBe("o6 fulfilled");
    }),
  );
});
