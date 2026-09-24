/* oxlint-disable effect/noGlobals -- this proof serves a streamed document with Bun.serve and reads it with the platform fetch, the two boundaries under test. */
import { registerDom } from "./dom-setup.js";

registerDom();

import { QueryCache, Streaming, useQuery } from "effect-frame/actor";
import {
  Dom,
  Errored,
  Html,
  Loading,
  View,
  mount,
  orErrored,
  ready,
  render,
} from "effect-frame/view";
import { Deferred, Effect, Fiber, Option, Stream } from "effect";
import { describe, expect, it } from "effect-bun-test";

import {
  Label,
  makeControl,
  release,
  sideOf,
  Page,
  bootstrap,
  frame,
  streamOf,
  noLimit,
  collect,
  recordsIn,
  positionOf,
  install,
  parsing,
  finishParsing,
  append,
  textOf,
  present,
  eventually,
  eventuallyEffect,
  hydrateClient,
  hydrateWith,
  stateOf,
  valueRecord,
  lateRecord,
  idOf,
  isStreamEnded,
} from "./streaming-fixture.js";

/**
 * Streamed documents (#22). The server writes the shell, a placeholder per
 * query, then a patch per query as it settles, then `Closed`. The client
 * seeds its cache from the records and hydrates. Each proof below names the
 * acceptance row it holds in `docs/design/acceptance.md`.
 */

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

describe("a streamed document, on the server", () => {
  it.scopedLive(
    "the first chunk holds the fallback and the placeholder while the query is held, and the response stays open",
    () =>
      Effect.gen(function* () {
        const control = makeControl({ a: "Alpha" }, ["a"]);
        const server = yield* sideOf(control);
        const http = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              port: 0,
              fetch: () =>
                new Response(Stream.toReadableStream(Stream.encodeText(streamOf(server, ["a"]))), {
                  headers: { "content-type": "text/html; charset=utf-8" },
                }),
            }),
          ),
          (running) => Effect.promise(() => running.stop(true)),
        );
        const response = yield* Effect.promise(() =>
          fetch(`http://127.0.0.1:${String(http.port)}/`),
        );
        const reader = Option.getOrThrow(Option.fromNullishOr(response.body)).getReader();
        const decoder = new TextDecoder();
        const read = Effect.promise(() => reader.read());

        let received = "";
        while (!received.includes(bootstrap)) {
          const chunk = yield* read;
          received += decoder.decode(chunk.value, { stream: true });
        }
        // The shell arrived: the fallback, the placeholder, the script tag.
        expect(received).toContain('<p id="pending-a">loading a</p>');
        expect(received).toContain('<footer id="foot">foot</footer>');
        expect(recordsIn(received)).toEqual([
          { _tag: "Placeholder", id: idOf("a"), kind: "query" },
        ]);
        // The response is still open: the next read waits on the held query.
        const next = yield* Effect.forkChild(read);
        const first = yield* Effect.race(
          Effect.as(Fiber.join(next), "chunk"),
          Effect.as(Effect.sleep("150 millis"), "open"),
        );
        expect(first).toBe("open");
        expect(control.calls).toEqual(["a"]);

        yield* release(control, "a");
        let rest = decoder.decode((yield* Fiber.join(next)).value, { stream: true });
        while (!rest.includes("</html>")) {
          const chunk = yield* read;
          rest += decoder.decode(chunk.value, { stream: true });
        }
        // The shell drew `a` open, so its patch says it came late.
        expect(recordsIn(rest)).toEqual([
          { ...valueRecord(idOf("a"), "Alpha"), late: true },
          { _tag: "Closed", patched: [idOf("a")] },
        ]);
      }),
    10_000,
  );
});

describe("a server render's cache (#28)", () => {
  it.scopedLive(
    "two concurrent renders share no entry, and each cache is gone when its response ends",
    () =>
      Effect.gen(function* () {
        const control = makeControl({ a: "Alpha" }, ["a"]);
        const server = yield* sideOf(control);
        const stop = yield* Deferred.make<void>();
        const both = yield* Effect.forkChild(
          Effect.all(
            [
              collect(streamOf(server, ["a"], { closeWhen: Deferred.await(stop) })),
              collect(streamOf(server, ["a"], { closeWhen: Deferred.await(stop) })),
            ],
            { concurrency: 2 },
          ),
        );
        // Each render opened its own entry, so each one read.
        yield* eventually("two reads", () => control.calls.length === 2);
        expect(control.calls).toEqual(["a", "a"]);
        expect(control.interrupted).toEqual([]);
        // Both responses end with the key still held: each cache releases its read.
        yield* Deferred.succeed(stop, void 0);
        const [first, second] = yield* Fiber.join(both);
        expect(recordsIn(first.join("")).at(-1)).toEqual({ _tag: "Closed", patched: [] });
        expect(recordsIn(second.join("")).at(-1)).toEqual({ _tag: "Closed", patched: [] });
        yield* eventually("both reads released", () => control.interrupted.length === 2);
      }),
    10_000,
  );
});

