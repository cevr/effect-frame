import { registerDom } from "./dom-setup.js";

registerDom();

import { QueryCache, Streaming, useQuery, QueryState } from "effect-frame/actor";
import type { ActorTransport } from "effect-frame/actor";
import {
  Errored,
  Html,
  Loading,
  Query,
  View,
  mount,
  orErrored,
  ready,
  render,
} from "effect-frame/view";
import { Deferred, Effect, Option, Stream } from "effect";
import type { Scope } from "effect";
import type { Node } from "effect-frame/view";
import { describe, expect, it } from "effect-bun-test";
import {
  Label,
  collect,
  eventually,
  frame,
  hydrateWith,
  idOf,
  install,
  lateRecord,
  makeControl,
  noLimit,
  recordsIn,
  release,
  sideOf,
  textOf,
  valueRecord,
} from "./streaming-fixture.js";
import { readAhead } from "../../src/actor/read-ahead.js";
import type { Side } from "./streaming-fixture.js";

/**
 * A patch the server wrote after its shell, read before hydration (#22).
 * The shell drew the entry open. Until hydration is done, a node the client
 * claims shows what the server drew, so the patch lands only then; a
 * readiness boundary may draw it ahead, because its marks let it replace
 * the server's branch. EGW search found the fault: from 0.20.1 the client
 * drew the patched value over the shell's nodes, so a text with no boundary
 * mismatched, and a `Query` kept the loading branch's attributes.
 */

const attributeOf = (selector: string, name: string): Option.Option<string> =>
  Option.flatMap(Option.fromNullishOr(document.querySelector(selector)), (found) =>
    Option.fromNullishOr(found.getAttribute(name)),
  );

/**
 * The document `rendering` writes, with `a` held past the shell and then
 * released: the first chunk is the shell, so `a` is released once it is out.
 */
const lateDocument = (control: ReturnType<typeof makeControl>, rendering: Stream.Stream<string>) =>
  Effect.map(collect(Stream.tap(rendering, () => release(control, "a"))), (chunks) =>
    chunks.join(""),
  );

/** `view` streamed over `server`, with no time limit. */
const streamed = <Props,>(
  server: Side,
  view: (props: Props) => Effect.Effect<Node, never, QueryCache | ActorTransport | Scope.Scope>,
  props: Props,
): Stream.Stream<string> =>
  Html.renderToStream(view, props, frame, noLimit).pipe(
    Stream.provideContext(server),
    Stream.orDie,
  );

/** EGW's status line: no boundary, the view reads the query state itself. */
const Unbounded = (props: { readonly id: string }) =>
  Effect.gen(function* () {
    const entry = yield* useQuery(Label, { id: props.id });
    const status = View.bind(entry.state, (state) => {
      if (state._tag === "Ready") {
        return state.value.label;
      }
      return `searching ${props.id}`;
    });
    const busy = View.bind(entry.state, (state) => {
      if (state._tag === "Loading") {
        return "hit skeleton";
      }
      return "hit";
    });
    return (
      <section>
        <p id="status">{status}</p>
        <ul>
          <li id="row" class={busy}>
            row
          </li>
        </ul>
      </section>
    );
  });

/** EGW's results: a `Query` whose branches differ in their static attributes. */
const Branches = (props: { readonly id: string }) =>
  Effect.gen(function* () {
    const entry = yield* useQuery(Label, { id: props.id });
    return (
      <section>
        <Query
          state={entry.state}
          loading={
            <ul class="results" aria-busy="true">
              <li id="row" class="hit skeleton">
                ...
              </li>
            </ul>
          }
          failed={() => <p>failed</p>}
          ready={(value) => (
            <ul class="results">
              <li id="row" class="hit">
                {View.bind(value, (found) => found.label)}
              </li>
            </ul>
          )}
        />
      </section>
    );
  });

/** A boundary and a text outside it that read one key. */
const Beside = (props: { readonly id: string }) =>
  Effect.gen(function* () {
    const outside = yield* useQuery(Label, { id: props.id });
    const status = View.bind(outside.state, (state) => {
      if (state._tag === "Ready") {
        return `found ${state.value.label}`;
      }
      return "searching";
    });
    const scope = yield* Loading({
      fallback: <p id="pending">loading</p>,
      children: Effect.gen(function* () {
        const entry = yield* useQuery(Label, { id: props.id });
        const value = yield* ready(entry.state, { label: "?" });
        return <p id="label">{View.bind(value, (found) => found.label)}</p>;
      }),
    });
    return (
      <section>
        {scope}
        <p id="status">{status}</p>
      </section>
    );
  });

