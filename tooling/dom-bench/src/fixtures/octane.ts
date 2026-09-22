/* oxlint-disable effect/noGlobals, effect/noNewError, effect/noNullish, effect/noRuntimeTypeof, effect/noTernary, effect/noThrowStatement -- this Octane control intentionally crosses the browser and package APIs required by the official fixture contract. */

import { createElement, createRoot, flushSync, useState } from "octane";
import {
  apply,
  initialState,
  inspectDom,
  type BenchmarkState,
  type OperationName,
  type Row,
} from "../common.js";

const rowsSlot = Symbol.for("effect-frame/dom-bench/octane/rows");
const selectedSlot = Symbol.for("effect-frame/dom-bench/octane/selected");

const Benchmark = (props: { readonly root: HTMLElement }) => {
  const [rows, setRows] = useState<ReadonlyArray<Row>>(initialState.rows, rowsSlot);
  const [selected, setSelected] = useState<number | null>(initialState.selected, selectedSlot);
  window.__benchVersion ??= 0;
  window.__benchNextId ??= 1;
  window.__benchNodeId = 0;
  window.__benchNodeTokens = {};

  const nodeToken = (id: number): string => {
    const tokens = window.__benchNodeTokens ?? (window.__benchNodeTokens = {});
    const current = tokens[id];
    if (current !== undefined) return current;
    window.__benchNodeId = (window.__benchNodeId ?? 0) + 1;
    const token = String(window.__benchNodeId);
    tokens[id] = token;
    return token;
  };

  const current = (): BenchmarkState => ({ rows, selected, nextId: window.__benchNextId ?? 1 });
  const commit = (): void => {
    queueMicrotask(() => {
      if (typeof window.__benchCommit === "function") window.__benchCommit();
    });
  };
  const run =
    (name: OperationName): (() => void) =>
    () => {
      const next = apply(current(), name);
      window.__benchVersion = (window.__benchVersion ?? 0) + 1;
      window.__benchNextId = next.nextId;
      flushSync(() => {
        setRows(next.rows);
        setSelected(next.selected);
      });
      commit();
    };
  const selectRow =
    (id: number): (() => void) =>
    () => {
      window.__benchVersion = (window.__benchVersion ?? 0) + 1;
      flushSync(() => setSelected(id));
      commit();
    };
  const removeRow =
    (id: number): (() => void) =>
    () => {
      window.__benchVersion = (window.__benchVersion ?? 0) + 1;
      flushSync(() => {
        setRows(rows.filter((row) => row.id !== id));
        setSelected(null);
      });
      commit();
    };

  window.__benchInvariant = () => inspectDom(props.root, current());

  return createElement(
    "div",
    { id: "app" },
    createElement(
      "div",
      { className: "container" },
      createElement(
        "div",
        { className: "jumbotron" },
        createElement(
          "div",
          { className: "row" },
          createElement(
            "div",
            { className: "col-md-6" },
            createElement("h1", null, "Octane keyed benchmark"),
          ),
          createElement(
            "div",
            { className: "col-md-6" },
            createElement(
              "div",
              { className: "row" },
              createElement(
                "div",
                { className: "col-sm-6 smallpad" },
                createElement(
                  "button",
                  {
                    type: "button",
                    className: "btn btn-primary btn-block",
                    id: "run",
                    onClick: run("create-1k"),
                  },
                  "Create 1,000 rows",
                ),
              ),
              createElement(
                "div",
                { className: "col-sm-6 smallpad" },
                createElement(
                  "button",
                  {
                    type: "button",
                    className: "btn btn-primary btn-block",
                    id: "runlots",
                    onClick: run("create-10k"),
                  },
                  "Create 10,000 rows",
                ),
              ),
              createElement(
                "div",
                { className: "col-sm-6 smallpad" },
                createElement(
                  "button",
                  {
                    type: "button",
                    className: "btn btn-primary btn-block",
                    id: "add",
                    onClick: run("append-10k"),
                  },
                  "Append 1,000 rows",
                ),
              ),
              createElement(
                "div",
                { className: "col-sm-6 smallpad" },
                createElement(
                  "button",
                  {
                    type: "button",
                    className: "btn btn-primary btn-block",
                    id: "update",
                    onClick: run("update-10th-10k"),
                  },
                  "Update every 10th row",
                ),
              ),
              createElement(
                "div",
                { className: "col-sm-6 smallpad" },
                createElement(
                  "button",
                  {
                    type: "button",
                    className: "btn btn-primary btn-block",
                    id: "clear",
                    onClick: run("clear-10k"),
                  },
                  "Clear",
                ),
              ),
              createElement(
                "div",
                { className: "col-sm-6 smallpad" },
                createElement(
                  "button",
                  {
                    type: "button",
                    className: "btn btn-primary btn-block",
                    id: "swaprows",
                    onClick: run("swap-1k"),
                  },
                  "Swap Rows",
                ),
              ),
            ),
          ),
        ),
      ),
      createElement(
        "table",
        { className: "table table-hover table-striped test-data" },
        createElement(
          "tbody",
          { id: "tbody" },
          rows.map((row) =>
            createElement(
              "tr",
              {
                key: row.id,
                "data-row-id": String(row.id),
                "data-bench-node": nodeToken(row.id),
                className: selected === row.id ? "danger" : "",
              },
              createElement("td", { className: "col-md-1" }, String(row.id)),
              createElement(
                "td",
                { className: "col-md-4" },
                createElement(
                  "a",
                  {
                    href: "#",
                    onClick: (event: Event) => {
                      event.preventDefault();
                      selectRow(row.id)();
                    },
                  },
                  row.label,
                ),
              ),
              createElement(
                "td",
                { className: "col-md-1" },
                createElement(
                  "a",
                  {
                    href: "#",
                    onClick: (event: Event) => {
                      event.preventDefault();
                      removeRow(row.id)();
                    },
                  },
                  createElement("span", { "aria-hidden": "true" }, "×"),
                ),
              ),
              createElement("td", { className: "col-md-6" }),
            ),
          ),
        ),
      ),
      createElement("span", {
        className: "preloadicon glyphicon glyphicon-remove",
        "aria-hidden": "true",
      }),
    ),
  );
};

const root = document.getElementById("main");
if (!(root instanceof HTMLElement)) {
  throw new Error("octane benchmark: no #main root");
}
const mounted = createRoot(root);
mounted.render(createElement(Benchmark, { root }));
window.__benchReady = true;
