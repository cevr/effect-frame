import { registerDom } from "./dom-setup.js";

registerDom();

import { Streaming, followQuery, useQuery } from "effect-frame/actor";
import type { ActorTransport, QueryCache, QueryFailure, QueryState } from "effect-frame/actor";
import { Source } from "effect-frame/actor/client";
import type { Node } from "effect-frame/view";
import { Html, View } from "effect-frame/view";
import type { Scope } from "effect";
import { Cause, Effect, Exit, Fiber, Option, Stream } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { renderSeeded, requestCache } from "../../src/view/hosts/html.js";
import {
  Label,
  Moving,
  frame,
  hydrateWith,
  idOf,
  eventually,
  install,
  makeControl,
  parsing,
  recordsIn,
  release,
  sideOf,
  textOf,
  valueRecord,
} from "./streaming-fixture.js";
import type { Mover } from "./streaming-fixture.js";

/**
 * A server drawing shows every value its seed carries (#22). A value goes
 * from the cache to the drawing through a chain of sources, and a fiber
 * carries each step, so the drawing can be older than the cache. The seed
 * is read from the cache. EGW search found it: an `AwaitAll` page whose
 * view follows a query with `followQuery`, with no `Loading` boundary,
 * drew "searching" beside a seed that carried the results, and the client
 * drew the results over it. Each proof below chains a few sources the way
 * that view does.
 */

type Labelled = QueryState<{ readonly label: string }, QueryFailure>;

const shown = (state: Labelled): string => {
  if (state._tag === "Ready") {
    return state.value.label;
  }
  return "searching";
};

const constant = <A,>(value: A): Source<A> => ({
  get: Effect.succeed(value),
  changes: Stream.succeed(value),
});

/** The source zipped with a constant `hops` times: each zip is one more step on a fiber. */
const through = <A,>(source: Source<A>, hops: number): Source<A> =>
  Array.from({ length: hops }).reduce<Source<A>>(
    (chained) => Source.zip(chained, constant(0), (value) => value),
    source,
  );

/** Wait in setup until `id` has settled: the drawing then binds a settled entry. */
const settled = (id: string) =>
  Effect.gen(function* () {
    const entry = yield* useQuery(Label, { id });
    yield* entry.state.changes.pipe(
      Stream.filter((state) => state._tag !== "Loading"),
      Stream.take(1),
      Stream.runDrain,
    );
  });

type Drawn = Effect.Effect<Node, never, QueryCache | ActorTransport | Scope.Scope>;

/** EGW's shape: `followQuery`, a zip, no boundary. */
const Following = (props: { readonly waits: boolean }): Drawn =>
  Effect.gen(function* () {
    if (props.waits) {
      yield* settled("a");
    }
    const followed = yield* followQuery(Label, constant(Option.some({ id: "a" })));
    return <p id="state">{View.bind(through(followed.state, 1), shown)}</p>;
  });

/** A `Loading` boundary whose value goes through three steps each side of `ready`. */
const Bounded = (): Drawn =>
  View.loading({
    fallback: <p id="pending">loading</p>,
    content: Effect.gen(function* () {
      const followed = yield* followQuery(Label, constant(Option.some({ id: "a" })));
      const value = yield* View.ready(through(followed.state, 3), { label: "?" });
      return <p id="state">{View.bind(through(value, 3), (found) => found.label)}</p>;
    }),
  });

const stateIn = (html: string): string =>
  Option.getOrElse(
    Option.flatMap(Option.fromNullishOr(/<p id="state">([^<]*)<\/p>/.exec(html)), (found) =>
      Option.fromNullishOr(found[1]),
    ),
    () => "absent",
  );

describe("an AwaitAll drawing and its seed", () => {
  it.scopedLive(
    "a view that follows a query with no boundary draws the value the seed carries, and hydrates with no mismatch",
    () =>
      Effect.gen(function* () {
        const server = yield* sideOf(makeControl({ a: "Alpha" }));
        const html = yield* Effect.provideContext(
          Html.renderAwaitAll(Following, { waits: false }, frame, { closeWhen: Effect.never }),
          server,
        );
        expect(stateIn(html)).toBe("Alpha");

        const clientControl = makeControl({});
        const client = yield* sideOf(clientControl);
        yield* install(html);
        const { report, resumed } = yield* hydrateWith(client, (host, root) =>
          View.mount(Following, { waits: false }, host, root),
        );
        yield* resumed.closed;
        expect(report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 0 });
        expect(textOf("#state")).toBe("Alpha");
        expect(clientControl.calls).toEqual([]);
      }),
  );

  it.scopedLive("a value that settles late draws too", () =>
    Effect.gen(function* () {
      const control = makeControl({ a: "Alpha" }, ["a"]);
      const server = yield* sideOf(control);
      const rendering = yield* Effect.forkChild(
        Effect.provideContext(
          Html.renderAwaitAll(Following, { waits: false }, frame, { closeWhen: Effect.never }),
          server,
        ),
      );
      yield* Effect.sleep("20 millis");
      yield* release(control, "a");
      expect(stateIn(yield* Fiber.join(rendering))).toBe("Alpha");
    }),
  );

  it.scopedLive(
    "a boundary whose value goes through several sources draws the value, not the fallback value",
    () =>
      Effect.gen(function* () {
        const server = yield* sideOf(makeControl({ a: "Alpha" }));
        const html = yield* Effect.provideContext(
          Html.renderAwaitAll(Bounded, {}, frame, { closeWhen: Effect.never }),
          server,
        );
        expect(stateIn(html)).toBe("Alpha");

        const client = yield* sideOf(makeControl({}));
        yield* install(html);
        const { report } = yield* hydrateWith(client, (host, root) =>
          View.mount(Bounded, {}, host, root),
        );
        expect(report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 0 });
      }),
  );
});