describe("the HTML host in a browser bundle", () => {
  it.scopedLive(
    "a bundle of the view entry holds no script close tag",
    () =>
      Effect.gen(function* () {
        // A page may write its bundle inline in a `<script>`: the host's own
        // record and payload writers must not close it.
        const result = yield* Effect.promise(() =>
          Bun.build({
            entrypoints: [`${import.meta.dir}/../../src/view/index.ts`],
            target: "browser",
            format: "esm",
            conditions: ["browser", "source"],
          }),
        );
        expect(result.success).toBe(true);
        const text = yield* Effect.promise(() =>
          Option.getOrThrow(Option.fromNullishOr(result.outputs[0])).text(),
        );
        expect(text).toContain("frame-record");
        expect(/<\/script/i.test(text)).toBe(false);
      }),
    30_000,
  );
});

describe("a streamed document, record order", () => {
  it.scopedLive("a placeholder always precedes its patch, and Closed lists every settle", () =>
    Effect.gen(function* () {
      // `a` settles while the shell renders; `b` and `c` settle after it.
      const control = makeControl({ a: "Alpha", b: "Beta", c: "Gamma" }, ["b", "c"]);
      const server = yield* sideOf(control);
      const chunks = yield* Effect.forkChild(
        collect(streamOf(server, ["a", "b", "c"], noLimit, ["a"])),
      );
      yield* Effect.sleep("20 millis");
      yield* release(control, "c");
      yield* Effect.sleep("20 millis");
      yield* release(control, "b");
      const html = (yield* Fiber.join(chunks)).join("");

      for (const id of ["a", "b", "c"]) {
        const placeholder = positionOf(html, "Placeholder", idOf(id));
        const patch = positionOf(html, "Patch", idOf(id));
        expect(placeholder).toBeGreaterThanOrEqual(0);
        expect(patch).toBeGreaterThan(placeholder);
      }
      // The early patch is written before the script tag, the later ones in settle order.
      expect(html.indexOf(Html.streamRecord(valueRecord(idOf("a"), "Alpha")))).toBeLessThan(
        html.indexOf(bootstrap),
      );
      expect(positionOf(html, "Patch", idOf("c"))).toBeLessThan(
        positionOf(html, "Patch", idOf("b")),
      );
      const records = recordsIn(html);
      expect(records.at(-1)).toEqual({
        _tag: "Closed",
        patched: [idOf("a"), idOf("c"), idOf("b")],
      });
      expect(html.endsWith(`</script><!----></div></body></html>`)).toBe(true);
      // The shell drew `a` settled, so the client claims its content as it is.
      expect(html).toContain('<p id="label-a">Alpha</p>');
      const clientControl = makeControl({});
      const client = yield* sideOf(clientControl);
      yield* install(html);
      const { report } = yield* hydrateClient(client, ["a", "b", "c"], ["a"]);
      expect(report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 2 });
      expect(clientControl.calls).toEqual([]);
    }),
  );

  it.scopedLive("a value cannot close its record script", () =>
    Effect.gen(function* () {
      const hostile = "</script><script>window.__owned = 1</script> &<!--";
      const control = makeControl({ a: hostile });
      const server = yield* sideOf(control);
      const html = (yield* collect(streamOf(server, ["a"]))).join("");
      const scripts = html.match(/<script\b/g) ?? [];
      const closes = html.match(/<\/script>/g) ?? [];
      // One module script, one placeholder, one patch, one Closed: every close tag is its own.
      expect(scripts.length).toBe(4);
      expect(closes.length).toBe(4);
      expect(html).not.toContain("window.__owned = 1</script>");
      expect(recordsIn(html)[1]).toEqual({ ...valueRecord(idOf("a"), hostile), late: true });

      // The client decodes the value exactly.
      const client = yield* sideOf(makeControl({}));
      yield* install(html);
      yield* hydrateClient(client, ["a"]);
      expect(textOf("#label-a")).toBe(hostile);
    }),
  );
});

