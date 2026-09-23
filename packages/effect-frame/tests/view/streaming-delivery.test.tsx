/* oxlint-disable effect/noGlobals -- this proof reads happy-dom's document, the boundary under test. */
import { registerDom } from "./dom-setup.js";

registerDom();

import { Streaming, followQuery, useQuery } from "effect-frame/actor";
import type {
  ActorTransport,
  QueryCache,
  QueryFailure,
  QueryState,
  Source,
} from "effect-frame/actor";
import { zip } from "effect-frame/actor/client";
import type { Node } from "effect-frame/view";
import { Html, Loading, View, mount, ready } from "effect-frame/view";
import type { Scope } from "effect";
import { Effect, Fiber, Option, Stream } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { renderSeeded, requestCache } from "../../src/view/hosts/html.js";
import {
  Label,
  frame,
  hydrateWith,
  idOf,
  install,
  makeControl,
  parsing,
  recordsIn,
  release,
  sideOf,
  textOf,
  valueRecord,
} from "./streaming-fixture.js";

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
    (chained) => zip(chained, constant(0), (value) => value),
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
  Loading({
    fallback: <p id="pending">loading</p>,
    children: Effect.gen(function* () {
      const followed = yield* followQuery(Label, constant(Option.some({ id: "a" })));
      const value = yield* ready(through(followed.state, 3), { label: "?" });
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
          mount(Following, { waits: false }, host, root),
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
          mount(Bounded, {}, host, root),
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
          mount(Following, { waits: true }, host, root),
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
          (host, root) => mount(Following, { waits: true }, host, root),
          frame,
          requestCache,
        ),
        server,
      );
      expect(html).toContain(`id="${Streaming.seedId}"`);
      expect(stateIn(html)).toBe("Alpha");
    }),
  );
});
