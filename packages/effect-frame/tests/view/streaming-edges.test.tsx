import { registerDom } from "./dom-setup.js";

registerDom();

import { QueryCache, QueryFailed, Streaming, Unreachable, followQuery } from "effect-frame/actor";
import type { ActorTransport } from "effect-frame/actor";
import type { Node } from "effect-frame/view";
import type { Scope } from "effect";
import { Html, View } from "effect-frame/view";
import { Deferred, Effect, Fiber, Option, Schema, Stream, SubscriptionRef } from "effect";
import { describe, expect, it } from "effect-bun-test";
import {
  Label,
  append,
  collect,
  eventually,
  frame,
  hydrateWith,
  idOf,
  install,
  isStreamEnded,
  makeControl,
  parsing,
  recordsIn,
  release,
  sideOf,
  stateOf,
  textOf,
  lateRecord,
} from "./streaming-fixture.js";

/**
 * Streamed documents (#22), the edges review round 1 found: a declaration
 * released before it settles, boundaries whose fallback or content draws
 * nothing, boundaries inside a fallback or inside hidden content, an error
 * fallback the client draws first, a seed no view took, a seed failure that
 * is not the query's own, a seed later than a client read, the moment
 * `closed` completes, and an `AwaitAll` drawing whose rows register late,
 * inside a boundary or not.
 */

/** Wait until `id`'s entry has settled, so the shell draws its content. */
const settled = (id: string) =>
  Effect.gen(function* () {
    const entry = yield* QueryCache.use((cache) => cache.open(Label, { id }));
    yield* entry.state.changes.pipe(
      Stream.filter((state) => state._tag !== "Loading"),
      Stream.take(1),
      Stream.runDrain,
    );
    return entry;
  });

/** The label of `id`, once its entry is ready. */
const labelOf = (id: string, awaited: boolean) =>
  Effect.gen(function* () {
    let entry = yield* QueryCache.use((cache) => cache.open(Label, { id }));
    if (awaited) {
      entry = yield* settled(id);
    }
    const value = yield* View.ready(entry.state, { label: "?" });
    return <p id={`label-${id}`}>{View.bind(value, (found) => found.label)}</p>;
  });

const sectionOf = (root: HTMLElement): string =>
  Option.getOrElse(
    Option.map(Option.fromNullishOr(root.querySelector("section")), (found) => found.innerHTML),
    () => "",
  );

/**
 * The first chunk of a streamed document over a server that holds `held`,
 * installed as a parser still reading it. A test appends the records that
 * arrived before the client ran.
 */
const firstChunkOf = (
  document: Stream.Stream<string, Html.RecordsUnsettled, ActorTransport>,
  labels: Readonly<Record<string, string>>,
  held: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const server = yield* sideOf(makeControl(labels, held));
    const first = yield* Effect.map(
      Stream.runHead(document.pipe(Stream.provideContext(server))),
      Option.getOrThrow,
    );
    yield* parsing;
    yield* install(first);
    return first;
  });

/** `view`'s streamed document, with no time limit: the test ends it. */
const streamed = (
  view: () => Effect.Effect<Node, never, QueryCache | ActorTransport | Scope.Scope>,
) => Html.renderToStream(view, {}, frame, { closeWhen: Effect.never });

describe("a declaration the render releases before it settles", () => {
  it.scopedLive("still ends the stream with Closed, and writes no patch for it", () =>
    Effect.gen(function* () {
      const control = makeControl({ a: "Alpha", b: "Beta" }, ["a"]);
      const server = yield* sideOf(control);
      const args = yield* SubscriptionRef.make(Option.some({ id: "a" }));
      const Following = () =>
        Effect.gen(function* () {
          const followed = yield* followQuery(Label, {
            get: SubscriptionRef.get(args),
            changes: SubscriptionRef.changes(args),
          });
          return <p id="state">{View.bind(followed.state, (state) => state._tag)}</p>;
        });
      const chunks = yield* Effect.forkChild(
        collect(
          Html.renderToStream(Following, {}, frame, { closeWhen: Effect.never }).pipe(
            Stream.provideContext(server),
          ),
        ),
      );
      yield* eventually("the shell read a", () => control.calls.includes("a"));
      // The render moves to `b`: the entry for `a` is released while it is open.
      yield* SubscriptionRef.set(args, Option.some({ id: "b" }));
      const html = (yield* Fiber.join(chunks).pipe(Effect.timeout("2 seconds"))).join("");
      const records = recordsIn(html);
      expect(records[0]).toEqual({ _tag: "Placeholder", id: idOf("a"), kind: "query" });
      expect(records.at(-1)).toEqual({ _tag: "Closed", patched: [] });
      expect(control.interrupted).toEqual(["a"]);
    }),
  );
});

