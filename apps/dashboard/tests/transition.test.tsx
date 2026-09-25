import { registerDom } from "./dom-setup.js";

registerDom();

import { QueryCache } from "effect-frame/actor/client";
import { followLinks } from "effect-frame/router";
import { Deferred, Effect, Fiber, Option } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { routes } from "../src/routes.js";
import { keyText, member, mountApp, settle, tappedHost, textOf } from "./fixture.js";

/**
 * #28 on the dashboard: `active` is the keys the mounted branch declares.
 * During a transition the exited leaf and the entering leaf both count, so
 * a command sent mid-move refreshes either page; after it, only the new
 * leaf and the layout remain. A long session never accumulates keys, and
 * the layout's `TenantInfo`, shared by every leaf, is never read again.
 */

const origin = "http://dashboard.test";

const tenantInfo = 'TenantInfo{"tenant":"acme"}';
/** The overview's four keys for a range; the empty range is the key with no `range`. */
const overviewKeys = (range: string) => {
  const args = argsFor(range);
  return [`Revenue${args}`, `Orders${args}`, `Funnel${args}`, 'Slowest{"tenant":"acme"}'];
};
const argsFor = (range: string): string => {
  if (range === "") {
    return '{"tenant":"acme"}';
  }
  return `{"range":"${range}","tenant":"acme"}`;
};
const ordersKeys = ['Orders{"range":"all","tenant":"acme"}', 'OrderDetail{"tenant":"acme"}'];

const sorted = (keys: ReadonlyArray<string>) => [...new Set(keys)].toSorted();

const activeKeys = Effect.flatMap(QueryCache, (cache) =>
  Effect.map(cache.active, (keys) => keys.map(keyText).toSorted()),
);

describe("active follows the mounted branch (#28)", () => {
  it.scopedLive("active names both leaves while the overview enters, and one after", () =>
    Effect.gen(function* () {
      const { wire } = yield* tappedHost();
      const app = yield* mountApp({
        transport: wire.transport,
        href: `${origin}/d/acme/orders`,
        routes,
      });
      yield* settle(
        Effect.sync(() => textOf(app.root, "#detail").includes("o6")),
        "the orders page",
      );
      expect(yield* app.run(activeKeys)).toEqual(sorted([tenantInfo, ...ordersKeys]));

      // The overview enters holding on its alerts actor's first snapshot,
      // which the orders page does not bind.
      const alerts = yield* wire.holdSnapshot("Alerts");
      const moving = yield* Effect.forkChild(app.router.push("/d/acme"));
      yield* settle(
        Effect.sync(() => wire.snapshots.some((address) => address.startsWith("Alerts"))),
        "the entering alerts snapshot",
      );
      expect(yield* app.run(activeKeys)).toEqual(
        sorted([tenantInfo, ...ordersKeys, ...overviewKeys("")]),
      );
      // The navigation is still in flight, and the orders page still on screen.
      yield* Effect.sleep("50 millis");
      expect(moving.pollUnsafe()).toBeUndefined();
      expect(textOf(app.root, "#orders-of")).toBe("Acme Co");

      yield* wire.open(alerts);
      yield* Fiber.join(moving);
      yield* settle(
        Effect.sync(() => textOf(app.root, "#revenue") === "460"),
        "the overview",
      );
      expect(yield* app.run(activeKeys)).toEqual(sorted([tenantInfo, ...overviewKeys("")]));
      expect(wire.readsOf(tenantInfo)).toBe(1);
    }),
  );

  it.scopedLive("a session of 50 navigations declares only the current branch", () =>
    Effect.gen(function* () {
      const { handlers, wire } = yield* tappedHost();
      const app = yield* mountApp({ transport: wire.transport, href: `${origin}/d/acme`, routes });
      yield* settle(
        Effect.sync(() => textOf(app.root, "#revenue") === "460"),
        "the overview",
      );
      const stops = [
        { path: "/d/acme/orders", keys: ordersKeys },
        { path: "/d/acme?range=7d", keys: overviewKeys("7d") },
        { path: "/d/acme?range=all", keys: overviewKeys("all") },
        { path: "/d/acme/orders", keys: ordersKeys },
        { path: "/d/acme", keys: overviewKeys("") },
      ];
      const most = { current: 0 };
      // Ten rounds of five stops: fifty navigations.
      let step = 0;
      for (let round = 0; round < 10; round += 1) {
        for (const stop of stops) {
          step += 1;
          yield* app.router.push(stop.path);
          const now = yield* app.run(activeKeys);
          expect({ step, active: now }).toEqual({
            step,
            active: sorted([tenantInfo, ...stop.keys]),
          });
          most.current = Math.max(most.current, now.length);
        }
      }
      expect(step).toBe(50);
      // One layout key and at most four leaf keys: never more than one branch.
      expect(most.current).toBe(5);
      // The layout's entry lived through every step: one read, one run.
      expect(wire.readsOf(tenantInfo)).toBe(1);
      expect(handlers.runsOf("TenantInfo")).toBe(1);
    }),
  );

  it.scopedLive(
    "a key two segments declare: the leaf exits, it stays; the layout's moves, it goes",
    () =>
      Effect.gen(function* () {
        const { handlers, wire } = yield* tappedHost(member("acme", "globex"));
        const app = yield* mountApp({
          transport: wire.transport,
          href: `${origin}/d/acme/orders/o7`,
          routes,
        });
        yield* settle(
          Effect.sync(() => textOf(app.root, "#order-of") === "Acme Co / o7"),
          "the order page",
        );
        // The dash layout and the order leaf both declare TenantInfo{acme}: one entry.
        expect(yield* app.run(activeKeys)).toEqual(
          sorted([tenantInfo, 'Orders{"range":"all","tenant":"acme"}']),
        );

        // The order leaf exits. The layout still declares the key: it stays, unread.
        yield* app.router.push("/d/acme/orders");
        yield* settle(
          Effect.sync(() => textOf(app.root, "#detail").includes("o7")),
          "the orders index",
        );
        expect(yield* app.run(activeKeys)).toEqual(sorted([tenantInfo, ...ordersKeys]));
        expect(handlers.runsOf("TenantInfo")).toBe(1);

        // Back to the order, then to another tenant: the layout's acme
        // declaration exits with the leaf's, and the key goes.
        yield* app.router.push("/d/acme/orders/o7");
        yield* app.router.push("/d/globex");
        yield* settle(
          Effect.sync(() => textOf(app.root, "#tenant-name") === "Globex"),
          "the other tenant",
        );
        const now = yield* app.run(activeKeys);
        expect(now.filter((key) => key.startsWith("TenantInfo"))).toEqual([
          'TenantInfo{"tenant":"globex"}',
        ]);
        expect(wire.readsOf(tenantInfo)).toBe(1);
      }),
  );
});

