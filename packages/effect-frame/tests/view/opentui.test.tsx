import { Behavior, Value, modify, select, spawn } from "effect-frame/actor";
import type { LocalActorRef, SetValue } from "effect-frame/actor";
import { View, mount, render } from "effect-frame/view";
import { make as makeHost } from "effect-frame/view/opentui";
import { InputRenderable } from "@opentui/core";
import type { TestRendererSetup } from "@opentui/core/testing";
import { createTestRenderer } from "@opentui/core/testing";
import { Effect } from "effect";
import { describe, expect, it } from "effect-bun-test";

/** One headless terminal per test, destroyed with the test's scope. */
const makeTerminal = Effect.fn("test.makeTerminal")(function* () {
  const setup: TestRendererSetup = yield* Effect.promise(() =>
    createTestRenderer({ width: 32, height: 6 }),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => setup.renderer.destroy()));
  return setup;
});

/** Flush the reactive graph, draw one frame, and read it back. */
const draw = Effect.fn("test.draw")(function* (setup: TestRendererSetup) {
  yield* render;
  yield* Effect.promise(() => setup.renderOnce());
  return setup.captureCharFrame();
});

interface CounterProps {
  readonly count: LocalActorRef<number, SetValue<number>>;
}

const Counter = View.make((props: CounterProps) =>
  Effect.succeed(
    <box flexDirection="column" width={30} height={3}>
      <text>{View.bind(select(props.count.state, (n) => `count ${n}`))}</text>
    </box>,
  ),
);

interface DraftProps {
  readonly draft: LocalActorRef<string, SetValue<string>>;
}

const Composer = View.make((props: DraftProps) =>
  Effect.succeed(
    <input
      width={20}
      onInput={View.event((event) =>
        props.draft
          .send(Value.Set(event.value))
          .pipe(Effect.catchTag("ActorStopped", () => Effect.void)),
      )}
    />,
  ),
);

describe("terminal view", () => {
  it.scoped("the same view draws a bound source in a terminal", () =>
    Effect.gen(function* () {
      const setup = yield* makeTerminal();
      const count = yield* spawn(Behavior.value(0));
      yield* mount(Counter, { count }, makeHost(setup.renderer), setup.renderer.root);

      expect(yield* draw(setup)).toContain("count 0");

      yield* modify(count, (n) => n + 7);
      expect(yield* draw(setup)).toContain("count 7");
    }),
  );

  it.scoped("typing into an input sends every keystroke to the draft actor", () =>
    Effect.gen(function* () {
      const setup = yield* makeTerminal();
      const draft = yield* spawn(Behavior.value(""));
      yield* mount(Composer, { draft }, makeHost(setup.renderer), setup.renderer.root);

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
      yield* render;
      expect(yield* draft.state.get).toBe("ab");
    }),
  );
});