/** Two boundaries side by side, then a footer. The first one's fallback draws nothing. */
const EmptyFallback = () =>
  Effect.gen(function* () {
    const first = yield* View.loading({ fallback: <></>, content: labelOf("a", false) });
    const second = yield* View.loading({
      fallback: <p id="pending-b">loading b</p>,
      content: labelOf("b", false),
    });
    return (
      <section>
        {first}
        {second}
        <footer id="foot">foot</footer>
      </section>
    );
  });

/** Two boundaries side by side. The first one's content draws nothing. */
const EmptyContent = () =>
  Effect.gen(function* () {
    const first = yield* View.loading({
      fallback: <p id="pending-a">loading a</p>,
      content: Effect.gen(function* () {
        const entry = yield* settled("a");
        yield* View.ready(entry.state, { label: "?" });
        return <></>;
      }),
    });
    const second = yield* View.loading({
      fallback: <p id="pending-b">loading b</p>,
      content: labelOf("b", false),
    });
    return (
      <section>
        {first}
        {second}
        <footer id="foot">foot</footer>
      </section>
    );
  });

describe("boundaries side by side", () => {
  it.scopedLive("a boundary whose fallback draws nothing replaces only its own", () =>
    Effect.gen(function* () {
      yield* firstChunkOf(streamed(EmptyFallback), { a: "Alpha", b: "Beta" }, ["a", "b"]);
      // `a` settles before the client reads the document; `b` is still open.
      yield* append({ _tag: "Placeholder", id: idOf("a"), kind: "query" });
      yield* append(lateRecord(idOf("a"), "Alpha"));
      const client = yield* sideOf(makeControl({}));
      const { report, root } = yield* hydrateWith(client, (host, at) =>
        View.mount(EmptyFallback, {}, host, at),
      );
      expect(sectionOf(root)).toBe(
        '<p id="label-a">Alpha</p><p id="pending-b">loading b</p><footer id="foot">foot</footer>',
      );
      expect(report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 1 });
    }),
  );

  it.scopedLive("a boundary whose content draws nothing leaves the next fallback alone", () =>
    Effect.gen(function* () {
      yield* firstChunkOf(streamed(EmptyContent), { a: "Alpha", b: "Beta" }, ["b"]);
      const client = yield* sideOf(makeControl({}));
      const { report, root } = yield* hydrateWith(client, (host, at) =>
        View.mount(EmptyContent, {}, host, at),
      );
      expect(sectionOf(root)).toBe(
        '<p id="pending-b">loading b</p><footer id="foot">foot</footer>',
      );
      expect(report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 0 });
    }),
  );
});

/** A boundary whose whole fallback is another boundary, which shows its content. */
const FallbackIsBoundary = () =>
  Effect.gen(function* () {
    const outer = yield* View.loading({
      fallback: yield* View.loading({
        fallback: <p id="pending-inner">inner</p>,
        content: labelOf("inner", true),
      }),
      content: labelOf("outer", false),
    });
    return (
      <section>
        {outer}
        <footer id="foot">foot</footer>
      </section>
    );
  });

/** A boundary whose fallback is a node, then another boundary. */
const FallbackHoldsBoundary = () =>
  Effect.gen(function* () {
    const inner = yield* View.loading({
      fallback: <p id="pending-inner">inner</p>,
      content: labelOf("inner", false),
    });
    const outer = yield* View.loading({
      fallback: (
        <>
          <p id="x">x</p>
          {inner}
        </>
      ),
      content: labelOf("outer", false),
    });
    return (
      <section>
        {outer}
        <footer id="foot">foot</footer>
      </section>
    );
  });

