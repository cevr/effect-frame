import { registerDom } from "./dom-setup.js";

registerDom();

import { ActorTransport, Generated, QueryCache, Refused, ref } from "effect-frame/actor/client";
import type { QueryState } from "effect-frame/actor/client";
import { Effect, Layer, Option, Schema, Stream } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { notesBehavior, refusedText } from "../src/behavior.js";
import { Notes } from "../src/contract.js";
import type { Counts } from "../src/queries.js";
import { ListCounts, ListName, keyOf } from "../src/queries.js";
import { routes } from "../src/routes.js";
import { makeRuntime } from "../src/server.js";
import { clientOf, elementOf, mountApp, serve, settle, tappedHost, textOf } from "./fixture.js";

/**
 * #19 in the app: the compose form's send returns a handle before its reply
 * lands, the reference predicts the add in the same turn, and a rejection
 * leaves the list as it was. The form mints its own command id on the
 * client, so its send is fresh (#67 §3). The rejection is the behavior's
 * own (#25 §1, #37): it refuses an add of "reject-me", the real host answers
 * `Rejected(Refused)` and commits nothing, and the page predicts with the
 * same rule, so it never shows the refused row.
 */

const inbox = "http://notes.test/lists/inbox";
const inboxName = Schema.decodeSync(ListName)("inbox");

/** The texts of the list's rows, in order. */
const rows = (root: HTMLElement): ReadonlyArray<string> =>
  Array.from(root.querySelectorAll("#list li span")).map((span) => span.textContent);

/** Type `text` into the compose form and submit it, as a reader does. */
const compose = (root: HTMLElement, text: string) =>
  Effect.sync(() => {
    const draft = elementOf(root, "#draft", HTMLInputElement);
    draft.value = text;
    draft.dispatchEvent(new Event("input", { bubbles: true }));
    elementOf(root, "#compose", HTMLFormElement).dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });

describe("the compose form's command", () => {
  it.scopedLive("a held add reads Sent, and its row is on screen before the reply", () =>
    Effect.gen(function* () {
      const wire = yield* tappedHost;
      const app = yield* mountApp({ transport: wire.transport, href: inbox, routes });
      yield* settle(Effect.sync(() => textOf(app.root, "#counts") === "0 of 0 done"));

      const held = yield* wire.holdSend("buy milk");
      yield* compose(app.root, "buy milk");
      yield* settle(
        Effect.sync(() => textOf(app.root, "#status") === "Sent"),
        "status Sent",
      );
      // The host has not seen the command, and the row is already drawn.
      expect(wire.commands).toEqual([]);
      expect(rows(app.root)).toEqual(["buy milk"]);
      expect(textOf(app.root, "#count")).toBe("1");
      expect(textOf(app.root, "#counts")).toBe("0 of 0 done");

      yield* wire.open(held);
      yield* settle(
        Effect.sync(() => textOf(app.root, "#status") === "Applied"),
        "Applied",
      );
      expect(rows(app.root)).toEqual(["buy milk"]);
      yield* settle(
        Effect.sync(() => textOf(app.root, "#counts") === "0 of 1 done"),
        "counts",
      );
    }),
  );

  it.scopedLive(
    "the host refuses a reject-me add, commits nothing, and the list is as it was",
    () =>
      Effect.gen(function* () {
        const wire = yield* tappedHost;
        const app = yield* mountApp({ transport: wire.transport, href: inbox, routes });
        yield* settle(Effect.sync(() => textOf(app.root, "#counts") === "0 of 0 done"));
        yield* compose(app.root, "keep me");
        yield* settle(
          Effect.sync(() => textOf(app.root, "#status") === "Applied"),
          "first add",
        );
        const before = yield* app.run(ref(Notes, keyOf(inboxName), { resume: Option.none() }));
        const committed = yield* before.applied.get;

        const held = yield* wire.holdSend(refusedText);
        yield* compose(app.root, refusedText);
        // Sent, and the page predicts with the host's rule: no row to take back.
        yield* settle(
          Effect.sync(() => textOf(app.root, "#status") === "Sent"),
          "status Sent",
        );
        expect(rows(app.root)).toEqual(["keep me"]);

        yield* wire.open(held);
        yield* settle(
          Effect.sync(() => textOf(app.root, "#status") === "Rejected"),
          "Rejected",
        );
        // The real host refused it: it reached the host, and no revision moved.
        expect(wire.refusals).toEqual([
          {
            text: refusedText,
            reason: Refused.make({ reason: `a note cannot say "${refusedText}"` }),
          },
        ]);
        expect(yield* before.applied.get).toEqual(committed);
        expect(rows(app.root)).toEqual(["keep me"]);
        expect(textOf(app.root, "#count")).toBe("1");
        expect(textOf(app.root, "#counts")).toBe("0 of 1 done");
      }),
  );

  it.scopedLive(
    "over HTTP, the counts stay stale from the first send until the last add settles",
    () =>
      Effect.gen(function* () {
        // A real server whose host holds each add; the client talks HTTP.
        const wire = yield* tappedHost;
        const runtime = yield* Effect.acquireRelease(
          Effect.sync(() => makeRuntime(Layer.succeed(ActorTransport, wire.transport))),
          (built) => Effect.promise(() => built.dispose()),
        );
        const server = yield* serve(runtime);
        const client = yield* clientOf(server.url);
        const heldA = yield* wire.holdSend("a");
        const heldB = yield* wire.holdSend("b");

        yield* client(
          Effect.gen(function* () {
            const cache = yield* QueryCache;
            const counts = yield* cache.open(ListCounts, { list: inboxName });
            const seen: Array<QueryState<Counts, unknown>> = [];
            yield* Effect.forkScoped(
              Stream.runForEach(counts.state.changes, (state) =>
                Effect.sync(() => void seen.push(state)),
              ),
            );
            yield* settle(
              Effect.map(counts.state.get, (state) => state._tag === "Ready"),
              "the first counts",
            );
            const notes = yield* ref(Notes, keyOf(inboxName), {
              resume: Option.none(),
              behavior: notesBehavior,
            });
            const a = yield* Generated.send(notes, Notes, { _tag: "Add", text: "a" });
            const b = yield* Generated.send(notes, Notes, { _tag: "Add", text: "b" });
            expect(yield* counts.state.get).toEqual({
              _tag: "Ready",
              value: { total: 0, done: 0 },
              stale: true,
            });

            yield* wire.open(heldA);
            expect((yield* a.settled)._tag).toBe("Applied");
            // A's reply refreshed the counts, but B still owns them: stale.
            expect(yield* counts.state.get).toMatchObject({ _tag: "Ready", stale: true });

            yield* wire.open(heldB);
            expect((yield* b.settled)._tag).toBe("Applied");
            yield* settle(
              Effect.map(counts.state.get, (state) => state._tag === "Ready" && !state.stale),
              "fresh counts",
            );
            expect(yield* counts.state.get).toEqual({
              _tag: "Ready",
              value: { total: 2, done: 0 },
              stale: false,
            });
            // The value from before the adds is never shown as fresh after them.
            const afterSend = seen.slice(
              seen.findIndex((state) => state._tag === "Ready" && state.stale),
            );
            expect(
              afterSend.filter(
                (state) => state._tag === "Ready" && !state.stale && state.value.total < 2,
              ),
            ).toEqual([]);
          }),
        );
      }),
  );
});
