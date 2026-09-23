import { registerDom } from "./dom-setup.js";

registerDom();

import { QueryCache, useQuery } from "effect-frame/actor/client";
import { Deferred, Effect, Schema } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { TenantId } from "../src/contract.js";
import { Revenue, TenantInfo } from "../src/queries.js";
import { routes } from "../src/routes.js";
import { click, keyText, mountApp, settle, tappedHost, textOf } from "./fixture.js";

/**
 * #17 and #18 on the dashboard's queries: a layout's declaration is one
 * entry and one read for its whole branch; a key's spelling does not split its entry; and a dependent
 * holds its value, marked stale, from a command's send until the last
 * command on its contract settles.
 */

const origin = "http://dashboard.test";
const overview = `${origin}/d/acme`;
const acme = Schema.decodeSync(TenantId)("acme");

const tenantInfo = 'TenantInfo{"tenant":"acme"}';
const revenue = 'Revenue{"tenant":"acme"}';

const revenueClass = (root: HTMLElement) => root.querySelector("#revenue")?.getAttribute("class");

const painted = (root: HTMLElement) =>
  settle(
    Effect.sync(() => textOf(root, "#revenue") === "460" && textOf(root, "#slowest").length > 0),
    "the overview painted",
  );

describe("the dashboard's queries (#17, #18)", () => {
  it.scopedLive("the layout's TenantInfo is one entry and one read for a three-deep branch", () =>
    Effect.gen(function* () {
      const { handlers, wire } = yield* tappedHost();
      const app = yield* mountApp({ transport: wire.transport, href: overview, routes });
      yield* painted(app.root);
      expect(textOf(app.root, "#tenant-name")).toBe("Acme Co");

      // dash > orders > index: the orders layout inherits the binding.
      yield* app.router.navigate("/d/acme/orders");
      yield* settle(
        Effect.sync(() => textOf(app.root, "#orders-of") === "Acme Co"),
        "the orders page",
      );
      // dash > orders > order: the leaf declares the same key again.
      yield* app.router.navigate("/d/acme/orders/o7");
      yield* settle(
        Effect.sync(
          () =>
            textOf(app.root, "#order-of") === "Acme Co / o7" &&
            textOf(app.root, "#order-status") === "open",
        ),
        "the order page",
      );
      yield* app.router.navigate("/d/acme");
      yield* painted(app.root);

      // Four pages, four views reading it, three deep, and one read of one key.
      expect(wire.readsOf(tenantInfo)).toBe(1);
      expect(handlers.runsOf("TenantInfo")).toBe(1);
      const active = yield* app.run(Effect.flatMap(QueryCache, (cache) => cache.active));
      expect(active.filter((key) => key.query === "TenantInfo").map(keyText)).toEqual([tenantInfo]);
    }),
  );

  it.scopedLive("every declaration starts before the slowest one is released", () =>
    Effect.gen(function* () {
      const { handlers, wire } = yield* tappedHost();
      const slow = yield* handlers.hold("Slowest");
      const app = yield* mountApp({ transport: wire.transport, href: overview, routes });
      // The overview branch declares six: the layout's TenantInfo, four
      // queries, and the Alerts actor. Slowest is held in its handler.
      const started = () => [
        ...["TenantInfo", "Revenue", "Orders", "Funnel", "Slowest"].filter((name) =>
          wire.reads.some((key) => key.startsWith(`${name}{`)),
        ),
        ...wire.snapshots.filter((address) => address.startsWith("Alerts{")).map(() => "Alerts"),
      ];
      yield* settle(
        Effect.sync(() => started().length === 6),
        "all six declarations started",
      );
      // All six are in flight or done while the slowest has not answered.
      expect(started()).toEqual(["TenantInfo", "Revenue", "Orders", "Funnel", "Slowest", "Alerts"]);
      expect(handlers.runsOf("Slowest")).toBe(1);
      expect(textOf(app.root, "#slowest")).toBe("");

      yield* Deferred.succeed(slow, void 0);
      yield* painted(app.root);
    }),
  );

  it.scopedLive("reordered arguments name one entry: its key is canonical", () =>
    Effect.gen(function* () {
      const { handlers, wire } = yield* tappedHost();
      const app = yield* mountApp({
        transport: wire.transport,
        href: `${overview}?range=7d`,
        routes,
      });
      yield* settle(
        Effect.sync(() => textOf(app.root, "#revenue") === "200"),
        "the week's revenue",
      );
      // A second declaration spells the route's arguments in the other order.
      const again = yield* app.run(useQuery(Revenue, { range: "7d", tenant: acme }));
      expect(keyText(again.key)).toBe('Revenue{"range":"7d","tenant":"acme"}');
      yield* settle(
        Effect.map(again.state.get, (state) => state._tag === "Ready"),
        "the second declaration",
      );
      const active = yield* app.run(Effect.flatMap(QueryCache, (cache) => cache.active));
      expect(active.filter((key) => key.query === "Revenue").map(keyText)).toEqual([
        'Revenue{"range":"7d","tenant":"acme"}',
      ]);
      expect(handlers.runsOf("Revenue")).toBe(1);
      expect(wire.readsOf('Revenue{"range":"7d","tenant":"acme"}')).toBe(1);
    }),
  );

  it.scopedLive(
    "revenue stays on screen, marked stale, from the Fulfil's send until its reply",
    () =>
      Effect.gen(function* () {
        const { handlers, wire } = yield* tappedHost();
        const app = yield* mountApp({ transport: wire.transport, href: overview, routes });
        yield* painted(app.root);
        expect(revenueClass(app.root)).toBe("fresh");

        const held = yield* wire.holdSend("Fulfil o6");
        yield* click(app.root, '#orders li[data-order="o6"] .fulfil');
        // Sent and not yet admitted: the old figure, dimmed.
        yield* settle(
          Effect.sync(() => revenueClass(app.root) === "stale"),
          "revenue stale on send",
        );
        expect(textOf(app.root, "#revenue")).toBe("460");
        expect(wire.commands).toEqual([]);
        yield* Effect.sleep("100 millis");
        expect([textOf(app.root, "#revenue"), revenueClass(app.root)]).toEqual(["460", "stale"]);

        yield* wire.open(held);
        yield* settle(
          Effect.sync(
            () => textOf(app.root, "#revenue") === "490" && revenueClass(app.root) === "fresh",
          ),
          "revenue refreshed",
        );
        // The reply's refresh was the only second read: the client read once.
        expect(wire.readsOf(revenue)).toBe(1);
        expect(handlers.runsOf("Revenue")).toBe(2);
      }),
  );

  it.scopedLive("with two Fulfils in flight, the first reply does not clear stale", () =>
    Effect.gen(function* () {
      const { wire } = yield* tappedHost();
      const app = yield* mountApp({ transport: wire.transport, href: overview, routes });
      yield* painted(app.root);

      const first = yield* wire.holdSend("Fulfil o6");
      const second = yield* wire.holdSend("Fulfil o7");
      yield* click(app.root, '#orders li[data-order="o6"] .fulfil');
      yield* click(app.root, '#orders li[data-order="o7"] .fulfil');
      yield* settle(
        Effect.sync(() => revenueClass(app.root) === "stale"),
        "stale on send",
      );

      yield* wire.open(first);
      yield* settle(
        Effect.sync(
          () =>
            wire.settlementsOf("Fulfil o6").length === 1 && textOf(app.root, "#revenue") === "490",
        ),
        "the first reply landed",
      );
      // The first command's value is on screen, but the second still owns it.
      yield* Effect.sleep("100 millis");
      expect([textOf(app.root, "#revenue"), revenueClass(app.root)]).toEqual(["490", "stale"]);

      yield* wire.open(second);
      yield* settle(
        Effect.sync(
          () => textOf(app.root, "#revenue") === "580" && revenueClass(app.root) === "fresh",
        ),
        "both settled",
      );
    }),
  );
});

