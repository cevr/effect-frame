/** @jsxImportSource effect-frame/view/opentui */
import { Source } from "effect-frame/actor";
import type { Node } from "effect-frame/view";
import { View } from "effect-frame/view";
import { Effect } from "effect";
import { describe, expect, test } from "bun:test";

/**
 * A terminal file names its runtime, and its tags are the renderables the
 * OpenTUI host builds, with their own options as props. Compile-time checks.
 */

const count = Source.succeed(1);
const send = () => Effect.void;

const written: ReadonlyArray<Node> = [
  <box flexDirection="column" width={30} border={true}>
    <text>{View.bind(count, (n) => `count ${String(n)}`)}</text>
  </box>,
  <input width={View.bind(count)} placeholder="note" onEnter={View.event(send)} />,
];

const refused: ReadonlyArray<Node> = [
  // @ts-expect-error an HTML tag is not a terminal tag
  <p>html</p>,
  // @ts-expect-error `flexDirection` takes a layout direction
  <box flexDirection="sideways" />,
  // @ts-expect-error an option OpenTUI takes as a callback is not a prop
  <box onMouseDown={View.event(send)} />,
  // @ts-expect-error wrap the handler with View.event(handler)
  <input onInput={() => send()} />,
];

describe("typed terminal elements", () => {
  test("the terminal map compiles its tags and refuses HTML ones", () => {
    expect(written).toHaveLength(2);
    expect(refused).toHaveLength(4);
  });
});
