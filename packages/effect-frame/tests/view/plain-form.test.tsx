import { registerDom } from "./dom-setup.js";

registerDom();

import { CommandId } from "effect-frame/actor";
import { Form } from "effect-frame/actor/client";
import { Dom, Html, mount, render } from "effect-frame/view";
import { Effect, Option, Random, Ref, Schedule, Schema } from "effect";
import { describe, expect, it } from "effect-bun-test";
import type { Wire } from "../plain-form-fixture.js";
import {
  Tasks,
  TasksPage,
  hiddenOf,
  hiddenValue,
  makeWire,
  noProps,
  recordedTransport,
} from "../plain-form-fixture.js";

/**
 * The form binding in both hosts (#21 §1, §5; #32 §4). The server writes
 * the plain post; the hydrating client adopts it and sends what it
 * carries. One in-process host serves both halves, so what the client
 * sends is what the transport records.
 */

const withWire = <A, E, R>(body: (wire: Wire) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(makeWire, (wire) =>
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(body(wire), recordedTransport(wire)),
  );

const renderServer = Effect.scoped(Html.renderToString(TasksPage, noProps));

const decodePayload = Schema.decodeEffect(Tasks.message);

/** Put the server's markup into the document the way a browser would. */
const install = (html: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const main = document.createElement("main");
      main.innerHTML = html;
      document.body.appendChild(main);
      return main;
    }),
    (main) => Effect.sync(() => main.remove()),
  );

const element = <T extends Element>(root: ParentNode, selector: string, type: new () => T) =>
  Option.getOrThrow(
    Option.filter(
      Option.fromNullishOr(root.querySelector(selector)),
      (found): found is T => found instanceof type,
    ),
  );

/** Submit the form as a person would: the event, cancelable, from the form. */
const submit = (form: HTMLFormElement) =>
  Effect.sync(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));

const sendsAfter = (wire: Wire, count: number) =>
  Ref.get(wire.sends).pipe(
    Effect.repeat({
      until: (sends) => sends.length >= count,
      schedule: Schedule.spaced("5 millis"),
      times: 200,
    }),
  );

