import { registerDom } from "./dom-setup.js";

registerDom();

import { Behavior, spawn } from "effect-frame/actor";
import type { Source } from "effect-frame/actor";
import { Dom, View, ViewTest, mount } from "effect-frame/view";
import { Deferred, Effect } from "effect";
import { describe, expect, it } from "effect-bun-test";

const makeRoot = Effect.sync(() => document.createElement("main"));

interface RowsProps {
  readonly items: Source<ReadonlyArray<string>>;
  readonly log: Array<string>;
  readonly gate: Deferred.Deferred<boolean>;
  readonly attached: Deferred.Deferred<void>;
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
                Effect.sync(() => {
                  props.log.push(`${element.tagName}:${element.isConnected}`);
                  if (props.log.length === 2) {
                    return Deferred.succeed(props.attached, void 0);
                  }
                  return Effect.void;
                }).pipe(Effect.flatten),
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
const Top = (props: { readonly log: Array<string>; readonly attached: Deferred.Deferred<void> }) =>
  Effect.succeed(
    <p
      attach={Dom.attach((element) =>
        Effect.sync(() => props.log.push(`top:${element.isConnected}`)).pipe(
          Effect.andThen(Deferred.succeed(props.attached, void 0)),
        ),
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
      const log: Array<string> = [];
      const attached = yield* Deferred.make<void>();
      const page = yield* ViewTest.make({
        host: Dom.host,
        root,
        setup: (host, mountRoot) => mount(Top, { log, attached }, host, mountRoot),
      });
      yield* Deferred.await(attached);
      yield* page.waitFor({
        label: "top-level behaviour is attached",
        until: () => log.length === 1,
      });
      expect(log).toEqual(["top:true"]);
      root.remove();
    }),
  );

  it.scoped("a row whose setup suspends runs its behaviour when it lands", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      document.body.appendChild(root);
      const log: Array<string> = [];
      const gate = yield* Deferred.make<boolean>();
      const attached = yield* Deferred.make<void>();
      const items = yield* spawn(Behavior.value<ReadonlyArray<string>>(["a", "b"]));
      const page = yield* ViewTest.make({
        host: Dom.host,
        root,
        setup: (host, mountRoot) =>
          mount(Rows, { items: items.state, log, gate, attached }, host, mountRoot),
      });
      expect(log).toEqual([]);
      yield* Deferred.succeed(gate, true);
      yield* Deferred.await(attached);
      yield* page.waitFor({
        label: "row behaviours are attached",
        until: () => log.length === 2,
      });
      expect(log).toEqual(["LI:true", "LI:true"]);
      root.remove();
    }),
  );
});
