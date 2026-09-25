/* oxlint-disable effect/noAsyncFunction, effect/noTryCatch, no-await-in-loop, effect/noTestLifecycleHooks -- this proof drives real WebKit and Chrome pages through Bun.WebView, over one Notes server the file shares. */
/**
 * #31 in the app, in real browsers: the real Notes server and its real
 * client bundle. A push scrolls to the top when the new shell commits, while
 * its counts are still held on the server; Back puts the list page's
 * position back once its notes are drawn again; a search typed into
 * `/lists` is a `stayed` transition that keeps focus and the caret; and the
 * router leaves `history.scrollRestoration` as `"auto"`. Scroll and focus are platform
 * facts, so no fake window proves them.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { Actor, ActorTransport, CommandId } from "effect-frame/actor/client";
import { Context, Effect, Exit, Schema, Scope } from "effect";
import { Notes } from "../src/contract.js";
import { ListName, keyOf } from "../src/queries.js";
import { serve } from "../src/server.js";
import type { Engine } from "./browser.js";
import { hasNavigation, open, waitFor } from "./browser.js";
import { clientOf, tappedHost } from "./fixture.js";

const engines: ReadonlyArray<Engine> = ["chrome", "webkit"];
const commandId = Schema.decodeSync(CommandId);
const listName = Schema.decodeSync(ListName);

/** A real Notes server over a wiretapped host, and an inbox long enough to scroll. */
const start = Effect.gen(function* () {
  const wire = yield* tappedHost;
  const server = yield* Effect.provideContext(
    serve(0),
    Context.make(ActorTransport, wire.transport),
  );
  const client = yield* clientOf(server.url);
  const writer = yield* client(Actor.remote(Notes, keyOf(listName("inbox"))));
  for (let index = 0; index < 80; index += 1) {
    yield* writer.call(
      { _tag: "Add", id: `n${String(index)}`, text: `note ${String(index)}` },
      { commandId: commandId(`seed-${String(index)}`), timeout: "2 seconds" },
    );
  }
  return { wire, server };
});

// One server for the file. The host, the server and the client live in `scope`.
const scope = Effect.runSync(Scope.make());
const live = await Effect.runPromise(Scope.provide(start, scope));

afterAll(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void));
});

const available = new Map<Engine, boolean>();
for (const engine of engines) {
  available.set(
    engine,
    await hasNavigation(engine, live.server.url, `Notes navigation in ${engine}`),
  );
}

const read = <A>(view: Bun.WebView, expression: string): Promise<A> => view.evaluate<A>(expression);

const openAt = async (engine: Engine, path: string): Promise<Bun.WebView> => {
  const view = await open(engine, `${live.server.url}${path}`);
  await waitFor(view, `document.documentElement.dataset.hydrated === "true"`, "hydrated");
  return view;
};

for (const engine of engines) {
  describe.skipIf(available.get(engine) !== true)(`Notes navigation in ${engine}`, () => {
    it("a push scrolls to the top at shell commit; Back restores the list's position", async () => {
      const view = await openAt(engine, "/lists/inbox");
      try {
        expect(await read<string>(view, "history.scrollRestoration")).toBe("auto");
        await waitFor(view, `document.querySelectorAll("#list li").length === 80`, "80 notes");
        expect(await read<number>(view, "(scrollTo(0, 700), scrollY)")).toBe(700);

        // The errands counts wait on the server: the shell commits without them.
        const held = await Effect.runPromise(live.wire.holdQuery("ListCounts"));
        try {
          // The link is scrolled out of view: a script click, which the
          // router's delegated listener follows as a push.
          await read(
            view,
            `(document.querySelector('#names a[href="/lists/errands"]').click(), true)`,
          );
          await waitFor(view, `location.pathname === "/lists/errands"`, "the push committed");
          await waitFor(view, "scrollY === 0", "the top, while the counts are held");
          expect(
            await read<string>(view, `document.querySelector("#counts")?.textContent ?? ""`),
          ).not.toBe("0 of 0 done");
        } finally {
          await Effect.runPromise(live.wire.open(held));
        }
        await waitFor(
          view,
          `document.querySelector("#list-name")?.textContent === "errands"`,
          "the errands list",
        );

        await read(view, "(history.back(), true)");
        await waitFor(
          view,
          `document.querySelector("#list-name")?.textContent === "inbox"`,
          "back on the inbox",
        );
        // The inbox's notes are read again on Back: the router places the
        // saved position once that read settled and is drawn (#31).
        await waitFor(view, "scrollY === 700", "the inbox position restored");
        expect(await read<string>(view, "history.scrollRestoration")).toBe("auto");
      } finally {
        view.close();
      }
    });

    it("a push lands at the top at shell commit even when the page is still tall", async () => {
      const view = await openAt(engine, "/lists/inbox");
      try {
        // A page that stays taller than the viewport through the push, so a
        // top the browser clamps to cannot pass for the router's own scroll.
        await read(view, `(document.body.style.minHeight = "5000px", true)`);
        expect(await read<number>(view, "(scrollTo(0, 700), scrollY)")).toBe(700);
        const held = await Effect.runPromise(live.wire.holdQuery("ListCounts"));
        try {
          await read(
            view,
            `(document.querySelector('#names a[href="/lists/reading"]').click(), true)`,
          );
          await waitFor(view, `location.pathname === "/lists/reading"`, "the push committed");
          await waitFor(view, "scrollY === 0", "the top, while the counts are held");
          expect(await read<number>(view, "document.documentElement.scrollHeight")).toBeGreaterThan(
            1000,
          );
        } finally {
          await Effect.runPromise(live.wire.open(held));
        }
      } finally {
        view.close();
      }
    });

    it("a search typed into /lists is a stayed transition that keeps focus and the caret", async () => {
      const view = await openAt(engine, "/lists");
      try {
        await read(view, `(document.querySelector("#index").dataset.probe = "kept", true)`);
        await view.click("#q");
        await view.type("inb");
        await waitFor(view, `location.search === "?q=inb"`, "the search in the URL");
        await waitFor(view, `document.querySelectorAll("#found li").length === 1`, "one match");
        const caret = `[document.activeElement.id, document.activeElement.selectionStart, document.activeElement.selectionEnd]`;
        expect(await read<ReadonlyArray<unknown>>(view, caret)).toEqual(["q", 3, 3]);
        // The same view: the index was not set up again.
        expect(await read<string>(view, `document.querySelector("#index").dataset.probe`)).toBe(
          "kept",
        );
        expect(await read<string>(view, "history.scrollRestoration")).toBe("auto");
      } finally {
        view.close();
      }
    });
  });
}
