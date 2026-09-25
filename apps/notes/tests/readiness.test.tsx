import { View } from "effect-frame/view";
import { registerDom } from "./dom-setup.js";

registerDom();

import { QueryFailed } from "effect-frame/actor/client";
import { Route } from "effect-frame/router";
import type { Route as RouteTypes } from "effect-frame/router";
import { Effect } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { ListView } from "../src/page.js";
import { routes } from "../src/routes.js";
import { list, lists, shell } from "../src/segments.js";
import { ListsView, failure, skeleton } from "../src/views.js";
import { elementOf, has, mountApp, settle, tappedHost, textOf } from "./fixture.js";

/**
 * #16 and #26 in the app: a failing `ListCounts` shows one fallback under
 * either nesting of `Loading` and `Errored`, and leaves no content behind;
 * a refetch holds the content it has and never draws the skeleton again.
 */

const origin = "http://notes.test";
const inbox = `${origin}/lists/inbox`;

/** The app's shell turned inside out: `Loading` outside `Errored`. */
const ReversedShell = <ChildR,>(props: RouteTypes.LayoutPropsOf<typeof shell, ChildR>) =>
  Effect.map(
    View.loading({
      fallback: skeleton,
      content: View.errored({ fallback: failure, content: props.outlet }),
    }),
    (body) => (
      <div id="shell">
        <main id="outlet">{body}</main>
      </div>
    ),
  );

/** The same segments and the same `ListView`, under the reversed shell. */
const reversed = Route.client(
  "reversed",
  Route.layout(
    shell,
    [Route.layout(lists, [Route.leaf(list, ListView)], ListsView)],
    ReversedShell,
  ),
);

const orders = [
  { name: "Errored outside View.loading (the app's shell)", routes },
  { name: "Loading outside Errored", routes: [reversed] },
];

/** Every node with id `skeleton` the page ever inserts, from now on. */
const watchSkeletons = (root: HTMLElement) => {
  const seen: Array<string> = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (node instanceof Element && (node.id === "skeleton" || has(node, "#skeleton"))) {
          seen.push("skeleton");
        }
      }
    }
  });
  observer.observe(root, { childList: true, subtree: true });
  return { seen, stop: () => observer.disconnect() };
};

describe("readiness on the list page", () => {
  for (const order of orders) {
    it.scopedLive(`a failing ListCounts shows one fallback: ${order.name}`, () =>
      Effect.gen(function* () {
        const wire = yield* tappedHost;
        yield* wire.fail("ListCounts", QueryFailed.make({ query: "ListCounts", detail: "broken" }));
        const app = yield* mountApp({
          transport: wire.transport,
          href: inbox,
          routes: order.routes,
        });
        yield* settle(Effect.sync(() => has(app.root, "#failure")));

        expect(textOf(app.root, "#failure")).toBe("could not load: QueryFailed");
        expect(has(app.root, "#skeleton")).toBe(false);
        // Nothing of the failed region is left on screen.
        expect(has(app.root, "#list-page")).toBe(false);
        expect(has(app.root, "#lists")).toBe(false);
        expect(app.root.querySelectorAll("#outlet > *").length).toBe(1);
      }),
    );
  }

  it.scopedLive("a refetch holds the counts it has, and never draws the skeleton again", () =>
    Effect.gen(function* () {
      const wire = yield* tappedHost;
      const app = yield* mountApp({ transport: wire.transport, href: inbox, routes });
      yield* settle(Effect.sync(() => textOf(app.root, "#counts") === "0 of 0 done"));
      const watch = watchSkeletons(app.root);

      // The add is held on the wire: the counts are stale until it lands.
      const held = yield* wire.holdSend("buy milk");
      const draft = elementOf(app.root, "#draft", HTMLInputElement);
      draft.value = "buy milk";
      draft.dispatchEvent(new Event("input", { bubbles: true }));
      elementOf(app.root, "#compose", HTMLFormElement).dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      yield* settle(Effect.sync(() => textOf(app.root, "#count") === "1"));
      expect(textOf(app.root, "#counts")).toBe("0 of 0 done");

      yield* wire.open(held);
      yield* settle(
        Effect.sync(
          () => textOf(app.root, "#counts") === "0 of 1 done" && has(app.root, "#list li input"),
        ),
      );
      // Toggling moves the done count through another refresh.
      const box = elementOf(app.root, '#list input[type="checkbox"]', HTMLInputElement);
      box.checked = true;
      box.dispatchEvent(new Event("change", { bubbles: true }));
      yield* settle(Effect.sync(() => textOf(app.root, "#counts") === "1 of 1 done"));
      watch.stop();
      expect(watch.seen).toEqual([]);
    }),
  );
});