describe("a streamed document, on the client", () => {
  it.scopedLive("a record id is identical on both sides", () =>
    Effect.gen(function* () {
      const control = makeControl({ a: "Alpha", b: "Beta" });
      const server = yield* sideOf(control);
      const html = (yield* collect(streamOf(server, ["a", "b"]))).join("");
      const placeholders = recordsIn(html)
        .filter((record) => record._tag === "Placeholder")
        .map((record) => ("id" in record && record.id) || "");

      const client = yield* sideOf(makeControl({}));
      yield* install(html);
      yield* hydrateClient(client, ["a", "b"]);
      const active = yield* Effect.provideContext(
        Effect.flatMap(QueryCache, (cache) => cache.active),
        client,
      );
      expect([...placeholders].sort()).toEqual(active.map(Streaming.recordId).sort());
      expect(placeholders.length).toBe(2);
    }),
  );

  it.scopedLive(
    "a patch that arrives before hydration replaces the fallback, and the report says so",
    () =>
      Effect.gen(function* () {
        const serverControl = makeControl({ a: "Alpha" }, ["a"]);
        const heldServer = yield* sideOf(serverControl);
        // `a` is held past the shell, so the shell draws its fallback; its
        // patch is in the document before the client reads it.
        const chunks = yield* Effect.forkChild(collect(streamOf(heldServer, ["a"])));
        yield* Effect.sleep("20 millis");
        yield* release(serverControl, "a");
        const html = (yield* Fiber.join(chunks)).join("");
        expect(html).toContain('<p id="pending-a">loading a</p>');

        const clientControl = makeControl({});
        const client = yield* sideOf(clientControl);
        yield* install(html);
        const { report, root } = yield* hydrateClient(client, ["a"]);
        expect(report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 1 });
        expect(textOf("#label-a")).toBe("Alpha");
        expect(present("#pending-a")).toBe(false);
        // The content stands where the fallback stood, before the footer.
        expect(root.innerHTML).toBe(
          '<section><h1>labels</h1><p id="label-a">Alpha</p><footer id="foot">foot</footer></section>',
        );
        // The value came from the document: the client read nothing.
        expect(clientControl.calls).toEqual([]);
      }),
  );

  it.scopedLive(
    "a late patch settles the scope with no claim, and it is observed with no script",
    () =>
      Effect.gen(function* () {
        const serverControl = makeControl({ a: "Alpha" }, ["a"]);
        const server = yield* sideOf(serverControl);
        const stream = streamOf(server, ["a"]);
        // Only the first chunk has arrived when the client runs.
        const first = yield* Effect.map(Stream.runHead(stream), Option.getOrThrow);
        yield* parsing;
        yield* install(first);

        const clientControl = makeControl({});
        const client = yield* sideOf(clientControl);
        const { report, resumed } = yield* hydrateClient(client, ["a"]);
        expect(report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 0 });
        expect(textOf("#pending-a")).toBe("loading a");

        // The parser appends the patch: the observer lands it.
        yield* append(lateRecord(idOf("a"), "Alpha"));
        yield* eventually("the late patch", () => textOf("#label-a") === "Alpha");
        expect(present("#pending-a")).toBe(false);
        expect(clientControl.calls).toEqual([]);

        // Every script in the document is JSON, except the module script.
        const executable = Array.from(document.querySelectorAll("script")).filter(
          (script) => script.getAttribute("type") !== "application/json",
        );
        // A count, not the elements: a failed compare of happy-dom nodes takes minutes.
        expect(executable.length).toBe(0);
        expect(first.match(/<script(?![^>]*type="application\/json")[^>]*>/g)).toEqual([
          bootstrap.replace("</script>", ""),
        ]);

        yield* append({ _tag: "Closed", patched: [idOf("a")] });
        yield* resumed.closed;
      }),
  );

  it.scopedLive("a duplicate patch for a settled id changes nothing", () =>
    Effect.gen(function* () {
      const serverControl = makeControl({ a: "Alpha" }, ["a"]);
      const server = yield* sideOf(serverControl);
      const first = yield* Effect.map(Stream.runHead(streamOf(server, ["a"])), Option.getOrThrow);
      yield* parsing;
      yield* install(first);
      const client = yield* sideOf(makeControl({}));
      yield* hydrateClient(client, ["a"]);

      const seen: Array<string> = [];
      yield* Effect.provideContext(
        Effect.gen(function* () {
          const cache = yield* QueryCache;
          const entry = yield* cache.open(Label, { id: "a" });
          yield* Effect.forkScoped(
            Stream.runForEach(entry.state.changes, (state) =>
              Effect.sync(() => void seen.push(state._tag)),
            ),
          );
        }),
        client,
      );
      yield* append(lateRecord(idOf("a"), "Alpha"));
      yield* eventually("the first patch", () => textOf("#label-a") === "Alpha");
      yield* append(lateRecord(idOf("a"), "Changed"));
      yield* Effect.sleep("30 millis");
      expect(textOf("#label-a")).toBe("Alpha");
      expect(seen.filter((tag) => tag === "Ready")).toEqual(["Ready"]);
      const state = yield* stateOf(client, "a");
      expect(state).toEqual({ _tag: "Ready", value: { label: "Alpha" }, stale: false });
    }),
  );
});

