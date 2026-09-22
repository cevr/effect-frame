import { registerDom } from "./dom-setup.js";

registerDom();

import { Behavior, Value, spawn } from "effect-frame/actor";
import type { Source } from "effect-frame/actor";
import type { Host } from "effect-frame/view";
import { Dom, For, View, ViewTest, mount } from "effect-frame/view";
import { Effect, Option } from "effect";
import { describe, expect, it } from "effect-bun-test";

const makeRoot = Effect.sync(() => document.createElement("main"));

interface Counting {
  readonly host: Host<Node>;
  readonly inserted: Array<string>;
}

/** The DOM host with every insert counted, so a test can say what moved. */
const counting = (): Counting => {
  const inserted: Array<string> = [];
  const host: Host<Node> = {
    ...Dom.host,
    insert: (parent, node, anchor) => {
      if (node instanceof Element) {
        inserted.push(node.id);
      }
      Dom.host.insert(parent, node, anchor);
    },
  };
  return { host, inserted };
};

const Rows = (props: { readonly items: Source<ReadonlyArray<string>> }) =>
  Effect.succeed(
    <ul>
      <For each={props.items} keyBy={(item) => item}>
        {(item) => <li id={`row-${"a"}`}>{View.bind(item)}</li>}
      </For>
    </ul>,
  );

const Keyed = (props: { readonly items: Source<ReadonlyArray<string>> }) =>
  Effect.succeed(
    <ul>
      <For each={props.items} keyBy={(item) => item}>
        {(item) => <li>{View.bind(item)}</li>}
      </For>
    </ul>,
  );

const idsIn = (root: Element): ReadonlyArray<string> =>
  Array.from(root.querySelectorAll("li")).map((li) => li.textContent ?? "");

const idsAt = (root: Node): ReadonlyArray<string> => {
  if (!(root instanceof Element)) {
    return [];
  }
  return idsIn(root);
};

describe("a keyed list moves only what moved", () => {
  it.scoped("a change that keeps every row in place touches no node", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      document.body.appendChild(root);
      const { host, inserted } = counting();
      const items = yield* spawn(Behavior.value<ReadonlyArray<string>>(["a", "b", "c"]));
      const page = yield* ViewTest.make({
        host,
        root,
        setup: (wrappedHost, mountRoot) =>
          mount(Keyed, { items: items.state }, wrappedHost, mountRoot),
      });
      expect(idsIn(root)).toEqual(["a", "b", "c"]);
      const first = Option.fromNullishOr(root.querySelector("li"));
      Option.match(first, {
        onNone: () => {},
        onSome: (li) => {
          li.setAttribute("tabindex", "-1");
          if (li instanceof HTMLElement) {
            li.focus();
          }
        },
      });
      expect(Option.map(first, (li) => document.activeElement === li)).toEqual(Option.some(true));
      inserted.length = 0;

      yield* page.act(items.call(Value.Set(["a", "b", "c"])), {
        label: "unchanged keyed rows remain rendered",
        until: (actualRoot) => idsAt(actualRoot).join(",") === "a,b,c",
      });
      expect(inserted).toEqual([]);
      expect(Option.map(first, (li) => document.activeElement === li)).toEqual(Option.some(true));
      root.remove();
    }),
  );

  it.scoped("moving one row to the front inserts only that row", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const { host } = counting();
      const items = yield* spawn(Behavior.value<ReadonlyArray<string>>(["a", "b", "c"]));
      const page = yield* ViewTest.make({
        host,
        root,
        setup: (wrappedHost, mountRoot) =>
          mount(Keyed, { items: items.state }, wrappedHost, mountRoot),
      });
      const before = Array.from(root.querySelectorAll("li"));

      yield* page.act(items.call(Value.Set(["c", "a", "b"])), {
        label: "keyed rows move to the front",
        until: (actualRoot) => idsAt(actualRoot).join(",") === "c,a,b",
      });
      expect(idsIn(root)).toEqual(["c", "a", "b"]);
      const after = Array.from(root.querySelectorAll("li"));
      // The same three nodes, with `a` and `b` untouched.
      expect(after[1]).toBe(before[0]);
      expect(after[2]).toBe(before[1]);
      expect(after[0]).toBe(before[2]);
    }),
  );

  it.scoped("a row added at the end and one removed keep the rest in place", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const { host } = counting();
      const items = yield* spawn(Behavior.value<ReadonlyArray<string>>(["a", "b", "c"]));
      const page = yield* ViewTest.make({
        host,
        root,
        setup: (wrappedHost, mountRoot) =>
          mount(Rows, { items: items.state }, wrappedHost, mountRoot),
      });
      const b = Array.from(root.querySelectorAll("li"))[1];

      yield* page.act(items.call(Value.Set(["a", "b", "c", "d"])), {
        label: "keyed row is added at the end",
        until: (actualRoot) => idsAt(actualRoot).join(",") === "a,b,c,d",
      });
      expect(idsIn(root)).toEqual(["a", "b", "c", "d"]);
      expect(Array.from(root.querySelectorAll("li"))[1]).toBe(b);

      yield* page.act(items.call(Value.Set(["b", "d"])), {
        label: "keyed rows keep survivors after removal",
        until: (actualRoot) => idsAt(actualRoot).join(",") === "b,d",
      });
      expect(idsIn(root)).toEqual(["b", "d"]);
      expect(Array.from(root.querySelectorAll("li"))[0]).toBe(b);
    }),
  );
});
