import { registerDom } from "./dom-setup.js";

registerDom();

import { QueryCache } from "effect-frame/actor/client";
import { Effect, Fiber } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { routes } from "../src/routes.js";
import { keyText, mountApp, settle, tappedHost, textOf } from "./fixture.js";

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
      const moving = yield* Effect.forkChild(app.router.navigate("/d/acme"));
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
          yield* app.router.navigate(stop.path);
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
});
