import { registerDom } from "./dom-setup.js";

registerDom();

import { ActorHost, Behavior, Policies, Policy, implementTransparent } from "effect-frame/actor";
import { ActorTransport, contract, ref } from "effect-frame/actor/client";
import type { TransportService } from "effect-frame/actor/client";
import { Dom, Html, View } from "effect-frame/view";
import { Deferred, Effect, Layer, Option, Ref, Schedule, Schema } from "effect";
import { describe, expect, it } from "effect-bun-test";
import type { NoProps } from "../plain-form-fixture.js";
import { hiddenValue, noProps } from "../plain-form-fixture.js";

/**
 * Fresh-ID ownership for forms (#67 §3, #37). A form whose command id the
 * client binding minted itself predicts at once, as a plain `send` does. An
 * id the server drew into the markup may already be in a mailbox (a plain
 * post can race hydration), so its send is supplied and waits for receipt
 * evidence. Each later send from the same form mints, so it predicts.
 */

const Note = Schema.TaggedStruct("Note", { text: Schema.String });
type Note = Schema.Schema.Type<typeof Note>;
const Shelf = contract("PredictedShelf", {
  version: 1,
  policy: "public",
  key: Schema.Struct({ id: Schema.String }),
  snapshot: Schema.Struct({ notes: Schema.Array(Schema.String) }),
  message: Schema.Union([Note]),
});
type ShelfState = Schema.Schema.Type<typeof Shelf.snapshot>;
const shelfKey = { id: "a" };

const reducer = Behavior.reducer<ShelfState, Note>({
  initial: { notes: [] },
  reduce: (state, note) => ({ notes: [...state.notes, note.text] }),
});
const ShelfLive = implementTransparent(Shelf, { behavior: reducer });

const ShelfPage = (_props: NoProps) =>
  Effect.gen(function* () {
    const shelf = yield* ref(Shelf, shelfKey, { resume: Option.none(), behavior: reducer });
    const note = yield* View.form({
      ref: shelf,
      contract: Shelf,
      key: shelfKey,
      message: Note,
      typed: ["text"],
      endpoint: "/actors",
      returnTo: "/",
    });
    return (
      <main>
        <form id="note" onSubmit={note.submit}>
          <input id="text" name="text" />
        </form>
        <p id="shown">{View.bind(shelf.state, (state) => state.notes.join(","))}</p>
      </main>
    );
  });

/** The real host; every send is held until the test opens its gate. */
const heldHost = (gate: Deferred.Deferred<void>, sent: Ref.Ref<ReadonlyArray<string>>) =>
  Layer.effect(
    ActorTransport,
    Effect.gen(function* () {
      const real = yield* ActorHost.make({
        implementations: [ShelfLive],
        store: ActorHost.memoryStore,
      });
      const transport: TransportService = {
        ...real,
        send: (address, commandId, payload, active) =>
          Effect.gen(function* () {
            yield* Ref.update(sent, (seen) => [...seen, String(commandId)]);
            yield* Deferred.await(gate);
            return yield* real.send(address, commandId, payload, active);
          }),
      };
      return transport;
    }),
  ).pipe(Layer.provide(Layer.succeed(Policies, Policies.of({ public: Policy.allowAll }))));

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

const textOf = (root: ParentNode, selector: string) =>
  Option.getOrElse(
    Option.flatMap(Option.fromNullishOr(root.querySelector(selector)), (found) =>
      Option.fromNullishOr(found.textContent),
    ),
    () => "",
  );

const submitText = (root: ParentNode, text: string) =>
  Effect.gen(function* () {
    element(root, "#text", HTMLInputElement).value = text;
    const form = element(root, "#note", HTMLFormElement);
    yield* Effect.sync(() =>
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
  });

/** Wait until the transport has seen `count` sends, then let the view draw. */
const sendsReach = (sent: Ref.Ref<ReadonlyArray<string>>, count: number) =>
  Effect.andThen(
    Ref.get(sent).pipe(
      Effect.repeat({
        until: (seen) => seen.length >= count,
        schedule: Schedule.spaced("5 millis"),
        times: 200,
      }),
    ),
    View.flush,
  );

/** Wait until the view shows `expected`. */
const shows = (root: ParentNode, expected: string) =>
  Effect.andThen(
    View.flush,
    Effect.sync(() => textOf(root, "#shown")),
  ).pipe(
    Effect.repeat({
      until: (shown) => shown === expected,
      schedule: Schedule.spaced("5 millis"),
      times: 200,
    }),
  );

describe("form predictions follow who minted the command id (#67 §3)", () => {
  it.scopedLive("a form the client drew mints its own id, so its send predicts at once", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const sent = yield* Ref.make<ReadonlyArray<string>>([]);
      const host = yield* Layer.build(heldHost(gate, sent));
      yield* Effect.gen(function* () {
        const main = yield* install("");
        yield* View.mount(ShelfPage, noProps, Dom.host, main);
        yield* View.flush;
        expect(textOf(main, "#shown")).toBe("");

        yield* submitText(main, "first");
        yield* sendsReach(sent, 1);
        // The send is held before the host: only a prediction can show it.
        expect(textOf(main, "#shown")).toBe("first");

        yield* Deferred.succeed(gate, void 0);
        expect(yield* shows(main, "first")).toBe("first");
      }).pipe(Effect.provideContext(host));
    }),
  );

  it.scopedLive(
    "a hydrated form's first send carries the server's id and waits; its next send predicts",
    () =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const sent = yield* Ref.make<ReadonlyArray<string>>([]);
        const host = yield* Layer.build(heldHost(gate, sent));
        yield* Effect.gen(function* () {
          const html = yield* Effect.scoped(Html.renderToString(ShelfPage, noProps));
          const main = yield* install(html);
          const hydration = Dom.hydrate(main);
          yield* View.mount(ShelfPage, noProps, hydration.host, main);
          yield* View.flush;
          yield* hydration.finish;

          yield* submitText(main, "posted");
          yield* sendsReach(sent, 1);
          expect((yield* Ref.get(sent))[0]).toBe(hiddenValue(html, "note", "$command"));
          // The server's id may already be in a mailbox: no prediction.
          expect(textOf(main, "#shown")).toBe("");

          yield* submitText(main, "second");
          yield* sendsReach(sent, 2);
          // A later send mints its own id, so it predicts over the held first.
          expect(textOf(main, "#shown")).toBe("second");

          yield* Deferred.succeed(gate, void 0);
          expect(yield* shows(main, "posted,second")).toBe("posted,second");
        }).pipe(Effect.provideContext(host));
      }),
  );
});
