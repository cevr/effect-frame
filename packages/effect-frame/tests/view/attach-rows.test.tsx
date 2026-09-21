import { registerDom } from "./dom-setup.js";

registerDom();

import { Behavior, spawn } from "effect-frame/actor";
import type { Source } from "effect-frame/actor";
import { Dom, View, mount, render } from "effect-frame/view";
import { Deferred, Effect, Ref } from "effect";
import { describe, expect, it } from "effect-bun-test";

const makeRoot = Effect.sync(() => document.createElement("main"));

interface RowsProps {
  readonly items: Source<ReadonlyArray<string>>;
  readonly log: Ref.Ref<ReadonlyArray<string>>;
  readonly gate: Deferred.Deferred<boolean>;
}

/** Rows whose setup suspends before the tree exists, each with a behaviour. */
const Rows = (props: RowsProps) =>
  Effect.gen(function* () {
    const rows = yield* View.list({
      each: props.items,
      keyBy: (item) => item,
      row: (item) =>
        Effect.gen(function* () {
          yield* Deferred.await(props.gate);
          return (
            <li
              attach={Dom.attach((element) =>
                Ref.update(props.log, (xs) => [...xs, `${element.tagName}:${element.isConnected}`]),
              )}
            >
              {View.bind(item)}
            </li>
          );
        }),
    });
    return <ul>{rows}</ul>;
  });

/** A top-level element, not inside any branch. */
const Top = (props: { readonly log: Ref.Ref<ReadonlyArray<string>> }) =>
  Effect.succeed(
    <p
      attach={Dom.attach((element) =>
        Ref.update(props.log, (xs) => [...xs, `top:${element.isConnected}`]),
      )}
    >
      hi
    </p>,
  );

describe("attached behaviours in rows and at the top", () => {
  it.scoped("a top-level element's behaviour runs after mount", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      document.body.appendChild(root);
      const log = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* mount(Top, { log }, Dom.host, root);
      yield* render;
      expect(yield* Ref.get(log)).toEqual(["top:true"]);
      root.remove();
    }),
  );

  it.scoped("a row whose setup suspends runs its behaviour when it lands", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      document.body.appendChild(root);
      const log = yield* Ref.make<ReadonlyArray<string>>([]);
      const gate = yield* Deferred.make<boolean>();
      const items = yield* spawn(Behavior.value<ReadonlyArray<string>>(["a", "b"]));
      yield* mount(Rows, { items: items.state, log, gate }, Dom.host, root);
      expect(yield* Ref.get(log)).toEqual([]);
      yield* Deferred.succeed(gate, true);
      yield* render;
      expect(yield* Ref.get(log)).toEqual(["LI:true", "LI:true"]);
      root.remove();
    }),
  );
});