describe("the command form binding", () => {
  it.scopedLive("a submit binding renders method, action, and the four framework fields", () =>
    withWire(() =>
      Effect.gen(function* () {
        const html = yield* renderServer;

        expect(html).toContain('<form id="add" method="post" action="/actors/form">');
        expect(hiddenOf(html, "add").map(([name]) => name)).toEqual([
          "$command",
          "$contract",
          "$version",
          "$key",
          "$return",
          "_tag",
          "id",
        ]);
        // The hidden inputs come first, so an author field can never precede them.
        const form = html.slice(html.indexOf('<form id="add"'));
        expect(form.indexOf('<input type="hidden" name="$command"')).toBeLessThan(
          form.indexOf('<input id="title"'),
        );
        expect(hiddenValue(html, "add", "$contract")).toBe("Tasks");
        expect(hiddenValue(html, "add", "$version")).toBe("1");
        expect(hiddenValue(html, "add", "$key")).toBe("tenant=acme&board=main");
        expect(hiddenValue(html, "add", "$return")).toBe("/");
        expect(hiddenValue(html, "add", "_tag")).toBe("AddTask");
        // No event handler is ever written into markup.
        expect(html).not.toContain("onSubmit");
        expect(html).not.toContain("onsubmit");
      }),
    ),
  );

  it.scopedLive("the hidden `id` and `$command` hold the same value", () =>
    withWire(() =>
      Effect.gen(function* () {
        const first = yield* renderServer;
        const second = yield* renderServer;

        const command = hiddenValue(first, "add", "$command");
        expect(command).not.toBe("");
        expect(hiddenValue(first, "add", "id")).toBe(command);
        // Every render mints its own id, and the generated value follows it.
        expect(hiddenValue(second, "add", "$command")).not.toBe(command);
        expect(hiddenValue(second, "add", "id")).toBe(hiddenValue(second, "add", "$command"));
      }),
    ),
  );

  it.scopedLive("a message with a generated field renders it as a hidden input", () =>
    withWire(() =>
      Effect.gen(function* () {
        const seeded = yield* Random.withSeed(renderServer, "tags");
        const again = yield* Random.withSeed(renderServer, "tags");

        // A fresh id is drawn beside the command id, from `Random`, at render.
        const tag = hiddenValue(seeded, "tag", "id");
        expect(tag).toMatch(/^[0-9a-z]{8}$/);
        expect(tag).not.toBe(hiddenValue(seeded, "tag", "$command"));
        expect(hiddenValue(again, "tag", "id")).toBe(tag);
        expect(hiddenOf(seeded, "tag").map(([name]) => name)).toContain("id");
      }),
    ),
  );

  it.scopedLive("a redacted field is absent from the repopulated form", () =>
    withWire(() =>
      Effect.gen(function* () {
        const posted = Form.fromEntries([
          ["_tag", "AddTask"],
          ["title", "far too long a title"],
          ["_pin", "4321"],
          ["card._cvc", "999"],
        ]);
        const commandId = yield* Schema.decodeEffect(CommandId)(
          hiddenValue(yield* renderServer, "add", "$command"),
        );
        const issues: Form.FormIssues = {
          contract: "Tasks",
          key: "tenant=acme&board=main",
          commandId,
          issues: [{ field: "title", message: "too long" }],
          submitted: Form.submitted(posted),
        };

        const html = yield* renderServer.pipe(Effect.provideService(Form.FormContext, issues));

        expect(html).toContain('value="far too long a title" aria-invalid="true"');
        expect(html).toContain('<input id="pin" name="_pin">');
        expect(html).not.toContain("4321");
        expect(html).not.toContain("999");
        expect(html).toContain('<li data-field="title">too long</li>');
        expect(hiddenValue(html, "add", "$command")).toBe(String(commandId));
        // An unchecked box stays unchecked after the redraw.
        expect(html).toContain('<input id="done" type="checkbox" name="done">');
      }),
    ),
  );

  it.scopedLive("the hydrated binding sends the adopted `id`, not a fresh one", () =>
    withWire((wire) =>
      Effect.gen(function* () {
        const html = yield* renderServer;
        const rendered = hiddenValue(html, "add", "$command");
        const main = yield* install(html);

        const hydration = Dom.hydrate(main);
        yield* mount(TasksPage, noProps, hydration.host, main);
        yield* render;
        const report = yield* hydration.finish;
        expect(report).toEqual({ mismatches: [], unclaimed: 0 });

        const form = element(main, "#add", HTMLFormElement);
        const hidden = element(form, 'input[name="$command"]', HTMLInputElement);
        // The client rendered its own id, and hydration kept the server's node.
        expect(hidden.value).toBe(rendered);

        element(form, "#title", HTMLInputElement).value = "milk";
        const first = yield* submit(form);
        const [sent] = yield* sendsAfter(wire, 1);

        // The native post was cancelled; the transport carried the rendered identity.
        expect(first).toBe(false);
        const firstSend = Option.getOrThrow(Option.fromNullishOr(sent));
        expect(String(firstSend.commandId)).toBe(rendered);
        const message = yield* decodePayload(firstSend.payload);
        expect(message).toEqual({ _tag: "AddTask", id: rendered, title: "milk", done: false });

        // A later send from the same form mints its own id and its own value.
        element(form, "#title", HTMLInputElement).value = "bread";
        yield* submit(form);
        const sends = yield* sendsAfter(wire, 2);
        const second = Option.getOrThrow(Option.fromNullishOr(sends[1]));
        expect(String(second.commandId)).not.toBe(rendered);
        const next = yield* decodePayload(second.payload);
        expect(next).toEqual({
          _tag: "AddTask",
          id: String(second.commandId),
          title: "bread",
          done: false,
        });
        // The markup still carries the server's id; the binding spent it.
        expect(hidden.value).toBe(rendered);
      }),
    ),
  );
});
