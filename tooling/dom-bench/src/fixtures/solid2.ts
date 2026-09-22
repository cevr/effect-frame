/* oxlint-disable effect/noGlobals, effect/noNewError, effect/noNullish, effect/noRuntimeTypeof, effect/noTernary, effect/noThrowStatement, effect/noUnsafeDictionaryType -- this pinned Solid 2 control intentionally crosses the browser and package APIs required by the official fixture contract. */

import { For, createComponent, createRoot, createSignal, flush } from "solid-js";
import { insert, render, spread } from "@solidjs/web";
import {
  apply,
  initialState,
  inspectDom,
  type BenchmarkState,
  type OperationName,
  type Row,
} from "../common.js";

type Child = unknown | (() => unknown);

const element = (
  tag: string,
  props: Record<string, unknown> | undefined,
  children: ReadonlyArray<Child>,
): HTMLElement => {
  const node = document.createElement(tag);
  if (props !== undefined) {
    spread(node, props);
  }
  for (const child of children) {
    insert(node, typeof child === "function" ? child : () => child);
  }
  return node;
};

const Benchmark = (props: { readonly root: HTMLElement }): HTMLElement => {
  const [rows, setRows] = createSignal<ReadonlyArray<Row>>(initialState.rows);
  const [selected, setSelected] = createSignal<number | null>(initialState.selected);
  let state: BenchmarkState = initialState;
  window.__benchNodeId = 0;
  window.__benchNodeTokens = {};
  window.__benchVersion ??= 0;

  const nodeToken = (id: number): string => {
    const tokens = window.__benchNodeTokens ?? (window.__benchNodeTokens = {});
    const current = tokens[id];
    if (current !== undefined) return current;
    window.__benchNodeId = (window.__benchNodeId ?? 0) + 1;
    const token = String(window.__benchNodeId);
    tokens[id] = token;
    return token;
  };

  const setState = (next: BenchmarkState): void => {
    state = next;
    window.__benchVersion = (window.__benchVersion ?? 0) + 1;
    setRows(next.rows);
    setSelected(next.selected);
    flush();
    queueMicrotask(() => {
      if (typeof window.__benchCommit === "function") window.__benchCommit();
    });
  };

  const run =
    (name: OperationName): (() => void) =>
    () =>
      setState(apply(state, name));
  const row = (value: () => Row): HTMLElement => {
    const id = value().id;
    return element(
      "tr",
      {
        "data-row-id": String(id),
        "data-bench-node": nodeToken(id),
        class: () => (selected() === id ? "danger" : ""),
      },
      [
        element("td", { class: "col-md-1" }, [() => id]),
        element("td", { class: "col-md-4" }, [
          element(
            "a",
            {
              href: "#",
              onClick: (event: Event) => {
                event.preventDefault();
                setState({ ...state, selected: id });
              },
            },
            [() => value().label],
          ),
        ]),
        element("td", { class: "col-md-1" }, [
          element(
            "a",
            {
              href: "#",
              onClick: (event: Event) => {
                event.preventDefault();
                setState({
                  ...state,
                  rows: state.rows.filter((item) => item.id !== id),
                  selected: null,
                });
              },
            },
            [element("span", { "aria-hidden": "true" }, ["×"])],
          ),
        ]),
        element("td", { class: "col-md-6" }, []),
      ],
    );
  };

  const list = createComponent(For, {
    get each() {
      return rows();
    },
    keyed: (value: Row) => value.id,
    children: (value: () => Row) => row(value),
  });
  const body = element("tbody", { id: "tbody" }, [list]);

  window.__benchInvariant = () => inspectDom(props.root, state);

  const button = (id: string, name: OperationName, label: string): HTMLElement =>
    element(
      "button",
      { type: "button", class: "btn btn-primary btn-block", id, onClick: run(name) },
      [label],
    );

  return element("div", { id: "app" }, [
    element("div", { class: "container" }, [
      element("div", { class: "jumbotron" }, [
        element("div", { class: "row" }, [
          element("div", { class: "col-md-6" }, [
            element("h1", undefined, ["Solid 2 keyed benchmark"]),
          ]),
          element("div", { class: "col-md-6" }, [
            element("div", { class: "row" }, [
              element("div", { class: "col-sm-6 smallpad" }, [
                button("run", "create-1k", "Create 1,000 rows"),
              ]),
              element("div", { class: "col-sm-6 smallpad" }, [
                button("runlots", "create-10k", "Create 10,000 rows"),
              ]),
              element("div", { class: "col-sm-6 smallpad" }, [
                button("add", "append-10k", "Append 1,000 rows"),
              ]),
              element("div", { class: "col-sm-6 smallpad" }, [
                button("update", "update-10th-10k", "Update every 10th row"),
              ]),
              element("div", { class: "col-sm-6 smallpad" }, [
                button("clear", "clear-10k", "Clear"),
              ]),
              element("div", { class: "col-sm-6 smallpad" }, [
                button("swaprows", "swap-1k", "Swap Rows"),
              ]),
            ]),
          ]),
        ]),
      ]),
      element("table", { class: "table table-hover table-striped test-data" }, [body]),
      element(
        "span",
        { class: "preloadicon glyphicon glyphicon-remove", "aria-hidden": "true" },
        [],
      ),
    ]),
  ]);
};

const root = document.getElementById("main");
if (!(root instanceof HTMLElement)) {
  throw new Error("solid2 benchmark: no #main root");
}
createRoot(() => {
  render(() => Benchmark({ root }), root);
});
window.__benchReady = true;
