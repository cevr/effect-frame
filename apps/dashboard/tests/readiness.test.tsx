import { registerDom } from "./dom-setup.js";

registerDom();

import { Effect } from "effect";
import { render } from "effect-frame/view";
import { describe, expect, it } from "effect-bun-test";
import { routes } from "../src/routes.js";
import { click, has, mountApp, settle, tappedHost, textOf } from "./fixture.js";

/**
 * #16 on the overview. The shell's `Loading` holds the page; the slowest
 * endpoints have a nested `Loading` of their own, so one slow read holds one
 * card while every other card paints. The funnel card mounts on a tab
 * reveal after first paint: its read registers with the shell's scope late,
 * the scope goes pending again, and settles. A failing read settles its
 * `Loading` too, so the page shows one fallback and never hangs.
 */

const overview = "http://dashboard.test/d/acme";

/** The cards of the overview that are not the slow one, and what each shows. */
const paintedCards = (root: HTMLElement) => ({
  tenant: textOf(root, "#tenant-name"),
  memo: has(root, "#memo-form"),
  revenue: textOf(root, "#revenue"),
  orders: root.querySelectorAll("#orders li").length,
  open: textOf(root, "#open"),
  alerts: root.querySelectorAll("#alerts li").length,
});

describe("readiness on the overview (#16)", () => {
  it.scopedLive("a nested Loading holds only the slowest card while the page paints", () =>
    Effect.gen(function* () {
      const { handlers, wire } = yield* tappedHost();
      const slow = yield* handlers.hold("Slowest");
      const app = yield* mountApp({ transport: wire.transport, href: overview, routes });
      yield* settle(
        Effect.sync(() => textOf(app.root, "#revenue") === "460"),
        "the page painted around the slow read",
      );

      // Every other card shows its content; the slow one shows its own fallback.
      expect(paintedCards(app.root)).toEqual({
        tenant: "Acme Co",
        memo: true,
        revenue: "460",
        orders: 7,
        open: "3",
        alerts: 3,
      });
      expect(has(app.root, "#skeleton")).toBe(false);
      expect(textOf(app.root, "#slowest-loading")).toBe("measuring");
      expect(has(app.root, "#slowest-card")).toBe(false);

      yield* wire.open(slow);
      yield* settle(
        Effect.sync(() => has(app.root, "#slowest-card")),
        "the slowest card",
      );
      expect(has(app.root, "#slowest-loading")).toBe(false);
      expect(textOf(app.root, "#slowest li")).toBe("POST /checkout 2140ms");
      expect(paintedCards(app.root).revenue).toBe("460");
    }),
  );

  it.scopedLive(
    "the funnel card mounts late: the shell's scope goes pending again and settles",
    () =>
      Effect.gen(function* () {
        const { handlers, wire } = yield* tappedHost();
        const funnel = yield* handlers.hold("Funnel");
        const app = yield* mountApp({ transport: wire.transport, href: overview, routes });
        // The funnel's read is still in flight, but no card has registered it:
        // the scope settles without it, and the page paints.
        yield* settle(
          Effect.sync(
            () => textOf(app.root, "#revenue") === "460" && has(app.root, "#slowest-card"),
          ),
          "first paint",
        );
        expect(has(app.root, "#skeleton")).toBe(false);
        expect(has(app.root, "#funnel-card")).toBe(false);

        // Every element connected under the root that is or holds the card.
        const connected: Array<string> = [];
        const note = (records: ReadonlyArray<MutationRecord>): void => {
          for (const record of records) {
            for (const added of Array.from(record.addedNodes)) {
              if (
                added instanceof HTMLElement &&
                (added.id === "funnel-card" || has(added, "#funnel-card"))
              ) {
                connected.push(added.id || added.tagName);
              }
            }
          }
        };
        const observer = new MutationObserver(note);
        yield* Effect.acquireRelease(
          Effect.sync(() => observer.observe(app.root, { childList: true, subtree: true })),
          () => Effect.sync(() => observer.disconnect()),
        );

        yield* click(app.root, "#show-funnel");
        // The late registration flips the scope pending: its fallback returns,
        // and nothing of the page, the new card included, is on screen.
        yield* settle(
          Effect.sync(() => has(app.root, "#skeleton")),
          "the scope pending again",
        );
        expect(has(app.root, "#shell")).toBe(false);
        expect(has(app.root, "#funnel-card")).toBe(false);
        // It stays pending while the funnel's read is held.
        yield* Effect.sleep("150 millis");
        yield* render;
        expect([has(app.root, "#skeleton"), has(app.root, "#shell")]).toEqual([true, false]);
        // The card was built while the scope was pending: it never reached the page.
        yield* Effect.sync(() => note(observer.takeRecords()));
        expect(connected).toEqual([]);

        yield* wire.open(funnel);
        yield* settle(
          Effect.sync(() => !has(app.root, "#skeleton") && has(app.root, "#funnel-card")),
          "the scope settled with the funnel",
        );
        expect(textOf(app.root, "#funnel")).toBe("placed 7open 2fulfilled 4cancelled 1");
        expect(paintedCards(app.root).revenue).toBe("460");
      }),
  );

  it.scopedLive("a failing Revenue settles the scope: exactly one fallback, and no hang", () =>
    Effect.gen(function* () {
      const { handlers, wire } = yield* tappedHost();
      yield* handlers.fail("Revenue");
      const app = yield* mountApp({ transport: wire.transport, href: overview, routes });
      yield* settle(
        Effect.sync(() => has(app.root, "#failure")),
        "the error fallback",
      );

      expect(textOf(app.root, "#failure")).toBe("could not load: QueryFailed");
      expect(has(app.root, "#skeleton")).toBe(false);
      expect(has(app.root, "#slowest-loading")).toBe(false);
      // Nothing of the failed region is left on screen.
      expect(has(app.root, "#shell")).toBe(false);
      expect(has(app.root, "#overview")).toBe(false);
      expect(Array.from(app.root.children).map((child) => child.id)).toEqual(["failure"]);
    }),
  );
});
