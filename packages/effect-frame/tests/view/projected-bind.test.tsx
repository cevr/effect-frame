import { registerDom } from "./dom-setup.js";

registerDom();

import { Actor, Behavior, Value } from "effect-frame/actor";
import type { Source } from "effect-frame/actor";
import type { Host } from "effect-frame/view";
import { Dom, For, View } from "effect-frame/view";
import { ViewTest } from "effect-frame/view/testing";
import { Effect } from "effect";
import { describe, expect, it } from "effect-bun-test";

/** A row's projected text and its list's projected text, side by side. */
const Orders = (props: { readonly rows: Source<ReadonlyArray<string>> }) =>
  Effect.succeed(
    <div>
      <ul>
        <For each={props.rows} keyBy={() => "o6"}>
          {(status) => <li>{View.bind(status, (value) => `row: ${value}`)}</li>}
        </For>
      </ul>
      <p>{View.bind(props.rows, (all) => `list: ${all.join()}`)}</p>
    </div>,
  );

describe("a projected binding in a row", () => {
  it.scoped("paints in the same flush as a sibling binding of the list", () =>
    Effect.gen(function* () {
      const root = document.createElement("main");
      document.body.appendChild(root);
      // What the page shows once the synchronous flush that painted
      // "fulfilled" has returned: a later flush has not run yet.
      const shown: Array<string> = [];
      const host: Host<Node> = {
        ...Dom.host,
        setText: (node, text) => {
          Dom.host.setText(node, text);
          if (text.endsWith("fulfilled")) {
            // oxlint-disable-next-line effect/noGlobals -- the probe runs after this flush and before any scheduler turn, which only a microtask reaches
            queueMicrotask(() => shown.push(root.textContent));
          }
        },
      };
      const book = yield* Actor.local(Behavior.value<ReadonlyArray<string>>(["open"]));
      const page = yield* ViewTest.make({
        host,
        root,
        setup: (wrappedHost, mountRoot) =>
          View.mount(Orders, { rows: book.state }, wrappedHost, mountRoot),
      });
      expect(root.textContent).toBe("row: openlist: open");

      yield* page.act(book.call(Value.Set(["fulfilled"])), {
        label: "the row and the list show the new status",
        until: (actual) => actual.textContent === "row: fulfilledlist: fulfilled",
      });

      expect(shown.length).toBeGreaterThan(0);
      for (const text of shown) {
        expect(text).toBe("row: fulfilledlist: fulfilled");
      }
      root.remove();
    }),
  );
});