describe("a streamed shell and its settled patches", () => {
  it.scopedLive(
    "a query settled while the shell rendered is drawn in the shell, and the shell hydrates with no mismatch",
    () =>
      Effect.gen(function* () {
        const server = yield* sideOf(makeControl({ a: "Alpha" }));
        const first = yield* Effect.map(
          Stream.runHead(
            Html.renderToStream(Following, { waits: true }, frame, {
              closeWhen: Effect.never,
            }).pipe(Stream.provideContext(server)),
          ),
          Option.getOrThrow,
        );
        expect(recordsIn(first)).toContainEqual(valueRecord(idOf("a"), "Alpha"));
        expect(stateIn(first)).toBe("Alpha");

        const client = yield* sideOf(makeControl({}));
        yield* parsing;
        yield* install(first);
        const { report } = yield* hydrateWith(client, (host, root) =>
          View.mount(Following, { waits: true }, host, root),
        );
        expect(report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 0 });
      }),
  );
});

describe("an SSR drawing and its seed", () => {
  it.scopedLive("a query settled before the seed is read is drawn", () =>
    Effect.gen(function* () {
      const server = yield* sideOf(makeControl({ a: "Alpha" }));
      const html = yield* Effect.provideContext(
        renderSeeded(
          (host, root) => View.mount(Following, { waits: true }, host, root),
          frame,
          { closeWhen: Effect.never },
          requestCache,
        ),
        server,
      );
      expect(html).toContain(`id="${Streaming.seedId}"`);
      expect(stateIn(html)).toBe("Alpha");
    }),
  );
});

/**
 * A value the server shows stale, here set by `override` on the server
 * only. The server draws the flag, so the seed must carry it (review
 * round 1, finding 2).
 */
const Overridden = (props: { readonly server: boolean; readonly pause?: boolean }): Drawn =>
  View.loading({
    fallback: <p id="pending">loading</p>,
    content: Effect.gen(function* () {
      yield* settled("a");
      const entry = yield* useQuery(Label, { id: "a" });
      if (props.server) {
        yield* entry.override(() => ({ label: "Draft" }));
      }
      // Setup that takes a while after the key is declared, before the drawing.
      if (props.pause === true) {
        yield* Effect.sleep("30 millis");
      }
      const value = yield* View.readyWithStale(entry.state, { label: "?" });
      return (
        <p id="state">
          {View.bind(value, (found) => `${found.value.label}:${String(found.stale)}`)}
        </p>
      );
    }),
  });

describe("a value the server shows stale", () => {
  it.scopedLive("is seeded stale, and the page hydrates with no mismatch", () =>
    Effect.gen(function* () {
      const server = yield* sideOf(makeControl({ a: "Alpha" }));
      const html = yield* Effect.provideContext(
        Html.renderAwaitAll(Overridden, { server: true }, frame, { closeWhen: Effect.never }),
        server,
      );
      expect(stateIn(html)).toBe("Draft:true");

      // The client reads the value again; the read is held past hydration.
      const clientControl = makeControl({ a: "Alpha" }, ["a"]);
      const client = yield* sideOf(clientControl);
      yield* install(html);
      const { report } = yield* hydrateWith(client, (host, root) =>
        View.mount(Overridden, { server: false }, host, root),
      );
      expect(report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 0 });
      expect(textOf("#state")).toBe("Draft:true");
    }),
  );

  it.scopedLive(
    "a read that answers at once waits for hydration: no mismatch, then the fresh value (review round 2)",
    () =>
      Effect.gen(function* () {
        const server = yield* sideOf(makeControl({ a: "Alpha" }));
        const html = yield* Effect.provideContext(
          Html.renderAwaitAll(Overridden, { server: true }, frame, { closeWhen: Effect.never }),
          server,
        );
        expect(stateIn(html)).toBe("Draft:true");

        // The client's read is not held, and the view's setup pauses after
        // it declares the key: a read started when the seed landed would
        // have its reply before the first drawing.
        const clientControl = makeControl({ a: "Alpha" });
        const client = yield* sideOf(clientControl);
        yield* install(html);
        const { report } = yield* hydrateWith(client, (host, root) =>
          View.mount(Overridden, { server: false, pause: true }, host, root),
        );
        expect(report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 0 });
        yield* eventually("the fresh value", () => textOf("#state") === "Alpha:false");
        expect(clientControl.calls).toEqual(["a"]);
      }),
  );
});

