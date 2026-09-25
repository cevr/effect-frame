import { registerDom } from "./dom-setup.js";

registerDom();

import { Behavior, implementTransparent } from "effect-frame/actor";
import { Generated, contract, ref } from "effect-frame/actor/client";
import { Dom, Html, View } from "effect-frame/view";
import {
  Deferred,
  Effect,
  Layer,
  Option,
  Ref,
  Schedule,
  Schema,
  SchemaTransformation,
  Stream,
} from "effect";
import { describe, expect, it } from "effect-bun-test";
import type { NoProps, Wire } from "../plain-form-fixture.js";
import { hiddenValue, makeWire, noProps, recordedTransport } from "../plain-form-fixture.js";

/**
 * The scripted binding chooses a command id, decodes, and spends the id as
 * one step per form (#21 §5, #32 §4). The DOM host forks each submit, so a
 * decoder that waits lets two submits overlap. The first takes the rendered
 * id; the second must mint its own, or it posts other bytes under the first
 * one's id and the store refuses it.
 */

const heldKey = { id: "a" };

/** One form whose `text` field decodes only after `gate` opens. */
const heldForm = (gate: Deferred.Deferred<void>) => {
  const Note = Schema.TaggedStruct("Note", {
    id: Generated.fromCommandId(Schema.String),
    text: Schema.String.pipe(
      Schema.decodeTo(
        Schema.String,
        SchemaTransformation.transformEffect({
          decode: (text: string) => Effect.as(Deferred.await(gate), text),
          encode: (text: string) => Effect.succeed(text),
        }),
      ),
    ),
  });
  const Held = contract("Held", {
    version: 1,
    policy: "public",
    key: Schema.Struct({ id: Schema.String }),
    snapshot: Schema.Struct({ notes: Schema.Array(Schema.String) }),
    message: Schema.Union([Note]),
  });
  type HeldState = Schema.Schema.Type<typeof Held.snapshot>;
  const HeldLive = implementTransparent(
    Held,
    Behavior.reducer<HeldState, Schema.Schema.Type<typeof Note>>({
      initial: { notes: [] },
      reduce: (state, note) => ({ notes: [...state.notes, note.text] }),
    }),
  );
  const HeldPage = (_props: NoProps) =>
    Effect.gen(function* () {
      const notes = yield* ref(Held, heldKey);
      const note = yield* View.form({
        ref: notes,
        contract: Held,
        key: heldKey,
        message: Note,
        typed: ["text"],
        endpoint: "/actors",
        returnTo: "/",
      });
      return (
        <form id="note" onSubmit={note.submit}>
          <input id="text" name="text" />
        </form>
      );
    });
  const notesAt = (revision: number) =>
    Effect.scoped(
      Effect.flatMap(ref(Held, heldKey), (notes) =>
        Stream.runHead(
          Stream.filter(notes.applied.changes, (applied) => applied.revision.value >= revision),
        ),
      ),
    ).pipe(Effect.flatMap(Effect.fromOption), Effect.timeout("2 seconds"), Effect.orDie);
  return { HeldLive, HeldPage, notesAt };
};

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

const sendAt = (sends: Wire["sends"] extends Ref.Ref<infer A> ? A : never, index: number) =>
  Option.getOrThrow(Option.fromNullishOr(sends[index]));

/** Render on the server, hydrate the markup, and hand back the form. */
const hydrated = (page: (props: NoProps) => ReturnType<ReturnType<typeof heldForm>["HeldPage"]>) =>
  Effect.gen(function* () {
    const html = yield* Effect.scoped(Html.renderToString(page, noProps));
    const main = yield* install(html);
    const hydration = Dom.hydrate(main);
    yield* View.mount(page, noProps, hydration.host, main);
    yield* View.flush;
    expect(yield* hydration.finish).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 0 });
    return {
      rendered: hiddenValue(html, "note", "$command"),
      form: element(main, "#note", HTMLFormElement),
    };
  });

describe("concurrent submits of one command form", () => {
  it.scopedLive(
    "two submits held at the decoder: the first takes the rendered id, the second mints its own",
    () =>
      Effect.gen(function* () {
        const wire = yield* makeWire;
        const gate = yield* Deferred.make<void>();
        const held = heldForm(gate);
        const host = yield* Layer.build(recordedTransport(wire, [held.HeldLive]));
        yield* Effect.gen(function* () {
          const { rendered, form } = yield* hydrated(held.HeldPage);
          const text = element(form, "#text", HTMLInputElement);

          text.value = "first";
          yield* submit(form);
          text.value = "second";
          yield* submit(form);
          // Both submits are in flight before either decode can finish.
          yield* Effect.sleep("30 millis");
          expect(yield* Ref.get(wire.sends)).toEqual([]);
          yield* Deferred.completeWith(gate, Effect.void);

          const sends = yield* sendsAfter(wire, 2);
          const [first, second] = [sendAt(sends, 0), sendAt(sends, 1)];
          expect(String(first.commandId)).toBe(rendered);
          expect(String(second.commandId)).not.toBe(rendered);
          expect(first.payload).toContain('"first"');
          expect(second.payload).toContain('"second"');
          expect(second.payload).toContain(String(second.commandId));

          // Neither conflicts: two admissions, and each message applies once.
          const applied = yield* held.notesAt(2);
          expect(applied.state.notes).toEqual(["first", "second"]);
          expect((yield* Ref.get(wire.replies)).map((reply) => reply.admitted)).toEqual([1, 2]);
        }).pipe(Effect.provideContext(host));
      }),
    10_000,
  );

  it.scopedLive("a submit that does not decode leaves the id for the next valid submit", () =>
    Effect.gen(function* () {
      const wire = yield* makeWire;
      const gate = yield* Deferred.make<void>();
      yield* Deferred.completeWith(gate, Effect.void);
      const held = heldForm(gate);
      const host = yield* Layer.build(recordedTransport(wire, [held.HeldLive]));
      yield* Effect.gen(function* () {
        const { rendered, form } = yield* hydrated(held.HeldPage);

        // An empty value is dropped, so the required `text` is missing.
        yield* submit(form);
        yield* Effect.sleep("30 millis");
        expect(yield* Ref.get(wire.sends)).toEqual([]);

        element(form, "#text", HTMLInputElement).value = "later";
        yield* submit(form);
        const sends = yield* sendsAfter(wire, 1);
        expect(String(sendAt(sends, 0).commandId)).toBe(rendered);
        const applied = yield* held.notesAt(1);
        expect(applied.state.notes).toEqual(["later"]);
      }).pipe(Effect.provideContext(host));
    }),
  );
});