/** An `Errored` boundary whose content binds the state `orErrored` returns. */
const Guarded = (props: { readonly id: string }) =>
  Errored({
    fallback: () => <p id="failed">failed</p>,
    children: Effect.gen(function* () {
      const entry = yield* useQuery(Label, { id: props.id });
      const state = yield* orErrored(entry.state);
      const status = View.bind(state, (found) => {
        if (found._tag === "Ready") {
          return found.value.label;
        }
        return "waiting";
      });
      return <p id="status">{status}</p>;
    }),
  });

describe("a patch written after the shell and read before hydration", () => {
  it.scopedLive("is marked late on the wire; a shell patch is not", () =>
    Effect.gen(function* () {
      const serverControl = makeControl({ a: "Alpha", b: "Beta" }, ["a"]);
      const server = yield* sideOf(serverControl);
      const Two = () =>
        Effect.gen(function* () {
          const a = yield* useQuery(Label, { id: "a" });
          const b = yield* useQuery(Label, { id: "b" });
          yield* b.state.changes.pipe(
            Stream.filter((state) => state._tag !== "Loading"),
            Stream.take(1),
            Stream.runDrain,
          );
          const text = (state: typeof a.state) =>
            View.bind(state, (found) => {
              if (found._tag === "Ready") {
                return found.value.label;
              }
              return "...";
            });
          return (
            <p>
              {text(a.state)}
              {text(b.state)}
            </p>
          );
        });
      const html = yield* lateDocument(serverControl, streamed(server, Two, {}));
      const patches = recordsIn(html).filter((record) => record._tag === "Patch");
      expect(patches.map((patch) => [patch.outcome, "late" in patch && patch.late])).toEqual([
        [{ _tag: "Value", value: '{"label":"Beta"}' }, false],
        [{ _tag: "Value", value: '{"label":"Alpha"}' }, true],
      ]);
    }),
  );

  it.scopedLive("a text with no boundary hydrates with no mismatch, then shows the value", () =>
    Effect.gen(function* () {
      const serverControl = makeControl({ a: "Alpha" }, ["a"]);
      const server = yield* sideOf(serverControl);
      const html = yield* lateDocument(serverControl, streamed(server, Unbounded, { id: "a" }));
      expect(html).toContain("searching a");
      expect(html).toContain('class="hit skeleton"');

      const clientControl = makeControl({});
      const client = yield* sideOf(clientControl);
      yield* install(html);
      const { report } = yield* hydrateWith(client, (host, root) =>
        mount(Unbounded, { id: "a" }, host, root),
      );
      expect(report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 0 });
      yield* render;
      yield* eventually("the patched status", () => textOf("#status") === "Alpha");
      expect(attributeOf("#row", "class")).toEqual(Option.some("hit"));
      // The value came from the document: the client read nothing.
      expect(clientControl.calls).toEqual([]);
    }),
  );

  it.scopedLive(
    "a Query claims the branch the server drew, then draws the ready branch fresh",
    () =>
      Effect.gen(function* () {
        const serverControl = makeControl({ a: "Alpha" }, ["a"]);
        const server = yield* sideOf(serverControl);
        const html = yield* lateDocument(serverControl, streamed(server, Branches, { id: "a" }));
        expect(html).toContain('class="hit skeleton"');

        const clientControl = makeControl({});
        const client = yield* sideOf(clientControl);
        yield* install(html);
        const { report } = yield* hydrateWith(client, (host, root) =>
          mount(Branches, { id: "a" }, host, root),
        );
        expect(report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 0 });
        yield* render;
        yield* eventually("the ready branch", () => textOf("#row") === "Alpha");
        expect(attributeOf("#row", "class")).toEqual(Option.some("hit"));
        expect(attributeOf("ul", "aria-busy")).toEqual(Option.none());
        expect(clientControl.calls).toEqual([]);
      }),
  );

  it.scopedLive(
    "a boundary that keeps the server's branch claims it with what the server drew",
    () =>
      Effect.gen(function* () {
        const serverControl = makeControl({ a: "Alpha" }, ["a"]);
        const server = yield* sideOf(serverControl);
        const html = yield* lateDocument(serverControl, streamed(server, Guarded, { id: "a" }));
        expect(html).toContain('<p id="status">waiting</p>');

        const clientControl = makeControl({});
        const client = yield* sideOf(clientControl);
        yield* install(html);
        const { report } = yield* hydrateWith(client, (host, root) =>
          mount(Guarded, { id: "a" }, host, root),
        );
        // A value fails nothing, so the content stays, claimed: it shows
        // the server's text until hydration is done, then the value.
        expect(report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 0 });
        yield* render;
        yield* eventually("the patched status", () => textOf("#status") === "Alpha");
        expect(clientControl.calls).toEqual([]);
      }),
  );

  it.scopedLive(
    "a boundary draws the value ahead, and a text beside it that reads the same key waits",
    () =>
      Effect.gen(function* () {
        const serverControl = makeControl({ a: "Alpha" }, ["a"]);
        const server = yield* sideOf(serverControl);
        const html = yield* lateDocument(serverControl, streamed(server, Beside, { id: "a" }));
        expect(html).toContain('<p id="pending">loading</p>');
        expect(html).toContain('<p id="status">searching</p>');

        const clientControl = makeControl({});
        const client = yield* sideOf(clientControl);
        yield* install(html);
        const { report } = yield* hydrateWith(client, (host, root) =>
          mount(Beside, { id: "a" }, host, root),
        );
        // The boundary's marks let it replace the fallback; the text has none.
        expect(report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 1 });
        expect(textOf("#label")).toBe("Alpha");
        yield* render;
        yield* eventually("the patched status", () => textOf("#status") === "found Alpha");
        expect(clientControl.calls).toEqual([]);
      }),
  );
});