describe("a boundary inside a fallback", () => {
  it.scopedLive("the outer content replaces a fallback that is a boundary showing content", () =>
    Effect.gen(function* () {
      yield* firstChunkOf(streamed(FallbackIsBoundary), { outer: "Outer", inner: "Inner" }, [
        "outer",
      ]);
      yield* append(lateRecord(idOf("outer"), "Outer"));
      const client = yield* sideOf(makeControl({}));
      const { report, root } = yield* hydrateWith(client, (host, at) =>
        View.mount(FallbackIsBoundary, {}, host, at),
      );
      expect(sectionOf(root)).toBe('<p id="label-outer">Outer</p><footer id="foot">foot</footer>');
      expect(report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 1 });
    }),
  );

  it.scopedLive("the outer content replaces a fallback that holds a node and a boundary", () =>
    Effect.gen(function* () {
      yield* firstChunkOf(streamed(FallbackHoldsBoundary), { outer: "Outer", inner: "Inner" }, [
        "outer",
        "inner",
      ]);
      yield* append(lateRecord(idOf("outer"), "Outer"));
      const client = yield* sideOf(makeControl({}));
      const { report, root } = yield* hydrateWith(client, (host, at) =>
        View.mount(FallbackHoldsBoundary, {}, host, at),
      );
      expect(sectionOf(root)).toBe('<p id="label-outer">Outer</p><footer id="foot">foot</footer>');
      expect(report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 1 });
    }),
  );

  it.scopedLive("a boundary inside a drawn fallback replaces only its own fallback", () =>
    Effect.gen(function* () {
      yield* firstChunkOf(streamed(FallbackHoldsBoundary), { outer: "Outer", inner: "Inner" }, [
        "outer",
        "inner",
      ]);
      // Only the inner query settled before the client ran.
      yield* append(lateRecord(idOf("inner"), "Inner"));
      const client = yield* sideOf(makeControl({}, ["outer"]));
      const { report, root } = yield* hydrateWith(client, (host, at) =>
        View.mount(FallbackHoldsBoundary, {}, host, at),
      );
      expect(sectionOf(root)).toBe(
        '<p id="x">x</p><p id="label-inner">Inner</p><footer id="foot">foot</footer>',
      );
      expect(report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 1 });
    }),
  );
});

/** One boundary for `a`. The document also carries a settled `c` no view declares. */
const OnlyA = () =>
  Effect.gen(function* () {
    const boundary = yield* View.loading({
      fallback: <p id="pending-a">loading a</p>,
      content: labelOf("a", false),
    });
    return <section>{boundary}</section>;
  });

describe("a seed no view took", () => {
  it.scopedLive("is dropped once hydration is done, so a later declaration reads fresh", () =>
    Effect.gen(function* () {
      yield* firstChunkOf(streamed(OnlyA), { a: "Alpha" }, ["a"]);
      yield* append(lateRecord(idOf("a"), "Alpha"));
      yield* append({ _tag: "Placeholder", id: idOf("c"), kind: "query" });
      yield* append(lateRecord(idOf("c"), "Old"));
      const clientControl = makeControl({ c: "Fresh" });
      const client = yield* sideOf(clientControl);
      const { resumed } = yield* hydrateWith(client, (host, at) => View.mount(OnlyA, {}, host, at));
      yield* resumed.hydrated;
      expect(clientControl.calls).toEqual([]);

      // A view declares `c` after hydration: it reads over the query path.
      const seen = yield* Deferred.make<string>();
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          const cache = yield* QueryCache;
          const entry = yield* cache.open(Label, { id: "c" });
          yield* Stream.runForEach(entry.state.changes, (state) => {
            if (state._tag === "Ready") {
              return Effect.asVoid(Deferred.succeed(seen, state.value.label));
            }
            return Effect.void;
          });
        }).pipe(Effect.provideContext(client)),
      );
      expect(yield* Deferred.await(seen).pipe(Effect.timeout("2 seconds"))).toBe("Fresh");
      expect(clientControl.calls).toEqual(["c"]);
    }),
  );
});