/** Click the link `selector` names with the primary button, as a reader does. */
const follow = (root: ParentNode, selector: string) =>
  Effect.sync(() => {
    const found = Option.getOrThrowWith(
      Option.fromNullishOr(root.querySelector(selector)),
      () => `no ${selector}`,
    );
    found.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  });

describe("the banner links move between the branches", () => {
  it.scopedLive(
    "overview to orders: the orders layout enters while its read is in flight, and draws",
    () =>
      Effect.gen(function* () {
        const { handlers, wire } = yield* tappedHost();
        const app = yield* mountApp({
          transport: wire.transport,
          href: `${origin}/d/acme`,
          routes,
        });
        yield* followLinks(app.root, app.router);
        yield* settle(
          Effect.sync(() => textOf(app.root, "#revenue") === "460"),
          "the overview",
        );

        // The orders layout's read of every order is still in flight when it
        // enters, so its `ready` registers unsettled under the shell's `Loading`.
        const orders = yield* handlers.hold("Orders");
        yield* follow(app.root, 'nav a[href="/d/acme/orders"]');
        yield* settle(
          Effect.map(app.current, (url) => url.pathname === "/d/acme/orders"),
          "the orders URL",
        );
        yield* Deferred.succeed(orders, void 0);

        yield* settle(
          Effect.sync(() => textOf(app.root, "#detail").includes("o6")),
          "the orders page",
        );
        expect(textOf(app.root, "#orders-of")).toBe("Acme Co");
        // Every order, the range "all" the layout declares.
        const rows = Array.from(app.root.querySelectorAll("#rows li"), (row) =>
          row.getAttribute("data-order"),
        );
        expect(rows).toEqual(["o1", "o2", "o3", "o4", "o5", "o6", "o7", "o8"]);
        expect(textOf(app.root, "#revenue")).toBe("");
      }),
  );
});