/**
 * A binding whose value moves on every read. Each new value is a new row,
 * and each row declares a new query, so the records change on every pass
 * and never agree (review round 1, finding 4).
 */
const Restless = (): Drawn =>
  Effect.gen(function* () {
    let count = 0;
    const next = Effect.sync(() => {
      count += 1;
      return [String(count)];
    });
    const rows = yield* View.list({
      each: { get: next, changes: Stream.fromEffect(next) },
      keyBy: (id) => id,
      row: (item) =>
        Effect.gen(function* () {
          const id = yield* item.get;
          const entry = yield* useQuery(Label, { id });
          return <li>{View.bind(entry.state, (state) => state._tag)}</li>;
        }),
    });
    return <ul>{rows}</ul>;
  });

describe("records that change on every pass", () => {
  it.scopedLive(
    "end at the limit: AwaitAll and the streamed shell refuse, SSR writes its agreed seed",
    () =>
      Effect.gen(function* () {
        const server = yield* sideOf(makeControl({}));
        const limit = { closeWhen: Effect.sleep("100 millis") };
        const awaited = yield* Effect.flip(
          Effect.provideContext(Html.renderAwaitAll(Restless, {}, frame, limit), server),
        );
        expect(awaited).toEqual(Html.RecordsUnsettled.make({}));
        const first = yield* Effect.flip(
          Stream.runHead(
            Html.renderToStream(Restless, {}, frame, limit).pipe(Stream.provideContext(server)),
          ),
        );
        expect(first).toEqual(Html.RecordsUnsettled.make({}));
        // SSR's seed holds only settled values, and no row's query settles:
        // its reads agree, and the document it writes is coherent.
        const seeded = yield* Effect.provideContext(
          renderSeeded(
            (host, root) => View.mount(Restless, {}, host, root),
            frame,
            limit,
            requestCache,
          ),
          server,
        );
        expect(seeded).toContain("</html>");
      }),
    5_000,
  );
});

/**
 * A query that moves in the final pass, after the drawing caught up and
 * before the records are read again (review round 2). Each pipeline either
 * writes a document the client hydrates with no mismatch, or refuses with
 * `RecordsUnsettled`. It never writes a seed its markup does not show.
 */
const coherentOrRefused = (written: Exit.Exit<string, Html.RecordsUnsettled>) =>
  Effect.gen(function* () {
    if (Exit.isFailure(written)) {
      expect(Cause.squash(written.cause)).toEqual(Html.RecordsUnsettled.make({}));
      return "refused";
    }
    const client = yield* sideOf(makeControl({ a: "Alpha" }, ["a", "held"]));
    yield* install(written.value);
    const { report } = yield* hydrateWith(client, (host, root) =>
      View.mount(Moving, { mover: { on: false, moves: 0 } }, host, root),
    );
    expect(report.mismatches).toEqual([]);
    return "coherent";
  }).pipe(Effect.scoped);

describe("a query that moves in the final pass", () => {
  it.scopedLive(
    "AwaitAll, the streamed shell and SSR never write a seed the markup does not show",
    () =>
      Effect.gen(function* () {
        const server = yield* sideOf(makeControl({ a: "Alpha" }, ["held"]));

        // AwaitAll waits on `held`; the limit starts the moves, then ends the wait.
        const waiting: Mover = { on: false, moves: 0 };
        const awaited = yield* Effect.exit(
          Effect.provideContext(
            Html.renderAwaitAll(Moving, { mover: waiting }, frame, {
              closeWhen: Effect.andThen(
                Effect.sleep("50 millis"),
                Effect.sync(() => void (waiting.on = true)),
              ),
            }),
            server,
          ),
        );
        expect(waiting.moves).toBeGreaterThan(0);
        expect(yield* coherentOrRefused(awaited)).toBe("refused");

        // The streamed shell and SSR: the moves run from the first drawing,
        // while `a` is still Loading. An override derives from the entry's
        // own Ready value (#19), so a Loading entry has nothing to move: the
        // moves write nothing, and both documents are coherent. The
        // streamed shell's refusal is `Restless`'s, above.
        const streaming: Mover = { on: true, moves: 0 };
        const first = yield* Effect.exit(
          Effect.map(
            Stream.runHead(
              Html.renderToStream(Moving, { mover: streaming }, frame, {
                closeWhen: Effect.void,
              }).pipe(Stream.provideContext(server)),
            ),
            Option.getOrThrow,
          ),
        );
        expect(streaming.moves).toBeGreaterThan(0);
        expect(yield* coherentOrRefused(first)).toBe("coherent");

        const seeding: Mover = { on: true, moves: 0 };
        const seeded = yield* Effect.exit(
          Effect.provideContext(
            renderSeeded(
              (host, root) => View.mount(Moving, { mover: seeding }, host, root),
              frame,
              { closeWhen: Effect.void },
              requestCache,
            ),
            server,
          ),
        );
        expect(seeding.moves).toBeGreaterThan(0);
        expect(yield* coherentOrRefused(seeded)).toBe("coherent");
      }),
    5_000,
  );
});
