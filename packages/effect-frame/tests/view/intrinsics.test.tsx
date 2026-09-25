import { Source } from "effect-frame/actor";
import type { FormBinding, Node } from "effect-frame/view";
import { View } from "effect-frame/view";
import { Effect } from "effect";
import { describe, expect, test } from "bun:test";

/**
 * The HTML tags are a closed, typed map (`intrinsics.ts`). These are
 * compile-time checks: each `@ts-expect-error` line is a mistake the
 * compiler refuses, and a raw source or a plain function is refused with a
 * message that names its fix.
 */

const count = Source.succeed(1);
const label = Source.succeed("label");
const send = () => Effect.void;
/** A command form binding's submit is the same kind as `View.submit`. */
const commandForm = (binding: FormBinding): Node => <form onSubmit={binding.submit} />;

const written: ReadonlyArray<Node> = [
  <p class="x" data-id={3} aria-label="y" tabindex={-1}>
    {View.bind(count)}
  </p>,
  <p title={View.bind(label)}>{View.bind(label, (text) => text.length)}</p>,
  <button type="button" onClick={View.event(send)} onKeyDown={View.event(send)}>
    go
  </button>,
  <form onSubmit={View.submit(send)}>
    <input name="t" value={View.bind(label)} />
  </form>,
  <a href="#" onClick={View.submit(send)}>
    row
  </a>,
  <label for="t">name</label>,
  <section contenteditable="true" hidden={false} />,
];

const refused: ReadonlyArray<Node> = [
  // @ts-expect-error wrap the source with View.bind(source)
  <p>{count}</p>,
  // @ts-expect-error wrap the source with View.bind(source)
  <p title={label} />,
  // @ts-expect-error wrap the handler with View.event(handler)
  <button onClick={() => send()}>r</button>,
  // @ts-expect-error `className` is not an attribute: HTML spells it `class`
  <div className="x" />,
  // @ts-expect-error `onClik` is not an event
  <button onClik={View.event(send)} />,
  // @ts-expect-error a form's onSubmit suppresses the native post: View.submit, not View.event
  <form onSubmit={View.event(send)} />,
  // @ts-expect-error the runtime writes a command form's method and action
  <form method="post" action="/x" />,
  <input>
    {/* @ts-expect-error an input holds no children */}
    <p />
  </input>,
  // @ts-expect-error `tabIndex` is not an attribute: HTML spells it `tabindex`
  <section tabIndex={0} />,
  // @ts-expect-error `blink` is not an HTML tag
  <blink />,
  // @ts-expect-error a terminal tag is not an HTML tag
  <box />,
];

describe("typed intrinsic elements", () => {
  test("the typed map compiles every written tag and refuses every mistake", () => {
    expect(written).toHaveLength(7);
    expect(commandForm).toBeInstanceOf(Function);
    expect(refused).toHaveLength(11);
  });
});