describe("a seed failure", () => {
  it.scopedLive("that is not the query's own is not final: the client reads again", () =>
    Effect.gen(function* () {
      const TwoLabels = () =>
        Effect.gen(function* () {
          const first = yield* View.loading({
            fallback: <p id="pending-a">a</p>,
            content: labelOf("a", false),
          });
          const second = yield* View.loading({
            fallback: <p id="pending-b">b</p>,
            content: labelOf("b", false),
          });
          return (
            <section>
              {first}
              {second}
            </section>
          );
        });
      yield* firstChunkOf(streamed(TwoLabels), {}, ["a", "b"]);
      // The server's own read of `a` could not reach its host; `b`'s handler failed.
      yield* append({
        _tag: "Patch",
        id: idOf("a"),
        outcome: { _tag: "Error", error: Unreachable.make({ reason: "host down" }) },
      });
      yield* append({
        _tag: "Patch",
        id: idOf("b"),
        outcome: {
          _tag: "Error",
          error: QueryFailed.make({ query: Label.name, detail: "no such label" }),
        },
      });
      const clientControl = makeControl({ a: "Alpha", b: "Beta" });
      const client = yield* sideOf(clientControl);
      yield* hydrateWith(client, (host, at) => View.mount(TwoLabels, {}, host, at));
      yield* eventually("a read again", () => textOf("#label-a") === "Alpha");
      expect(clientControl.calls).toEqual(["a"]);
      const b = yield* stateOf(client, "b");
      expect(b._tag === "Failed" && b.error._tag).toBe("QueryFailed");
    }),
  );
});

describe("an AwaitAll document with a time limit", () => {
  it.scopedLive(
    "draws the fallback of a query still open at the limit, and the client reads it",
    () =>
      Effect.gen(function* () {
        const server = yield* sideOf(makeControl({ a: "Alpha" }, ["a"]));
        const html = yield* Html.renderAwaitAll(OnlyA, {}, frame, {
          closeWhen: Effect.sleep("50 millis"),
        }).pipe(Effect.provideContext(server));
        expect(html).toContain('<p id="pending-a">loading a</p>');
        expect(html).not.toContain(Streaming.seedId);

        const clientControl = makeControl({ a: "Alpha, read by the client" });
        const client = yield* sideOf(clientControl);
        yield* install(html);
        const { report } = yield* hydrateWith(client, (host, at) =>
          View.mount(OnlyA, {}, host, at),
        );
        expect(report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 0 });
        yield* eventually(
          "the client read",
          () => textOf("#label-a") === "Alpha, read by the client",
        );
        expect(clientControl.calls).toEqual(["a"]);
      }),
  );
});

/** A boundary whose query stays open on both sides, holding a boundary in its content; then `c`. */
const HiddenInner = () =>
  Effect.gen(function* () {
    const outer = yield* View.loading({
      fallback: <p id="pending-o">loading o</p>,
      content: Effect.gen(function* () {
        const inner = yield* View.loading({
          fallback: <p id="pending-i">loading i</p>,
          content: labelOf("i", false),
        });
        const value = yield* View.ready(
          (yield* QueryCache.use((cache) => cache.open(Label, { id: "o" }))).state,
          {
            label: "?",
          },
        );
        return (
          <div>
            <p id="label-o">{View.bind(value, (found) => found.label)}</p>
            {inner}
          </div>
        );
      }),
    });
    const last = yield* View.loading({
      fallback: <p id="pending-c">loading c</p>,
      content: labelOf("c", false),
    });
    return (
      <section>
        {outer}
        {last}
        <footer id="foot">foot</footer>
      </section>
    );
  });

describe("a boundary inside hidden content", () => {
  it.scopedLive("takes no marks, so the next boundary still finds its own", () =>
    Effect.gen(function* () {
      yield* firstChunkOf(streamed(HiddenInner), { o: "O", i: "I", c: "C" }, ["o", "i", "c"]);
      // Only `c` settled before the client ran.
      yield* append(lateRecord(idOf("c"), "C"));
      const client = yield* sideOf(makeControl({}, ["o", "i"]));
      const { report, root } = yield* hydrateWith(client, (host, at) =>
        View.mount(HiddenInner, {}, host, at),
      );
      expect(sectionOf(root)).toBe(
        '<p id="pending-o">loading o</p><p id="label-c">C</p><footer id="foot">foot</footer>',
      );
      expect(report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 1 });
    }),
  );
});

/** A loading boundary inside an error boundary, over one query. */
const Guarded = () =>
  Effect.gen(function* () {
    const boundary = yield* View.errored({
      fallback: () => <p id="error">error</p>,
      content: View.loading({
        fallback: <p id="pending">loading</p>,
        content: Effect.gen(function* () {
          const entry = yield* QueryCache.use((cache) => cache.open(Label, { id: "a" }));
          const value = yield* View.ready(yield* View.orErrored(entry.state), { label: "?" });
          return <p id="label-a">{View.bind(value, (found) => found.label)}</p>;
        }),
      }),
    });
    return (
      <section>
        {boundary}
        <footer id="foot">foot</footer>
      </section>
    );
  });

