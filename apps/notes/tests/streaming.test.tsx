import { platformFetch, registerDom } from "./dom-setup.js";

registerDom();

import { ActorTransport } from "effect-frame/actor/client";
import type { Duration } from "effect";
import { Effect, Layer, Option, Queue } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { makeRuntime } from "../src/server.js";
import {
  clientOf,
  fetchText,
  has,
  hydrateAt,
  install,
  serve,
  settle,
  tappedHost,
  textOf,
} from "./fixture.js";

/**
 * #22 in the app, over a real Bun server: the streamed list page writes its
 * shell before a held query settles, a stream that reached the document
 * before hydration counts as `resolvedAhead`, the `AwaitAll` print page
 * writes no record channel, and a stream cut before `Closed` fails its open
 * entries `StreamEnded` and reads them again over `/query`.
 *
 * The server's transport is the in-memory host behind a wiretap, so a test
 * holds `ListCounts` on the server: the render's read and every `/query`
 * read wait for the same gate.
 */

const listPage = "/lists/inbox";
const printPage = "/lists/inbox/print";

/** A server whose reads go through a wiretap the test steers. */
const tappedServer = Effect.gen(function* () {
  const wire = yield* tappedHost;
  const runtime = yield* Effect.acquireRelease(
    Effect.sync(() => makeRuntime(Layer.succeed(ActorTransport, wire.transport))),
    (built) => Effect.promise(() => built.dispose()),
  );
  const server = yield* serve(runtime);
  return { wire, server };
});

const decoder = new TextDecoder();

/**
 * A page's body as a queue of chunks, `None` at its end. One fiber reads the
 * body, so a wait that times out loses no chunk. `cut` cancels the body, as
 * a browser that stops loading does.
 */
const openPage = (url: string) =>
  Effect.gen(function* () {
    const response = yield* Effect.promise(() => platformFetch(url));
    const reader = yield* Effect.acquireRelease(
      Effect.sync(() => Option.getOrThrow(Option.fromNullishOr(response.body)).getReader()),
      (opened) => Effect.promise(() => opened.cancel()),
    );
    const chunks = yield* Queue.unbounded<Option.Option<string>>();
    const readOne = Effect.flatMap(
      Effect.promise(() => reader.read()),
      (read) => {
        if (read.done) {
          return Effect.as(Queue.offer(chunks, Option.none()), false);
        }
        return Effect.as(Queue.offer(chunks, Option.some(decoder.decode(read.value))), true);
      },
    );
    yield* Effect.forkScoped(Effect.repeat(readOne, { while: (more) => more }));
    /** Every chunk that arrives before the body goes quiet for `quiet`. */
    const untilQuiet = (quiet: Duration.Input) =>
      Effect.gen(function* () {
        const seen: Array<string> = [];
        let next = yield* Effect.timeoutOption(Queue.take(chunks), quiet);
        while (Option.isSome(next) && Option.isSome(next.value)) {
          seen.push(next.value.value);
          next = yield* Effect.timeoutOption(Queue.take(chunks), quiet);
        }
        return { text: seen.join(""), ended: Option.isSome(next) };
      });
    /** Everything up to the end of the body. */
    const rest = Effect.gen(function* () {
      const seen: Array<string> = [];
      let next = yield* Queue.take(chunks);
      while (Option.isSome(next)) {
        seen.push(next.value);
        next = yield* Queue.take(chunks);
      }
      return seen.join("");
    });
    const first = Effect.map(Queue.take(chunks), Option.getOrThrow);
    const cut = Effect.promise(() => reader.cancel());
    return { first, untilQuiet, rest, cut };
  });

describe("the streamed list page (#22)", () => {
  it.scopedLive("the shell and its skeleton arrive while ListCounts is still held", () =>
    Effect.gen(function* () {
      const { wire, server } = yield* tappedServer;
      const held = yield* wire.holdQuery("ListCounts");
      const page = yield* openPage(`${server.url}${listPage}`);

      const first = yield* page.first;
      expect(first).toContain('<p id="skeleton">loading</p>');
      expect(first).toContain('{"_tag":"Placeholder","id":"ListCounts@');
      expect(first).toContain('src="/client.js"');
      expect(first).not.toContain('"_tag":"Closed"');

      // The other entries may still patch in, but ListCounts cannot, and the
      // response stays open while it is held.
      const sofar = yield* page.untilQuiet("150 millis");
      expect(sofar.ended).toBe(false);
      expect(sofar.text).not.toContain('{"_tag":"Patch","id":"ListCounts@');
      expect(sofar.text).not.toContain('"_tag":"Closed"');

      yield* wire.open(held);
      const remaining = yield* page.rest;
      expect(remaining).toContain('{"_tag":"Patch","id":"ListCounts@');
      expect(remaining).toContain('"_tag":"Closed"');
    }),
  );

  it.scopedLive("a stream that settled before hydration is reported as resolvedAhead", () =>
    Effect.gen(function* () {
      const { server } = yield* tappedServer;
      const page = yield* fetchText(`${server.url}${listPage}`);
      expect(page).toContain('"_tag":"Closed"');
      const root = yield* install(page);
      expect(has(root, "#skeleton")).toBe(true);

      const { report } = yield* (yield* clientOf(server.url))(
        hydrateAt(root, `${server.url}${listPage}`),
      );
      // The patch beat hydration: the first frame draws the patched content.
      expect(report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 1 });
      expect(has(root, "#skeleton")).toBe(false);
      expect(textOf(root, "#counts")).toBe("0 of 0 done");
    }),
  );

  it.scopedLive("the AwaitAll print page writes no record channel and hydrates clean", () =>
    Effect.gen(function* () {
      const { server } = yield* tappedServer;
      const page = yield* fetchText(`${server.url}${printPage}`);
      expect(page).not.toContain("frame-records");
      expect(page).not.toContain("frame-record");
      const root = yield* install(page);

      const { report } = yield* (yield* clientOf(server.url))(
        hydrateAt(root, `${server.url}${printPage}`),
      );
      expect(report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 0 });
    }),
  );

  it.scopedLive(
    "a stream cut before Closed fails ListCounts StreamEnded, then /query settles it",
    () =>
      Effect.gen(function* () {
        const { wire, server } = yield* tappedServer;
        const held = yield* wire.holdQuery("ListCounts");
        const page = yield* openPage(`${server.url}${listPage}`);
        const first = yield* page.first;
        yield* page.cut;

        // The document the browser has: the first chunk, and nothing after it.
        const cut = `${first}</body></html>`;
        expect(cut).not.toContain('"_tag":"Closed"');
        const root = yield* install(cut);
        const failures: Array<string> = [];
        const observer = new MutationObserver(() => {
          if (has(root, "#failure")) {
            failures.push(textOf(root, "#failure"));
          }
        });
        observer.observe(root, { childList: true, subtree: true, characterData: true });

        const client = yield* clientOf(server.url);
        yield* client(hydrateAt(root, `${server.url}${listPage}`));
        yield* settle(
          Effect.sync(() => wire.readsOf('ListCounts{"list":"inbox"}') === 2),
          "a /query read",
        );
        yield* wire.open(held);
        yield* settle(
          Effect.sync(() => textOf(root, "#counts") === "0 of 0 done"),
          "counts Ready",
        );
        observer.disconnect();
        // The open entry failed StreamEnded when the document ended without
        // `Closed`, then the read over /query settled it: no failure is left.
        expect(failures).toContain("could not load: StreamEnded");
        expect(has(root, "#failure")).toBe(false);
        expect(wire.readsOf('ListCounts{"list":"inbox"}')).toBe(2);
      }),
  );
});
