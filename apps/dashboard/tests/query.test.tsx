import { registerDom } from "./dom-setup.js";

registerDom();

import { QueryCache, useQuery } from "effect-frame/actor/client";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { TenantId } from "../src/contract.js";
import { Revenue } from "../src/queries.js";
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
  it.scopedLive("the layout's TenantInfo is one entry and one read for the whole branch", () =>
    Effect.gen(function* () {
      const { handlers, wire } = yield* tappedHost();
      const app = yield* mountApp({ transport: wire.transport, href: overview, routes });
      yield* painted(app.root);
      expect(textOf(app.root, "#tenant-name")).toBe("Acme Co");

      // The orders leaf inherits the binding: its heading reads the same entry.
      yield* app.router.navigate("/d/acme/orders");
      yield* settle(
        Effect.sync(() => textOf(app.root, "#orders-of") === "Acme Co"),
        "the orders page",
      );
      yield* app.router.navigate("/d/acme");
      yield* painted(app.root);

      // Three pages, two views reading it, and one read of one key.
      expect(wire.readsOf(tenantInfo)).toBe(1);
      expect(handlers.runsOf("TenantInfo")).toBe(1);
      const active = yield* app.run(Effect.flatMap(QueryCache, (cache) => cache.active));
      expect(active.filter((key) => key.query === "TenantInfo").map(keyText)).toEqual([tenantInfo]);
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