describe("an error the document settled before hydration", () => {
  it.scopedLive("draws the error fallback fresh where the server drew the loading one", () =>
    Effect.gen(function* () {
      yield* firstChunkOf(streamed(Guarded), { a: "Alpha" }, ["a"]);
      yield* append({
        _tag: "Patch",
        id: idOf("a"),
        outcome: {
          _tag: "Error",
          error: QueryFailed.make({ query: Label.name, detail: "no such label" }),
        },
      });
      const client = yield* sideOf(makeControl({}));
      const { report, root } = yield* hydrateWith(client, (host, at) =>
        View.mount(Guarded, {}, host, at),
      );
      expect(sectionOf(root)).toBe('<p id="error">error</p><footer id="foot">foot</footer>');
      expect(report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 1 });
    }),
  );
});

describe("a seed that settles after a client read", () => {
  it.scopedLive("never replaces the newer value", () =>
    Effect.gen(function* () {
      yield* firstChunkOf(streamed(OnlyA), { a: "Alpha" }, ["a"]);
      const clientControl = makeControl({ a: "Fresh" });
      const client = yield* sideOf(clientControl);
      const { resumed } = yield* hydrateWith(client, (host, at) => View.mount(OnlyA, {}, host, at));
      // The client reads `a` itself while the document still holds it open.
      yield* Effect.gen(function* () {
        const cache = yield* QueryCache;
        const entry = yield* cache.open(Label, { id: "a" });
        yield* entry.refresh;
      }).pipe(Effect.scoped, Effect.provideContext(client));
      yield* eventually("the client value", () => textOf("#label-a") === "Fresh");
      // The server's older value arrives after it.
      yield* append(lateRecord(idOf("a"), "Old"));
      yield* append({ _tag: "Closed", patched: [idOf("a")] });
      yield* resumed.closed;
      const state = yield* stateOf(client, "a");
      expect(state._tag === "Ready" && state.value).toEqual({ label: "Fresh" });
      expect(textOf("#label-a")).toBe("Fresh");
    }),
  );
});

/** Two boundaries, over `a` and `b`. */
const TwoLabels = () =>
  Effect.gen(function* () {
    const first = yield* View.loading({
      fallback: <p id="pending-a">a</p>,
      content: labelOf("a", false),
    });
    const second = yield* View.loading({
      fallback: <p id="pending-b">b</p>,
      content: labelOf("b", false),
    });
    return (
      <section>
        {first}
        {second}
      </section>
    );
  });

describe("Resumed.closed", () => {
  it.scopedLive("completes once every live entry shows its seed's final state", () =>
    Effect.gen(function* () {
      yield* firstChunkOf(streamed(TwoLabels), { a: "Alpha", b: "Beta" }, ["a", "b"]);
      // The client's own read of `b` is held, so `StreamEnded` is what it shows.
      const client = yield* sideOf(makeControl({ b: "Beta" }, ["b"]));
      const { resumed } = yield* hydrateWith(client, (host, at) =>
        View.mount(TwoLabels, {}, host, at),
      );
      yield* append(lateRecord(idOf("a"), "Alpha"));
      yield* append({ _tag: "Closed", patched: [idOf("a")] });
      yield* resumed.closed;
      const a = yield* stateOf(client, "a");
      const b = yield* stateOf(client, "b");
      expect(a._tag === "Ready" && a.value).toEqual({ label: "Alpha" });
      expect(isStreamEnded(b)).toBe(true);
    }),
  );
});

/** A boundary over a list whose rows each read a query. */
const Listed = () =>
  Effect.gen(function* () {
    const boundary = yield* View.loading({
      fallback: <p id="pending">loading</p>,
      content: Effect.gen(function* () {
        const rows = yield* View.list({
          each: { get: Effect.succeed(["a", "b"]), changes: Stream.empty },
          keyBy: (id) => id,
          row: (item) =>
            Effect.gen(function* () {
              const id = yield* item.get;
              const entry = yield* QueryCache.use((cache) => cache.open(Label, { id }));
              const value = yield* View.ready(entry.state, { label: "?" });
              return <li id={`label-${id}`}>{View.bind(value, (found) => found.label)}</li>;
            }),
        });
        return <ul>{rows}</ul>;
      }),
    });
    return <section>{boundary}</section>;
  });

