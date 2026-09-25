/* oxlint-disable effect/noGlobals, effect/noNullish, effect/noRuntimeTypeof, effect/noTernary -- this browser fixture is the benchmark boundary: it must use DOM globals, nullable DOM state, and the canonical imperative callback shape. */

import { Actor, Behavior, Value, Source } from "effect-frame/actor/client";
import { Dom, View } from "effect-frame/view";
import { Effect } from "effect";
import {
  apply,
  initialState,
  inspectDom,
  type BenchmarkState,
  type OperationName,
  type Row,
} from "../common.js";

interface BenchmarkProps {
  readonly root: HTMLElement;
}

const operation = (value: OperationName, state: BenchmarkState): BenchmarkState =>
  apply(state, value);

const Benchmark = (props: BenchmarkProps) =>
  Effect.gen(function* () {
    const rows = yield* Actor.local(Behavior.value<ReadonlyArray<Row>>(initialState.rows));
    const selected = yield* Actor.local(Behavior.value<number | null>(initialState.selected));
    let state: BenchmarkState = initialState;
    window.__benchVersion = 0;
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

    const setState = (next: BenchmarkState) =>
      Effect.gen(function* () {
        state = next;
        window.__benchVersion = (window.__benchVersion ?? 0) + 1;
        yield* rows
          .call(Value.Set(next.rows))
          .pipe(Effect.catchTag("ActorStopped", () => Effect.void));
        yield* selected
          .call(Value.Set(next.selected))
          .pipe(Effect.catchTag("ActorStopped", () => Effect.void));
        yield* Effect.sync(() =>
          queueMicrotask(() => {
            if (typeof window.__benchCommit === "function") window.__benchCommit();
          }),
        );
      });

    const applyOperation = (name: OperationName) => setState(operation(name, state));
    const selectRow = (item: Source<Row>) =>
      Effect.gen(function* () {
        const row = yield* item.get;
        yield* setState({ ...state, selected: row.id });
      });
    const removeRow = (item: Source<Row>) =>
      Effect.gen(function* () {
        const row = yield* item.get;
        yield* setState({
          ...state,
          rows: state.rows.filter((candidate) => candidate.id !== row.id),
          selected: null,
        });
      });

    const list = yield* View.list({
      each: rows.state,
      keyBy: (row) => String(row.id),
      row: (item) =>
        Effect.gen(function* () {
          const row = yield* item.get;
          const token = yield* Effect.sync(() => nodeToken(row.id));
          return (
            <tr
              data-row-id={String(row.id)}
              data-bench-node={token}
              class={View.bind(
                Source.select(selected.state, (value) => (value === row.id ? "danger" : "")),
              )}
            >
              <td class="col-md-1">{row.id}</td>
              <td class="col-md-4">
                <a href="#" onClick={View.submit(selectRow(item))}>
                  {View.bind(item, (value) => value.label)}
                </a>
              </td>
              <td class="col-md-1">
                <a href="#" onClick={View.submit(removeRow(item))}>
                  <span aria-hidden="true">×</span>
                </a>
              </td>
              <td class="col-md-6" />
            </tr>
          );
        }),
    });

    yield* Effect.sync(() => {
      window.__benchInvariant = () => inspectDom(props.root, state);
    });

    return (
      <div id="app">
        <div class="container">
          <div class="jumbotron">
            <div class="row">
              <div class="col-md-6">
                <h1>Effect Frame keyed benchmark</h1>
              </div>
              <div class="col-md-6">
                <div class="row">
                  <div class="col-sm-6 smallpad">
                    <button
                      type="button"
                      class="btn btn-primary btn-block"
                      id="run"
                      onClick={View.event(() => applyOperation("create-1k"))}
                    >
                      Create 1,000 rows
                    </button>
                  </div>
                  <div class="col-sm-6 smallpad">
                    <button
                      type="button"
                      class="btn btn-primary btn-block"
                      id="runlots"
                      onClick={View.event(() => applyOperation("create-10k"))}
                    >
                      Create 10,000 rows
                    </button>
                  </div>
                  <div class="col-sm-6 smallpad">
                    <button
                      type="button"
                      class="btn btn-primary btn-block"
                      id="add"
                      onClick={View.event(() => applyOperation("append-10k"))}
                    >
                      Append 1,000 rows
                    </button>
                  </div>
                  <div class="col-sm-6 smallpad">
                    <button
                      type="button"
                      class="btn btn-primary btn-block"
                      id="update"
                      onClick={View.event(() => applyOperation("update-10th-10k"))}
                    >
                      Update every 10th row
                    </button>
                  </div>
                  <div class="col-sm-6 smallpad">
                    <button
                      type="button"
                      class="btn btn-primary btn-block"
                      id="clear"
                      onClick={View.event(() => applyOperation("clear-10k"))}
                    >
                      Clear
                    </button>
                  </div>
                  <div class="col-sm-6 smallpad">
                    <button
                      type="button"
                      class="btn btn-primary btn-block"
                      id="swaprows"
                      onClick={View.event(() => applyOperation("swap-1k"))}
                    >
                      Swap Rows
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <table class="table table-hover table-striped test-data">
            <tbody id="tbody">{list}</tbody>
          </table>
          <span class="preloadicon glyphicon glyphicon-remove" aria-hidden="true" />
        </div>
      </div>
    );
  });

const start = Effect.gen(function* () {
  const root = yield* Effect.sync(() => document.getElementById("main"));
  if (!(root instanceof HTMLElement)) {
    return yield* Effect.die("effect-frame benchmark: no #main root");
  }
  yield* View.mount(Benchmark, { root }, Dom.host, root);
  yield* View.flush;
  yield* Effect.sync(() => {
    window.__benchReady = true;
  });
  return yield* Effect.never;
});

Effect.runFork(Effect.scoped(start));
