/** @jsxImportSource effect-frame/view/opentui */
import { Actor, Behavior, Value, modify, Source } from "effect-frame/actor";
import type { LocalValueRef, QueryState } from "effect-frame/actor";
import { View } from "effect-frame/view";
import type { Host } from "effect-frame/view";
import { ViewTest } from "effect-frame/view/testing";
import { make as makeHost } from "effect-frame/view/opentui";
import type { TuiNode } from "effect-frame/view/opentui";
import { InputRenderable, TextNodeRenderable, TextRenderable } from "@opentui/core";
import type { BaseRenderable, RenderContext } from "@opentui/core";
import type { TestRendererSetup } from "@opentui/core/testing";
import { createTestRenderer } from "@opentui/core/testing";
import { Effect, Predicate, Stream } from "effect";
import { describe, expect, it } from "effect-bun-test";

/** One headless terminal per test, destroyed with the test's scope. */
const makeTerminal = Effect.fn("OpenTuiTest.makeTerminal")(function* () {
  const setup: TestRendererSetup = yield* Effect.promise(() =>
    createTestRenderer({ width: 32, height: 6 }),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => setup.renderer.destroy()));
  return setup;
});

/** Flush the reactive graph, draw one frame, and read it back. */
const draw = Effect.fn("OpenTuiTest.draw")(function* (setup: TestRendererSetup) {
  yield* View.flush;
  yield* Effect.promise(() => setup.renderOnce());
  return setup.captureCharFrame();
});

const terminalText = (node: BaseRenderable): string => {
  if (node instanceof TextNodeRenderable) {
    let text = "";
    for (const child of node.children) {
      if (Predicate.isString(child)) {
        text += child;
      } else {
        text += terminalText(child);
      }
    }
    return text;
  }
  if (node instanceof TextRenderable) {
    return node.getTextChildren().map(terminalText).join("");
  }
  return node.getChildren().map(terminalText).join("");
};

interface CounterProps {
  readonly count: LocalValueRef<number>;
}

const Counter = (props: CounterProps) =>
  Effect.succeed(
    <box flexDirection="column" width={30} height={3}>
      <text>{View.bind(Source.select(props.count.state, (n) => `count ${n}`))}</text>
    </box>,
  );

interface DraftProps {
  readonly draft: LocalValueRef<string>;
}

const Composer = (props: DraftProps) =>
  Effect.succeed(
    <input width={20} onInput={View.event((event) => props.draft.send(Value.Set(event.value)))} />,
  );

describe("terminal view", () => {
  it.scoped("the same view draws a bound source in a terminal", () =>
    Effect.gen(function* () {
      const setup = yield* makeTerminal();
      const count = yield* Actor.local(Behavior.value(0));
      const page = yield* ViewTest.make({
        host: makeHost(setup.renderer),
        root: setup.renderer.root,
        setup: (host, root) => View.mount(Counter, { count }, host, root),
      });

      expect(yield* draw(setup)).toContain("count 0");

      yield* page.act(
        modify(count, (n) => n + 7),
        {
          label: "terminal count update",
          until: () => terminalText(setup.renderer.root).includes("count 7"),
        },
      );
      expect(yield* draw(setup)).toContain("count 7");
    }),
  );

  it.scoped("typing into an input sends every keystroke to the draft actor", () =>
    Effect.gen(function* () {
      const setup = yield* makeTerminal();
      const draft = yield* Actor.local(Behavior.value(""));
      yield* View.mount(Composer, { draft }, makeHost(setup.renderer), setup.renderer.root);

      // A terminal input only receives keys while it holds focus.
      yield* Effect.sync(() => {
        for (const node of setup.renderer.root.getChildren()) {
          if (node instanceof InputRenderable) {
            node.focus();
          }
        }
      });
      yield* Effect.promise(() => setup.renderOnce());
      yield* Effect.promise(() => setup.mockInput.typeText("ab"));
      yield* Stream.runHead(Stream.filter(draft.state.changes, (value) => value === "ab"));
      expect(yield* draft.state.get).toBe("ab");
    }),
  );
});

describe("readiness on the OpenTUI host", () => {
  it.scoped(
    "runs a retained pending-to-ready boundary and closes it on the headless OpenTUI host",
    () =>
      Effect.gen(function* () {
        const setup: TestRendererSetup = yield* Effect.promise(() =>
          createTestRenderer({ width: 32, height: 6 }),
        );
        yield* Effect.addFinalizer(() => Effect.sync(() => setup.renderer.destroy()));
        const state = yield* Actor.local(
          Behavior.value<QueryState<string, string>>({ _tag: "Loading" }),
        );
        const Page = () =>
          Effect.gen(function* () {
            const boundary = yield* View.loading({
              fallback: <text>loading</text>,
              content: Effect.gen(function* () {
                const value = yield* View.ready(state.state, "");
                return <text>{View.bind(value)}</text>;
              }),
            });
            return <box>{boundary}</box>;
          });
        const page = yield* ViewTest.make({
          host: makeHost(setup.renderer),
          root: setup.renderer.root,
          setup: (host, root) => View.mount(Page, {}, host, root),
        });
        yield* View.flush;
        yield* Effect.promise(() => setup.renderOnce());
        expect(setup.captureCharFrame()).toContain("loading");

        yield* page.act(state.call(Value.Set({ _tag: "Ready", value: "ready", stale: false })), {
          label: "OpenTUI retained content appears",
          until: (root) => terminalText(root).includes("ready"),
        });
        yield* View.flush;
        yield* Effect.promise(() => setup.renderOnce());
        expect(setup.captureCharFrame()).toContain("ready");

        yield* page.close;
        yield* View.flush;
        yield* Effect.promise(() => setup.renderOnce());
        expect(setup.captureCharFrame()).not.toContain("ready");
      }),
  );

  it.scoped("keeps the retained presentation generic over the OpenTUI Host contract", () =>
    Effect.sync(() => {
      const factory: (context: RenderContext) => Host<TuiNode> = makeHost;
      expect(factory).toBe(makeHost);
    }),
  );
});