describe("a duplicate patch in the document", () => {
  it.scopedLive("a duplicate patch before hydration changes nothing either", () =>
    Effect.gen(function* () {
      const server = yield* sideOf(makeControl({ a: "Alpha" }, ["a"]));
      const first = yield* Effect.map(Stream.runHead(streamOf(server, ["a"])), Option.getOrThrow);
      yield* parsing;
      yield* install(first);
      // Both patches are in the document before the client reads it.
      yield* append(lateRecord(idOf("a"), "Alpha"));
      yield* append(lateRecord(idOf("a"), "Changed"));
      const clientControl = makeControl({});
      const client = yield* sideOf(clientControl);
      const { report } = yield* hydrateClient(client, ["a"]);
      expect(report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 1 });
      expect(textOf("#label-a")).toBe("Alpha");
      expect(clientControl.calls).toEqual([]);
    }),
  );
});

/**
 * Boundaries nest: an `Errored` around a `Loading`, and a `Loading` inside
 * content whose own query settled while the shell rendered. Only the
 * boundary whose fallback the server drew replaces it.
 */
const Nested = () =>
  Errored({
    fallback: () => <p id="failed">failed</p>,
    children: Loading({
      fallback: <p id="pending-outer">outer</p>,
      children: Effect.gen(function* () {
        const outer = yield* useQuery(Label, { id: "outer" });
        yield* outer.state.changes.pipe(
          Stream.filter((state) => state._tag !== "Loading"),
          Stream.take(1),
          Stream.runDrain,
        );
        const outerValue = yield* ready(yield* orErrored(outer.state), { label: "?" });
        const inner = yield* Loading({
          fallback: <p id="pending-inner">inner</p>,
          children: Effect.gen(function* () {
            const entry = yield* useQuery(Label, { id: "inner" });
            const value = yield* ready(entry.state, { label: "?" });
            return <p id="label-inner">{View.bind(value, (found) => found.label)}</p>;
          }),
        });
        return (
          <div id="outer">
            <p id="label-outer">{View.bind(outerValue, (found) => found.label)}</p>
            {inner}
          </div>
        );
      }),
    }),
  });

describe("a streamed document with nested boundaries", () => {
  it.scopedLive("replaces only the fallback its own boundary drew", () =>
    Effect.gen(function* () {
      const serverControl = makeControl({ outer: "Outer", inner: "Inner" }, ["inner"]);
      const server = yield* sideOf(serverControl);
      const chunks = yield* Effect.forkChild(
        collect(
          Html.renderToStream(Nested, {}, frame, noLimit).pipe(Stream.provideContext(server)),
        ),
      );
      yield* Effect.sleep("20 millis");
      yield* release(serverControl, "inner");
      const html = (yield* Fiber.join(chunks)).join("");
      // Each boundary has its own marks: the inner one drew its fallback.
      expect(html).toContain(
        '<!--frame-boundary:fallback--><p id="pending-inner">inner</p><!--/frame-boundary-->',
      );

      const clientControl = makeControl({});
      const client = yield* sideOf(clientControl);
      yield* install(html);
      const root = Option.getOrThrow(Option.fromNullishOr(document.getElementById("app")));
      const report = yield* Effect.gen(function* () {
        yield* Streaming.resume(yield* Dom.readRecords);
        const hydration = Dom.hydrate(root);
        yield* mount(Nested, {}, hydration.host, root);
        yield* render;
        return yield* hydration.finish;
      }).pipe(Effect.provideContext(client));
      expect(report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 1 });
      expect(root.innerHTML).toBe(
        '<div id="outer"><p id="label-outer">Outer</p><p id="label-inner">Inner</p></div>',
      );
      expect(clientControl.calls).toEqual([]);
    }),
  );
});

