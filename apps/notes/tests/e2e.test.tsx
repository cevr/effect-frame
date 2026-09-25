import { View } from "effect-frame/view";
import { platformFetch, registerDom } from "./dom-setup.js";

registerDom();

import { serverOnly } from "effect-frame/actor";
import { CommandId, Form, ref } from "effect-frame/actor/client";
import { make as makeTuiHost } from "effect-frame/view/opentui";
import type { TestRendererSetup } from "@opentui/core/testing";
import { createTestRenderer } from "@opentui/core/testing";
import { Effect, Option, Schema } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { Notes, demoKey } from "../src/contract.js";
import type { RunningServer } from "../src/server.js";
import { NotesTerminal } from "../src/terminal-view.js";
import {
  clientOf,
  elementOf,
  fetchText,
  hydrateAt,
  install,
  notesRuntime,
  serve,
  settle,
  textOf,
} from "./fixture.js";

/**
 * The end-to-end proof. One contract, one real Bun server on a free port,
 * and two live clients: a hydrated browser page and a terminal. Nothing is
 * mocked: both clients talk HTTP to the same actor.
 *
 * The page is the inbox's print page, `/lists/inbox/print`: `AwaitAll`, so
 * the server draws the whole list page, notes and compose form included, and
 * the client claims every node. It is the same `ListView` the list page uses.
 */

const id = Schema.decodeSync(CommandId);

const inbox = "/lists/inbox/print";

/** Flush the reactive graph, draw one terminal frame, and read it back. */
const draw = Effect.fn("test.draw")(function* (setup: TestRendererSetup) {
  yield* View.flush;
  yield* Effect.promise(() => setup.renderOnce());
  return setup.captureCharFrame();
});

describe("notes end to end", () => {
  it.scopedLive("the server renders the list page, and the bundle carries no server code", () =>
    Effect.gen(function* () {
      const runtime = yield* notesRuntime;
      const server = yield* serve(runtime);

      const page = yield* fetchText(`${server.url}${inbox}`);
      expect(page).toContain('<main id="app">');
      expect(page).toContain('<h1 id="list-name">inbox</h1>');
      expect(page).toContain('<ul id="list"></ul>');
      expect(page).toContain('<p id="count">0</p>');
      expect(page).toContain('id="frame-query-seed"');
      expect(page).toContain('src="/client.js"');

      const bundle = yield* fetchText(`${server.url}/client.js`);
      expect(bundle.length).toBeGreaterThan(0);
      expect(bundle).not.toContain(serverOnly);
      expect(bundle).not.toContain("effect-frame/src/actor/mailbox-store/MailboxStore");
      expect(bundle).not.toContain("effect-frame/src/actor/policy/Policies");
    }),
  );

  it.scopedLive("the browser hydrates the server page and follows a second client", () =>
    Effect.gen(function* () {
      const runtime = yield* notesRuntime;
      const server = yield* serve(runtime);
      const page = yield* fetchText(`${server.url}${inbox}`);
      const root = yield* install(page);

      const { report } = yield* (yield* clientOf(server.url))(
        hydrateAt(root, `${server.url}${inbox}`),
      );
      expect(report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 0 });

      const writer = yield* (yield* clientOf(server.url))(ref(Notes, demoKey));
      yield* writer.call(
        { _tag: "Add", id: "n1", text: "buy milk" },
        { commandId: id("c1"), timeout: "2 seconds" },
      );

      yield* settle(Effect.sync(() => textOf(root, "#count") === "1"));
      expect(textOf(root, "#list li span")).toBe("buy milk");
      expect(textOf(root, "#count")).toBe("1");
    }),
  );

  it.scopedLive("the terminal sees the same actor at the same revision", () =>
    Effect.gen(function* () {
      const runtime = yield* notesRuntime;
      const server = yield* serve(runtime);
      const page = yield* fetchText(`${server.url}${inbox}`);
      const root = yield* install(page);

      const browser = yield* (yield* clientOf(server.url))(
        Effect.andThen(hydrateAt(root, `${server.url}${inbox}`), ref(Notes, demoKey)),
      );

      const setup: TestRendererSetup = yield* Effect.promise(() =>
        createTestRenderer({ width: 60, height: 12 }),
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => setup.renderer.destroy()));

      const terminal = yield* (yield* clientOf(server.url))(
        Effect.andThen(
          View.mount(
            NotesTerminal,
            { key: demoKey, resume: Option.none() },
            makeTuiHost(setup.renderer),
            setup.renderer.root,
          ),
          ref(Notes, demoKey),
        ),
      );

      yield* browser.call(
        { _tag: "Add", id: "n2", text: "walk dog" },
        { commandId: id("c2"), timeout: "2 seconds" },
      );

      const target = yield* browser.applied.get;
      yield* settle(
        Effect.map(
          terminal.applied.get,
          (applied) => applied.revision.value === target.revision.value,
        ),
      );
      yield* settle(Effect.sync(() => textOf(root, "#list li span") === "walk dog"));
      const frame = yield* draw(setup);
      expect(frame).toContain("walk dog");
      expect(textOf(root, "#list li span")).toBe("walk dog");
      expect(yield* terminal.applied.get).toEqual(yield* browser.applied.get);
    }),
  );

  it.scopedLive("a restarted server keeps the actors and the page follows again", () =>
    Effect.gen(function* () {
      const runtime = yield* notesRuntime;
      const first: RunningServer = yield* serve(runtime);
      const page = yield* fetchText(`${first.url}${inbox}`);
      const root = yield* install(page);

      const client = yield* (yield* clientOf(first.url))(
        Effect.andThen(hydrateAt(root, `${first.url}${inbox}`), ref(Notes, demoKey)),
      );

      yield* Effect.promise(() => first.stop());
      yield* serve(runtime, first.port);

      yield* client.call(
        { _tag: "Add", id: "n3", text: "after restart" },
        { commandId: id("c3"), timeout: "5 seconds" },
      );

      yield* settle(Effect.sync(() => textOf(root, "#count") === "1"));
      expect(textOf(root, "#list li span")).toBe("after restart");
    }),
  );

  it.scopedLive("a post that races hydration applies once", () =>
    Effect.gen(function* () {
      const runtime = yield* notesRuntime;
      const server = yield* serve(runtime);
      const page = yield* fetchText(`${server.url}${inbox}`);
      const root = yield* install(page);

      const client = yield* (yield* clientOf(server.url))(
        Effect.andThen(hydrateAt(root, `${server.url}${inbox}`), ref(Notes, demoKey)),
      );
      const form = elementOf(root, "#compose", HTMLFormElement);
      const draft = elementOf(root, "#draft", HTMLInputElement);
      draft.value = "race";

      // The native post left before the script took over; the script then
      // sends the same form. Both carry the id the server rendered.
      const body = Form.toBody(Form.fromEntries(new FormData(form)));
      const native = yield* Effect.promise(() =>
        platformFetch(`${server.url}/actors/form`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
          redirect: "manual",
        }),
      );
      yield* Effect.sync(() =>
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );

      expect(native.status).toBe(303);
      // The draft clears only after the scripted send returned its handle.
      yield* settle(Effect.sync(() => draft.value === ""));
      expect(draft.value).toBe("");
      yield* settle(Effect.sync(() => textOf(root, "#count") === "1"));
      const applied = yield* client.applied.get;
      expect(applied.revision.value).toBe(1);
      expect(applied.state.notes.map((note) => note.text)).toEqual(["race"]);
      expect(applied.state.notes[0]?.id).toBe(
        Form.last(Form.fromBody(body), "$command").pipe(Option.getOrElse(() => "")),
      );
    }),
  );
});