describe("an ack's override on the header (#17, #19 §4)", () => {
  const alertsShown = (root: HTMLElement) => [
    textOf(root, "#tenant-alerts"),
    root.querySelector("#tenant-alerts")?.getAttribute("class"),
  ];
  /** An authoritative read of the header's entry, as any other declaration would make. */
  const refreshHeader = Effect.flatMap(
    useQuery(TenantInfo, { tenant: acme }),
    (header) => header.refresh,
  );

  it.scopedLive("the override shows at once, stale, and the ack's refresh replaces it", () =>
    Effect.gen(function* () {
      const { handlers, wire } = yield* tappedHost();
      const app = yield* mountApp({ transport: wire.transport, href: overview, routes });
      yield* painted(app.root);
      expect(alertsShown(app.root)).toEqual(["3", "fresh"]);

      const held = yield* wire.holdSend("Ack a1");
      yield* click(app.root, '#alerts li[data-alert="a1"] .ack');
      // The host has seen nothing and no handler ran: the 2 is the page's guess.
      yield* settle(
        Effect.sync(() => textOf(app.root, "#tenant-alerts") === "2"),
        "the override on screen",
      );
      expect(alertsShown(app.root)).toEqual(["2", "stale"]);
      expect(wire.commands).toEqual([]);
      expect(handlers.runsOf("TenantInfo")).toBe(1);

      yield* wire.open(held);
      yield* settle(
        Effect.sync(() => alertsShown(app.root)[1] === "fresh"),
        "the ack's refresh",
      );
      expect(alertsShown(app.root)).toEqual(["2", "fresh"]);
      // The authoritative 2 came in the ack's reply: one more run, no client read.
      expect(handlers.runsOf("TenantInfo")).toBe(2);
      expect(wire.readsOf(tenantInfo)).toBe(1);
    }),
  );

  it.scopedLive("any authoritative value drops the override, before the ack lands", () =>
    Effect.gen(function* () {
      const { wire } = yield* tappedHost();
      const app = yield* mountApp({ transport: wire.transport, href: overview, routes });
      yield* painted(app.root);

      const held = yield* wire.holdSend("Ack a1");
      yield* click(app.root, '#alerts li[data-alert="a1"] .ack');
      yield* settle(
        Effect.sync(() => textOf(app.root, "#tenant-alerts") === "2"),
        "the override on screen",
      );
      // An unrelated read: the host has not admitted the ack, so it says 3.
      yield* app.run(refreshHeader);
      yield* settle(
        Effect.sync(() => textOf(app.root, "#tenant-alerts") === "3"),
        "the authoritative 3",
      );
      // Still stale: the ack is unsettled.
      expect(alertsShown(app.root)).toEqual(["3", "stale"]);

      yield* wire.open(held);
      yield* settle(
        Effect.sync(() => alertsShown(app.root).join() === "2,fresh"),
        "the ack's refresh",
      );
    }),
  );

  it.scopedLive(
    "a Rejected ack leaves the override; the next authoritative value replaces it",
    () =>
      Effect.gen(function* () {
        const { wire } = yield* tappedHost();
        const app = yield* mountApp({ transport: wire.transport, href: overview, routes });
        yield* painted(app.root);

        // a3 is pinned: the host refuses its ack before admission.
        yield* click(app.root, '#alerts li[data-alert="a3"] .ack');
        yield* settle(
          Effect.sync(() => wire.failedSends.includes("Ack a3")),
          "the refused ack's reply",
        );
        yield* Effect.sleep("100 millis");
        yield* settle(Effect.succeed(true), "one more flush");
        // Not rolled back: the guess stays until something authoritative arrives.
        expect(textOf(app.root, "#tenant-alerts")).toBe("2");
        expect(textOf(app.root, '#alerts li[data-alert="a3"] .acked')).toBe("false");

        yield* app.run(refreshHeader);
        yield* settle(
          Effect.sync(() => alertsShown(app.root).join() === "3,fresh"),
          "the authoritative 3",
        );
      }),
  );
});
