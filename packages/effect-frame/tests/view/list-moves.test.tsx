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

interface LabeledItem {
  readonly key: string;
  readonly label: string;
}

const LabeledKeyed = (props: { readonly items: Source<ReadonlyArray<LabeledItem>> }) =>
  Effect.succeed(
    <ul>
      <For each={props.items} keyBy={(item) => item.key}>
        {(item) => <li>{View.bind(item, (value) => value.label)}</li>}
      </For>
    </ul>,
  );

/** Rows whose element id names the key, so a test can match nodes across moves. */
const Labeled = (props: { readonly items: Source<ReadonlyArray<string>> }) =>
  Effect.gen(function* () {
    const rows = yield* View.list({
      each: props.items,
      keyBy: (item) => item,
      row: (item) =>
        Effect.map(item.get, (first) => <li id={`row-${first}`}>{View.bind(item)}</li>),
    });
    return <ul>{rows}</ul>;
  });

/** A keyed list with a sibling after it in the same parent. */
const Followed = (props: { readonly items: Source<ReadonlyArray<string>> }) =>
  Effect.succeed(
    <ul>
      <For each={props.items} keyBy={(item) => item}>
        {(item) => <li>{View.bind(item)}</li>}
      </For>
      <li>tail</li>
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
  it.scoped("updates labels without replacing stable keyed rows", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      document.body.appendChild(root);
      const { host, inserted } = counting();
      const items = yield* spawn(
        Behavior.value<ReadonlyArray<LabeledItem>>([
          { key: "a", label: "alpha" },
          { key: "b", label: "beta" },
          { key: "c", label: "gamma" },
        ]),
      );
      const page = yield* ViewTest.make({
        host,
        root,
        setup: (wrappedHost, mountRoot) =>
          mount(LabeledKeyed, { items: items.state }, wrappedHost, mountRoot),
      });
      expect(idsIn(root)).toEqual(["alpha", "beta", "gamma"]);
      const before = Array.from(root.querySelectorAll("li"));
      const first = Option.fromNullishOr(before[0]);
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

      yield* page.act(
        items.call(
          Value.Set([
            { key: "a", label: "ALPHA" },
            { key: "b", label: "BETA" },
            { key: "c", label: "GAMMA" },
          ]),
        ),
        {
          label: "all keyed row labels update",
          until: (actualRoot) => idsAt(actualRoot).join(",") === "ALPHA,BETA,GAMMA",
        },
      );
      const after = Array.from(root.querySelectorAll("li"));
      expect(idsIn(root)).toEqual(["ALPHA", "BETA", "GAMMA"]);
      expect(after.length).toBe(before.length);
      for (let index = 0; index < before.length; index += 1) {
        expect(after[index]).toBe(before[index]);
      }
      expect(Option.map(first, (li) => document.activeElement === li)).toEqual(Option.some(true));
      expect(inserted).toEqual([]);
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

  it.scoped("swapping two rows moves only those two rows", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const { host, inserted } = counting();
      const items = yield* spawn(
        Behavior.value<ReadonlyArray<string>>(["a", "b", "c", "d", "e", "f"]),
      );
      const page = yield* ViewTest.make({
        host,
        root,
        setup: (wrappedHost, mountRoot) =>
          mount(Labeled, { items: items.state }, wrappedHost, mountRoot),
      });
      const before = new Map(Array.from(root.querySelectorAll("li")).map((li) => [li.id, li]));
      inserted.length = 0;

      // The benchmark's swap: the second row and the second to last.
      yield* page.act(items.call(Value.Set(["a", "e", "c", "d", "b", "f"])), {
        label: "keyed rows swap",
        until: (actualRoot) => idsAt(actualRoot).join(",") === "a,e,c,d,b,f",
      });
      expect(idsIn(root)).toEqual(["a", "e", "c", "d", "b", "f"]);
      for (const li of Array.from(root.querySelectorAll("li"))) {
        expect(before.get(li.id) === li).toBe(true);
      }
      expect(inserted.toSorted()).toEqual(["row-b", "row-e"]);
    }),
  );

  it.scoped("any permutation lands in order with every row node kept", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const keys = Array.from({ length: 12 }, (_, index) => String.fromCharCode(97 + index));
      const items = yield* spawn(Behavior.value<ReadonlyArray<string>>(keys));
      const page = yield* ViewTest.make({
        host: Dom.host,
        root,
        setup: (wrappedHost, mountRoot) =>
          mount(Labeled, { items: items.state }, wrappedHost, mountRoot),
      });
      const nodes = new Map(Array.from(root.querySelectorAll("li")).map((li) => [li.id, li]));

      // A fixed linear congruential sequence, so a failure replays exactly.
      let seed = 7;
      const next = (bound: number): number => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed % bound;
      };
      let current: ReadonlyArray<string> = keys;
      for (let round = 0; round < 40; round += 1) {
        const shuffled = [...current];
        for (let index = shuffled.length - 1; index > 0; index -= 1) {
          const other = next(index + 1);
          const held = shuffled[index] ?? "";
          shuffled[index] = shuffled[other] ?? "";
          shuffled[other] = held;
        }
        if (round % 5 === 0) {
          shuffled.reverse();
        }
        const wanted = shuffled.join(",");
        yield* page.act(items.call(Value.Set(shuffled)), {
          label: `permutation ${String(round)}`,
          until: (actualRoot) => idsAt(actualRoot).join(",") === wanted,
        });
        expect(idsIn(root).join(",")).toBe(wanted);
        current = shuffled;
      }
      for (const li of Array.from(root.querySelectorAll("li"))) {
        expect(nodes.get(li.id) === li).toBe(true);
      }
    }),
  );

  it.scoped("a moved last row stays before content after the list", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const items = yield* spawn(Behavior.value<ReadonlyArray<string>>(["a", "b", "c"]));
      const page = yield* ViewTest.make({
        host: Dom.host,
        root,
        setup: (wrappedHost, mountRoot) =>
          mount(Followed, { items: items.state }, wrappedHost, mountRoot),
      });

      yield* page.act(items.call(Value.Set(["b", "c", "a"])), {
        label: "first row moves to the end",
        until: (actualRoot) => idsAt(actualRoot).join(",") === "b,c,a,tail",
      });
      expect(idsIn(root)).toEqual(["b", "c", "a", "tail"]);
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
