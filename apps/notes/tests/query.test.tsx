import { registerDom } from "./dom-setup.js";

registerDom();

import { Actor, CommandId, QueryCache } from "effect-frame/actor/client";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { Notes } from "../src/contract.js";
import { routes } from "../src/routes.js";
import { elementOf, keyText, mountApp, settle, tappedHost, textOf } from "./fixture.js";

/**
 * #17 and #28 in the app: a command refreshes the dependent queries the
 * page shows, in its own reply, and nothing when none is on screen; a
 * segment that exits releases the keys only it declared.
 */

const origin = "http://notes.test";
const id = Schema.decodeSync(CommandId);

const listIndex = "ListIndex{}";
const inboxCounts = 'ListCounts{"list":"inbox"}';

const activeKeys = Effect.gen(function* () {
  const cache = yield* QueryCache;
  const keys = yield* cache.active;
  return keys.map(keyText).toSorted();
});

describe("the queries a command refreshes", () => {
  it.scopedLive("an Add from /lists/inbox refreshes both dependent queries in its reply", () =>
    Effect.gen(function* () {
      const wire = yield* tappedHost;
      const app = yield* mountApp({
        transport: wire.transport,
        href: `${origin}/lists/inbox`,
        routes,
      });
      yield* settle(Effect.sync(() => textOf(app.root, "#counts") === "0 of 0 done"));
      // Two queries, no more (#25 §1): the notes are the route's actor.
      expect(yield* app.run(activeKeys)).toEqual([inboxCounts, listIndex].toSorted());

      const draft = elementOf(app.root, "#draft", HTMLInputElement);
      draft.value = "buy milk";
      draft.dispatchEvent(new Event("input", { bubbles: true }));
      elementOf(app.root, "#compose", HTMLFormElement).dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      // The counts and the list index are two queries, each painted on its
      // own turn: wait for both refreshed values.
      yield* settle(
        Effect.sync(
          () =>
            textOf(app.root, "#counts") === "0 of 1 done" &&
            textOf(app.root, '#names a[href="/lists/inbox"] + .size') === "1",
        ),
      );

      const replies = wire.commands.filter((one) => one.text === "buy milk");
      expect(replies.map((one) => one.refreshed).filter((keys) => keys.length > 0)).toEqual([
        [inboxCounts, listIndex].toSorted(),
      ]);
      // The two refreshed values landed from the reply: neither was read again.
      expect([wire.readsOf(inboxCounts), wire.readsOf(listIndex)]).toEqual([1, 1]);
    }),
  );

  it.scopedLive("the same Add from /scratch refreshes nothing, and declares nothing", () =>
    Effect.gen(function* () {
      const wire = yield* tappedHost;
      const app = yield* mountApp({ transport: wire.transport, href: `${origin}/scratch`, routes });
      yield* settle(Effect.sync(() => textOf(app.root, "#scratch-length") === "0"));
      expect(yield* app.run(activeKeys)).toEqual([]);

      const notes = yield* app.run(Actor.remote(Notes, { tenant: "demo", list: "inbox" }));
      yield* notes.call(
        { _tag: "Add", id: "n1", text: "from scratch" },
        { commandId: id("c1"), timeout: "2 seconds" },
      );
      const sightings = wire.commands.filter((one) => one.text === "from scratch");
      expect(sightings.length).toBeGreaterThan(0);
      expect(sightings.map((one) => [one.active, one.refreshed])).toEqual(
        sightings.map(() => [[], []]),
      );
      expect(wire.reads).toEqual([]);
    }),
  );

  it.scopedLive("leaving /lists/inbox for /scratch releases the list's keys", () =>
    Effect.gen(function* () {
      const wire = yield* tappedHost;
      const app = yield* mountApp({
        transport: wire.transport,
        href: `${origin}/lists/inbox`,
        routes,
      });
      yield* settle(Effect.sync(() => textOf(app.root, "#counts") === "0 of 0 done"));
      yield* app.router.push("/scratch");
      yield* settle(Effect.sync(() => textOf(app.root, "#scratch-length") === "0"));
      expect(yield* app.run(activeKeys)).toEqual([]);
    }),
  );

  it.scopedLive("leaving /lists/inbox for /lists keeps the key both declare, unread", () =>
    Effect.gen(function* () {
      const wire = yield* tappedHost;
      const app = yield* mountApp({
        transport: wire.transport,
        href: `${origin}/lists/inbox`,
        routes,
      });
      yield* settle(Effect.sync(() => textOf(app.root, "#counts") === "0 of 0 done"));
      yield* app.router.push("/lists");
      yield* settle(Effect.sync(() => textOf(app.root, "#found") === "inboxerrandsreading"));
      // Another tree: the router enters it before it closes the list's, so
      // the key both declare keeps its interest and is never read again.
      expect(yield* app.run(activeKeys)).toEqual([listIndex]);
      expect(wire.readsOf(listIndex)).toBe(1);
    }),
  );
});