describe("an AwaitAll document over rows", () => {
  it.scopedLive("waits for the rows to register and draws them, with no fallback", () =>
    Effect.gen(function* () {
      const server = yield* sideOf(makeControl({ a: "Alpha", b: "Beta" }));
      const html = yield* Html.renderAwaitAll(Listed, {}, frame, {
        closeWhen: Effect.sleep("2 seconds"),
      }).pipe(Effect.provideContext(server), Effect.timeout("1 second"));
      expect(html).not.toContain("frame-boundary:fallback");
      expect(html).not.toContain("pending");
      expect(html).toContain('<li id="label-a">Alpha</li><li id="label-b">Beta</li>');
    }),
  );
});

/** Query `a` at the top; one list row, outside any boundary, whose setup declares `b` late. */
const LateRow = () =>
  Effect.gen(function* () {
    const a = yield* QueryCache.use((cache) => cache.open(Label, { id: "a" }));
    const rows = yield* View.list({
      each: { get: Effect.succeed(["b"]), changes: Stream.empty },
      keyBy: (id) => id,
      row: (item) =>
        Effect.gen(function* () {
          const id = yield* item.get;
          yield* Effect.sleep("80 millis");
          const entry = yield* QueryCache.use((cache) => cache.open(Label, { id }));
          return <li id={`row-${id}`}>{View.bind(entry.state, (state) => state._tag)}</li>;
        }),
    });
    return (
      <section>
        <p id="a">{View.bind(a.state, (state) => state._tag)}</p>
        <ul>{rows}</ul>
      </section>
    );
  });

const seedOf = (html: string): ReadonlyArray<Streaming.Patch> =>
  Option.match(
    Option.fromNullishOr(
      html.match(/<script type="application\/json" id="frame-query-seed">(.*?)<\/script>/),
    ),
    {
      onNone: () => [],
      onSome: (found) =>
        Schema.decodeUnknownSync(Streaming.SeedJson)(
          Option.getOrElse(Option.fromNullishOr(found[1]), () => "[]"),
        ),
    },
  );

describe("a list row whose setup ends after the frame", () => {
  it.scopedLive("holds an AwaitAll render until it ends, outside any boundary", () =>
    Effect.gen(function* () {
      const control = makeControl({ a: "Alpha", b: "Beta" }, ["a"]);
      const server = yield* sideOf(control);
      const rendering = yield* Effect.forkChild(
        Html.renderAwaitAll(LateRow, {}, frame, { closeWhen: Effect.sleep("5 seconds") }).pipe(
          Effect.provideContext(server),
        ),
      );
      yield* Effect.sleep("10 millis");
      yield* release(control, "a");
      // Well before the limit: the end of the row's setup wakes the render.
      const html = yield* Fiber.join(rendering).pipe(Effect.timeout("1 second"));
      expect(html).toContain('<li id="row-b">');
      expect(control.calls).toEqual(["a", "b"]);
      const seed = seedOf(html);
      expect(seed.map((patch) => patch.id)).toEqual([idOf("a"), idOf("b")]);
      expect(seed.every((patch) => patch.outcome._tag === "Value")).toBe(true);
    }),
  );

  it.scopedLive("is not in a streamed shell: the client draws the row and reads its query", () =>
    Effect.gen(function* () {
      // `a` is held, so the shell and the client agree on its state.
      const html = yield* firstChunkOf(streamed(LateRow), { a: "Alpha", b: "Beta" }, ["a"]);
      // The shell is written before the row's setup ends: no row, no record for `b`.
      expect(html).toContain("<ul></ul>");
      expect(recordsIn(html).some((record) => "id" in record && record.id === idOf("b"))).toBe(
        false,
      );

      const clientControl = makeControl({ b: "Beta" });
      const client = yield* sideOf(clientControl);
      const { report } = yield* hydrateWith(client, (host, at) =>
        View.mount(LateRow, {}, host, at),
      );
      expect(report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 0 });
      yield* eventually("the late row", () => textOf("#row-b") === "Ready");
      expect(clientControl.calls).toEqual(["b"]);
    }),
  );
});