// ---------------------------------------------------------------------------
// The document's held settles (review round 1)
// ---------------------------------------------------------------------------

const placeholderOf = (id: string): Streaming.Placeholder => ({
  _tag: "Placeholder",
  id: idOf(id),
  kind: "query",
});

const closedRecord: Streaming.Closed = { _tag: "Closed", patched: [idOf("a")] };

/** Resume `present` now, and `later` once `gate` opens. */
const resumeWith = (
  present: ReadonlyArray<Streaming.StreamRecord>,
  later: ReadonlyArray<Streaming.StreamRecord>,
  gate: Deferred.Deferred<void>,
) =>
  Streaming.resume({
    present,
    later: Stream.unwrap(Effect.as(Deferred.await(gate), Stream.fromIterable(later))),
  });

const within = <A,>(label: string, effect: Effect.Effect<A>) =>
  Effect.timeoutOrElse(effect, {
    duration: "1 second",
    orElse: () => Effect.die(`${label} did not complete`),
  });

describe("the settles a document holds until hydration", () => {
  it.scopedLive("closed completes when the channel ends, before hydration", () =>
    Effect.gen(function* () {
      const client = yield* sideOf(makeControl({}));
      yield* Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const resumed = yield* resumeWith(
          [placeholderOf("a")],
          [lateRecord(idOf("a"), "Alpha"), closedRecord],
          gate,
        );
        const cache = yield* QueryCache;
        // A slot takes the seed while it is open; the patch and Closed come after.
        const entry = yield* cache.open(Label, { id: "a" });
        yield* Deferred.succeed(gate, void 0);
        yield* within("closed before hydrated", resumed.closed);
        // Held: the entry shows what the shell drew until hydration is done.
        expect((yield* entry.state.get)._tag).toBe("Loading");
        yield* resumed.hydrated;
        // After both, the entry shows its value: no wait.
        expect(yield* entry.state.get).toEqual(QueryState.Ready({ label: "Alpha" }, false));
      }).pipe(Effect.provideContext(client));
    }),
  );

  it.scopedLive("hydrated completes before the channel ends, and closed after it", () =>
    Effect.gen(function* () {
      const client = yield* sideOf(makeControl({}));
      yield* Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const resumed = yield* resumeWith(
          [placeholderOf("a")],
          [lateRecord(idOf("a"), "Alpha"), closedRecord],
          gate,
        );
        const cache = yield* QueryCache;
        const entry = yield* cache.open(Label, { id: "a" });
        // Hydration is done while the key is still open: it waits for no patch.
        yield* within("hydrated before the channel ends", resumed.hydrated);
        expect((yield* entry.state.get)._tag).toBe("Loading");
        // A late patch after hydration lands at once, and closed waits for it.
        yield* Deferred.succeed(gate, void 0);
        yield* within("closed after hydrated", resumed.closed);
        expect(yield* entry.state.get).toEqual(QueryState.Ready({ label: "Alpha" }, false));
      }).pipe(Effect.provideContext(client));
    }),
  );

  it.scopedLive("after closed and hydrated, an entry opened after Closed shows its value", () =>
    Effect.gen(function* () {
      const client = yield* sideOf(makeControl({}));
      yield* Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const resumed = yield* resumeWith(
          [placeholderOf("a"), lateRecord(idOf("a"), "Alpha"), closedRecord],
          [],
          gate,
        );
        yield* within("closed", resumed.closed);
        const cache = yield* QueryCache;
        const entry = yield* cache.open(Label, { id: "a" });
        expect((yield* entry.state.get)._tag).toBe("Loading");
        yield* resumed.hydrated;
        expect(yield* entry.state.get).toEqual(QueryState.Ready({ label: "Alpha" }, false));
      }).pipe(Effect.provideContext(client));
    }),
  );

  it.scopedLive("a slot that did not take the seed never reads it ahead", () =>
    Effect.gen(function* () {
      const clientControl = makeControl({ a: "New" }, ["a"]);
      const client = yield* sideOf(clientControl);
      yield* Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        yield* resumeWith([placeholderOf("a"), lateRecord(idOf("a"), "Old")], [], gate);
        const cache = yield* QueryCache;
        // The first slot takes the seed, then closes: nothing declares the key.
        const closed = yield* Effect.scoped(
          Effect.map(cache.open(Label, { id: "a" }), (first) => readAhead(first.state, () => true)),
        );
        // The closed slot's own entry no longer reads it either.
        expect((yield* closed.get)._tag).toBe("Loading");
        const reopened = yield* cache.open(Label, { id: "a" });
        const ahead = readAhead(reopened.state, () => true);
        expect(yield* ahead.get).toEqual(yield* reopened.state.get);
        expect((yield* ahead.get)._tag).toBe("Loading");
      }).pipe(Effect.provideContext(client));
    }),
  );

  it.scopedLive("a read that supersedes the seed ends its read-ahead", () =>
    Effect.gen(function* () {
      const clientControl = makeControl({ a: "New" }, ["a"]);
      const client = yield* sideOf(clientControl);
      yield* Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        yield* resumeWith([placeholderOf("a"), lateRecord(idOf("a"), "Old")], [], gate);
        const cache = yield* QueryCache;
        const entry = yield* cache.open(Label, { id: "a" });
        const ahead = readAhead(entry.state, () => true);
        expect(yield* ahead.get).toEqual(QueryState.Ready({ label: "Old" }, false));
        // The client reads the key itself: the seed can no longer land.
        yield* Effect.forkScoped(entry.refresh);
        yield* eventually("the read started", () => clientControl.calls.includes("a"));
        expect((yield* ahead.get)._tag).toBe("Loading");
      }).pipe(Effect.provideContext(client));
    }),
  );

  it.scopedLive("a patch with no late flag lands at once, as before 0.26.2", () =>
    Effect.gen(function* () {
      const client = yield* sideOf(makeControl({}));
      yield* Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const resumed = yield* resumeWith(
          [placeholderOf("a"), valueRecord(idOf("a"), "Alpha"), closedRecord],
          [],
          gate,
        );
        const cache = yield* QueryCache;
        const entry = yield* cache.open(Label, { id: "a" });
        // The shell's own patch: the first read shows it, before hydration.
        expect(yield* entry.state.get).toEqual(QueryState.Ready({ label: "Alpha" }, false));
        yield* within("closed", resumed.closed);
      }).pipe(Effect.provideContext(client));
    }),
  );
});