describe("a streamed document that ends early", () => {
  it.scopedLive(
    "a query still pending at Closed fails StreamEnded, no scope hangs, and /query reaches Ready",
    () =>
      Effect.gen(function* () {
        const serverControl = makeControl({ a: "Alpha" }, ["a"]);
        const server = yield* sideOf(serverControl);
        const stop = yield* Deferred.make<void>();
        const chunks = yield* Effect.forkChild(
          collect(streamOf(server, ["a"], { closeWhen: Deferred.await(stop) })),
        );
        yield* Effect.sleep("20 millis");
        yield* Deferred.succeed(stop, void 0);
        const html = (yield* Fiber.join(chunks)).join("");
        expect(recordsIn(html).at(-1)).toEqual({ _tag: "Closed", patched: [] });

        const clientControl = makeControl({ a: "Alpha, read again" }, ["a"]);
        const client = yield* sideOf(clientControl);
        yield* install(html);
        // The shell drew `a` open, so its failure lands once hydration is
        // done, and the read it calls for starts then: watch it pass.
        const seen: Array<Effect.Success<ReturnType<typeof stateOf>>> = [];
        const { resumed } = yield* hydrateWith(client, (host, root) =>
          Effect.gen(function* () {
            yield* mount(Page, { ids: ["a"] }, host, root);
            const cache = yield* QueryCache;
            const entry = yield* cache.open(Label, { id: "a" });
            yield* Effect.forkScoped(
              Stream.runForEach(entry.state.changes, (state) =>
                Effect.sync(() => void seen.push(state)),
              ),
            );
          }),
        );
        yield* resumed.closed;
        // The entry failed, so the scope settled: no fallback is on screen.
        expect(present("#pending-a")).toBe(false);
        yield* eventually("the refresh", () => clientControl.calls.length === 1);
        expect(clientControl.calls).toEqual(["a"]);

        yield* release(clientControl, "a");
        yield* eventually(
          "Ready over the query path",
          () => textOf("#label-a") === "Alpha, read again",
        );
        expect((yield* stateOf(client, "a"))._tag).toBe("Ready");
        expect(seen.some(isStreamEnded)).toBe(true);
      }),
  );

  it.scopedLive("a truncated response reaches the same verdict as a closed one", () =>
    Effect.gen(function* () {
      const serverControl = makeControl({ a: "Alpha" }, ["a"]);
      const server = yield* sideOf(serverControl);
      // The response is cut after its first chunk: no patch, no `Closed`, no `</html>`.
      const first = yield* Effect.map(Stream.runHead(streamOf(server, ["a"])), Option.getOrThrow);
      expect(first).not.toContain('"Closed"');

      const clientControl = makeControl({ a: "Alpha, read again" }, ["a"]);
      const client = yield* sideOf(clientControl);
      yield* parsing;
      yield* install(first);
      const { resumed } = yield* hydrateClient(client, ["a"]);
      // The parser reaches the end of what it was given.
      yield* finishParsing;
      yield* resumed.closed;
      yield* eventuallyEffect("StreamEnded", Effect.map(stateOf(client, "a"), isStreamEnded));
      // A settled entry draws its content, whatever the value; the view redraws after the state.
      yield* eventually("the fallback left", () => !present("#pending-a"));
      yield* release(clientControl, "a");
      yield* eventually(
        "Ready over the query path",
        () => textOf("#label-a") === "Alpha, read again",
      );
      expect(clientControl.calls).toEqual(["a"]);
    }),
  );
});

describe("an AwaitAll document", () => {
  it.scopedLive("writes no record channel and hydrates with no mismatch", () =>
    Effect.gen(function* () {
      const serverControl = makeControl({ a: "Alpha", b: "Beta" }, ["b"]);
      const server = yield* sideOf(serverControl);
      const rendering = yield* Effect.forkChild(
        Effect.provideContext(
          Html.renderAwaitAll(Page, { ids: ["a", "b"] }, frame, noLimit),
          server,
        ),
      );
      yield* Effect.sleep("20 millis");
      yield* release(serverControl, "b");
      const html = yield* Fiber.join(rendering);
      expect(html).not.toContain(Streaming.containerId);
      expect(html).not.toContain(Streaming.recordClass);
      expect(html).not.toContain("frame-boundary:fallback");
      expect(html).toContain('<p id="label-a">Alpha</p>');
      expect(html).toContain('<p id="label-b">Beta</p>');
      expect(html).toContain(`id="${Streaming.seedId}"`);

      const clientControl = makeControl({});
      const client = yield* sideOf(clientControl);
      yield* install(html);
      const { report, resumed } = yield* hydrateClient(client, ["a", "b"]);
      yield* resumed.closed;
      expect(report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 0 });
      expect(textOf("#label-b")).toBe("Beta");
      expect(clientControl.calls).toEqual([]);
    }),
  );
});
