import { registerDom } from "./dom-setup.js";

registerDom();

import {
  ActorTransport,
  Behavior,
  Policies,
  Policy,
  Streaming,
  contract,
  implementTransparent,
  queryCacheLayer,
  ref,
} from "effect-frame/actor";
import type { QueryCache, TransportService } from "effect-frame/actor";
import { QueryTest } from "effect-frame/actor/testing";
import { Location, Route, mount as mountRouter, renderDocument } from "effect-frame/router";
import type { AnyRoute, LocationService, NotFoundProps } from "effect-frame/router";
import { Dom, View } from "effect-frame/view";
import { Context, Deferred, Effect, Layer, Option, Ref, Schema, Stream } from "effect";
import { describe, expect, it } from "effect-bun-test";
import {
  collect,
  eventually,
  frame,
  hydrateWith,
  install,
  recordsIn,
  textOf,
} from "../view/streaming-fixture.js";

/**
 * A route actor is seeded into the document (#37). The server's route opens
 * the actor's reference before its view draws; the document carries that
 * reference's committed snapshot beside the drawing, and the client's route
 * opens its reference from it. So the first frame holds the actor on both
 * sides and nothing reads its snapshot again. The seed is dropped when
 * hydration is done: a later route reads the actor.
 */

const origin = "http://app.test";

const Add = Schema.TaggedStruct("Add", { amount: Schema.Finite });
type Add = Schema.Schema.Type<typeof Add>;

const Counter = contract("RouteSeedCounter", {
  version: 1,
  policy: "public",
  key: Schema.Struct({ id: Schema.String }),
  snapshot: Schema.Finite,
  message: Schema.Union([Add]),
});

const counterBehavior = Behavior.reducer<number, Add>({
  initial: 0,
  reduce: (state, message) => state + message.amount,
});

const CounterLive = implementTransparent(Counter, { behavior: counterBehavior });

const counterSegment = Route.segment("counter", {
  path: "/counter/:id",
  params: Schema.Struct({ id: Schema.String }),
  data: ({ params }) => ({
    counter: Route.actor(Counter, { id: params.id }, { behavior: counterBehavior }),
  }),
});

const counterBranch = Route.leaf(counterSegment, (props) =>
  Effect.gen(function* () {
    const counter = yield* props.data.counter.get;
    return <p id="count">{View.bind(counter.state, (value) => String(value))}</p>;
  }),
);

/** The same segment, drawn with a button that sends through the route's reference. */
const sendingBranch = Route.leaf(counterSegment, (props) =>
  Effect.gen(function* () {
    const counter = yield* props.data.counter.get;
    return (
      <div>
        <p id="count">{View.bind(counter.state, (value) => String(value))}</p>
        <button
          id="add"
          type="button"
          onClick={View.event(() => Effect.asVoid(counter.send({ _tag: "Add", amount: 1 })))}
        >
          add
        </button>
      </div>
    );
  }),
);

/** A layout and its leaf that both declare the same actor. */
const detailSegment = Route.child(counterSegment, "detail", {
  path: "detail",
  params: Schema.Struct({ id: Schema.String }),
  data: ({ params }) => ({
    again: Route.actor(Counter, { id: params.id }, { behavior: counterBehavior }),
  }),
});

const twiceBranch = Route.layout(
  counterSegment,
  [
    Route.leaf(detailSegment, (props) =>
      Effect.gen(function* () {
        const again = yield* props.data.again.get;
        return <p id="again">{View.bind(again.state, (value) => String(value))}</p>;
      }),
    ),
  ],
  (props) =>
    Effect.gen(function* () {
      const counter = yield* props.data.counter.get;
      const outlet = yield* props.outlet;
      return (
        <section>
          <p id="count">{View.bind(counter.state, (value) => String(value))}</p>
          {outlet}
        </section>
      );
    }),
);

const modes: ReadonlyArray<{
  readonly mode: string;
  readonly app: AnyRoute<ActorTransport | QueryCache>;
}> = [
  { mode: "SSR", app: Route.ssr("seeded", counterBranch) },
  { mode: "Streamed", app: Route.streamed("seeded", counterBranch) },
  { mode: "AwaitAll", app: Route.awaitAll("seeded", counterBranch) },
];

const NotFound = (_props: NotFoundProps) => Effect.succeed(<p id="missing">missing</p>);

const locationAt = (href: string): Effect.Effect<LocationService> =>
  Effect.map(Ref.make(new URL(href)), (current) => ({
    current: Ref.get(current),
    push: (url) => Ref.set(current, url),
    replace: (url) => Ref.set(current, url),
    pops: Stream.never,
  }));

/** One in-process host that both sides reach, as a server and a browser reach one app. */
const sharedHost = Layer.build(
  QueryTest.layer({ queries: [], implementations: [CounterLive] }).pipe(
    Layer.provide(Layer.succeed(Policies, Policies.of({ public: Policy.allowAll }))),
    Layer.orDie,
  ),
);

/** A side over `transport`: its own query cache, so its own document seeds. */
const sideOver = (transport: TransportService) =>
  Effect.map(
    Layer.build(queryCacheLayer.pipe(Layer.provide(Layer.succeed(ActorTransport, transport)))),
    (built) => Context.add(built, ActorTransport, transport),
  );

/** The transport, with every snapshot read it serves recorded by key. */
const counting = (inner: TransportService, reads: Array<string>): TransportService => ({
  ...inner,
  snapshot: (address) =>
    Effect.andThen(
      Effect.sync(() => void reads.push(address.key)),
      inner.snapshot(address),
    ),
});

const seedScript = new RegExp(
  `<script type="application/json" id="${Streaming.actorSeedId}">(.*?)</script>`,
);

/** The actor seeds a document carries, in its script or as records. */
const actorSeedsIn = (html: string): ReadonlyArray<Streaming.ActorSeed> => {
  const recorded = recordsIn(html).filter(
    (record): record is Streaming.ActorSeed => record._tag === "ActorSeed",
  );
  const scripted = Option.match(Option.fromNullishOr(seedScript.exec(html)), {
    onNone: (): ReadonlyArray<Streaming.ActorSeed> => [],
    onSome: (found) =>
      Schema.decodeUnknownSync(Streaming.ActorSeedJson)(
        Option.getOrElse(Option.fromNullishOr(found[1]), () => "[]"),
      ),
  });
  return [...scripted, ...recorded];
};

const render = <R,>(routes: ReadonlyArray<AnyRoute<R>>, url: URL) =>
  Effect.flatMap(
    renderDocument({ routes, notFound: NotFound, url, document: frame, closeWhen: Effect.never }),
    (outcome) => {
      if (outcome._tag === "Rendered") {
        return Effect.map(collect(outcome.body), (chunks) => chunks.join(""));
      }
      return Effect.die(`expected a document, got a redirect to ${outcome.location.href}`);
    },
  );

describe("a route actor is seeded into the document (#37)", () => {
  for (const { mode, app } of modes) {
    it.scopedLive(
      `${mode}: the client's route opens the actor from the document and reads no snapshot`,
      () =>
        Effect.gen(function* () {
          const host = yield* sharedHost;
          const transport = Context.get(host, ActorTransport);
          const server = yield* sideOver(transport);
          const writer = yield* ref(Counter, { id: "a" }).pipe(Effect.provideContext(server));
          yield* writer.call({ _tag: "Add", amount: 3 }, { timeout: "1 second" });
          yield* writer.call({ _tag: "Add", amount: 4 }, { timeout: "1 second" });

          const url = new URL(`${origin}/counter/a`);
          const html = yield* render([app], url).pipe(Effect.provideContext(server));
          expect(html).toContain("7</p>");
          // The seed is the reference the route opened, at the drawing's instant.
          expect(actorSeedsIn(html).map(({ revision, snapshot }) => [revision, snapshot])).toEqual([
            [2, "7"],
          ]);

          const reads: Array<string> = [];
          const client = yield* sideOver(counting(transport, reads));
          const location = yield* locationAt(url.href);
          yield* install(html);
          const { report } = yield* hydrateWith(client, (over, root) =>
            mountRouter({ routes: [app], notFound: NotFound, host: over, root }).pipe(
              Effect.provideService(Location, location),
            ),
          );
          expect(report.mismatches).toEqual([]);
          expect(textOf("#count")).toBe("7");
          expect(reads).toEqual([]);

          // The reference follows the revisions after its seed.
          yield* writer.call({ _tag: "Add", amount: 1 }, { timeout: "1 second" });
          yield* eventually("the next revision", () => textOf("#count") === "8");
          expect(reads).toEqual([]);
        }),
      10_000,
    );
  }

  for (const { mode, app } of modes) {
    it.scopedLive(
      `${mode}: the seed and the drawing agree while the actor moves`,
      () =>
        Effect.gen(function* () {
          const host = yield* sharedHost;
          const transport = Context.get(host, ActorTransport);
          const server = yield* sideOver(transport);
          const writer = yield* ref(Counter, { id: "m" }).pipe(Effect.provideContext(server));
          // The actor commits without pause while the document is drawn.
          yield* Effect.forkScoped(
            Effect.forever(
              Effect.andThen(
                writer.call({ _tag: "Add", amount: 1 }, { timeout: "1 second" }),
                Effect.yieldNow,
              ),
            ),
          );
          yield* Stream.runHead(Stream.filter(writer.state.changes, (count) => count >= 5));
          const seen = new Set<string>();
          for (let run = 0; run < 20; run++) {
            const html = yield* render([app], new URL(`${origin}/counter/m`)).pipe(
              Effect.provideContext(server),
            );
            const drawn = Option.fromNullishOr(/id="count"[^>]*>(\d+)<\/p>/.exec(html)?.[1]);
            const seeded = actorSeedsIn(html).map(({ snapshot }) => snapshot);
            expect(seeded).toEqual([Option.getOrThrow(drawn)]);
            seen.add(seeded.join());
            yield* Effect.sleep("2 millis");
          }
          // The actor moved between the documents: the agreement was tested.
          expect(seen.size).toBeGreaterThan(1);
        }),
      20_000,
    );
  }

  it.scopedLive("a layout and its leaf that declare one actor both open it from the seed", () =>
    Effect.gen(function* () {
      const app = Route.ssr("twice", twiceBranch);
      const host = yield* sharedHost;
      const transport = Context.get(host, ActorTransport);
      const server = yield* sideOver(transport);
      const writer = yield* ref(Counter, { id: "t" }).pipe(Effect.provideContext(server));
      yield* writer.call({ _tag: "Add", amount: 4 }, { timeout: "1 second" });
      const url = new URL(`${origin}/counter/t/detail`);
      const html = yield* render([app], url).pipe(Effect.provideContext(server));
      // The host moves on after the document was written.
      yield* writer.call({ _tag: "Add", amount: 1 }, { timeout: "1 second" });

      const reads: Array<string> = [];
      const client = yield* sideOver(counting(transport, reads));
      const location = yield* locationAt(url.href);
      yield* install(html);
      const { report } = yield* hydrateWith(client, (over, root) =>
        mountRouter({ routes: [app], notFound: NotFound, host: over, root }).pipe(
          Effect.provideService(Location, location),
        ),
      );
      expect(report.mismatches).toEqual([]);
      expect([textOf("#count"), textOf("#again")]).toEqual(["4", "4"]);
      expect(reads).toEqual([]);
    }),
  );

  it.scopedLive(
    "a layout and its leaf on one actor draw one revision when a commit lands between their opens",
    () =>
      Effect.gen(function* () {
        const app = Route.ssr("between", twiceBranch);
        const host = yield* sharedHost;
        const transport = Context.get(host, ActorTransport);
        const writer = yield* ref(Counter, { id: "w" }).pipe(
          Effect.provideContext(yield* sideOver(transport)),
        );
        yield* writer.call({ _tag: "Add", amount: 4 }, { timeout: "1 second" });
        // The first opener's change stream is held for the whole render, and
        // a commit lands before any later snapshot read.
        let snapshots = 0;
        let streams = 0;
        const between: TransportService = {
          ...transport,
          snapshot: (address) =>
            Effect.suspend(() => {
              snapshots += 1;
              if (snapshots === 1) {
                return transport.snapshot(address);
              }
              return Effect.andThen(
                Effect.orDie(writer.call({ _tag: "Add", amount: 1 }, { timeout: "1 second" })),
                transport.snapshot(address),
              );
            }),
          changes: (address, after) =>
            Stream.suspend(() => {
              streams += 1;
              if (streams === 1) {
                return Stream.never;
              }
              return transport.changes(address, after);
            }),
        };
        const server = yield* sideOver(between);
        const url = new URL(`${origin}/counter/w/detail`);
        const html = yield* render([app], url).pipe(Effect.provideContext(server));
        // One address, one revision in the document and in the drawing.
        expect(actorSeedsIn(html)).toHaveLength(1);

        const client = yield* sideOver(transport);
        const location = yield* locationAt(url.href);
        yield* install(html);
        const { report } = yield* hydrateWith(client, (over, root) =>
          mountRouter({ routes: [app], notFound: NotFound, host: over, root }).pipe(
            Effect.provideService(Location, location),
          ),
        );
        expect(report.mismatches).toEqual([]);
        expect(textOf("#count")).toBe(textOf("#again"));
      }),
    10_000,
  );

  it.scopedLive(
    "after hydration, a route that opens the actor again reads it, never the seed",
    () =>
      Effect.gen(function* () {
        const app = Route.ssr("seeded", counterBranch);
        const host = yield* sharedHost;
        const transport = Context.get(host, ActorTransport);
        const server = yield* sideOver(transport);
        const url = new URL(`${origin}/counter/a`);
        const html = yield* render([app], url).pipe(Effect.provideContext(server));

        const reads: Array<string> = [];
        const client = yield* sideOver(counting(transport, reads));
        const location = yield* locationAt(url.href);
        yield* install(html);
        let navigate: (href: string) => Effect.Effect<void> = () => Effect.void;
        yield* hydrateWith(client, (over, root) =>
          Effect.map(
            mountRouter({ routes: [app], notFound: NotFound, host: over, root }).pipe(
              Effect.provideService(Location, location),
            ),
            (router) => {
              navigate = router.navigate;
            },
          ),
        );
        expect(reads).toEqual([]);
        yield* navigate("/counter/b");
        yield* eventually("counter b", () => textOf("#count") === "0");
        yield* navigate("/counter/a");
        yield* eventually("counter a again", () => reads.length === 2);
        expect(reads).toEqual(['{"id":"b"}', '{"id":"a"}']);
      }),
    10_000,
  );

  it.scopedLive("a seed no route took by the end of hydration is dropped: the route reads", () =>
    Effect.gen(function* () {
      const app = Route.client("late", counterBranch);
      const host = yield* sharedHost;
      const transport = Context.get(host, ActorTransport);
      const server = yield* sideOver(transport);
      const writer = yield* ref(Counter, { id: "z" }).pipe(Effect.provideContext(server));
      yield* writer.call({ _tag: "Add", amount: 2 }, { timeout: "1 second" });
      const url = new URL(`${origin}/counter/z`);
      const html = yield* render([Route.ssr("seeded", counterBranch)], url).pipe(
        Effect.provideContext(server),
      );
      // The host moves on after the document was written.
      yield* writer.call({ _tag: "Add", amount: 3 }, { timeout: "1 second" });

      const reads: Array<string> = [];
      const client = yield* sideOver(counting(transport, reads));
      const location = yield* locationAt(url.href);
      yield* install(html);
      yield* Effect.gen(function* () {
        const resumed = yield* Streaming.resume(yield* Dom.readRecords);
        // Hydration is done before any route took the seed.
        yield* resumed.hydrated;
        const root = document.createElement("main");
        document.body.replaceChildren(root);
        yield* mountRouter({ routes: [app], notFound: NotFound, host: Dom.host, root }).pipe(
          Effect.provideService(Location, location),
        );
        yield* View.flush;
      }).pipe(Effect.provideContext(client));
      yield* eventually("the current count", () => textOf("#count") === "5");
      expect(reads).toEqual(['{"id":"z"}']);
    }),
  );

  it.scopedLive("a route actor with a behavior predicts a send before its reply", () =>
    Effect.gen(function* () {
      const app = Route.client("predicting", sendingBranch);
      const host = yield* sharedHost;
      const transport = Context.get(host, ActorTransport);
      const sends: Array<string> = [];
      const gate = yield* Deferred.make<void>();
      const holding: TransportService = {
        ...transport,
        send: (address, commandId, payload, active) =>
          Effect.sync(() => void sends.push(payload)).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.andThen(transport.send(address, commandId, payload, active)),
          ),
      };
      const client = yield* sideOver(holding);
      const location = yield* locationAt(`${origin}/counter/p`);
      yield* install('<body><main id="app"></main></body>');
      yield* hydrateWith(client, (over, root) =>
        mountRouter({ routes: [app], notFound: NotFound, host: over, root }).pipe(
          Effect.provideService(Location, location),
        ),
      );
      yield* eventually("the counter", () => textOf("#count") === "0");
      yield* Effect.sync(() => document.getElementById("add")?.dispatchEvent(new Event("click")));
      // Predicted while the send is held on the wire.
      yield* eventually("the predicted count", () => textOf("#count") === "1");
      expect(sends).toHaveLength(1);
      yield* Deferred.succeed(gate, void 0);
      // The host committed it: another reference reads the same count.
      const reader = yield* ref(Counter, { id: "p" }).pipe(Effect.provideContext(client));
      const committed = yield* Stream.runHead(
        Stream.filter(reader.state.changes, (count) => count === 1),
      ).pipe(Effect.timeout("2 seconds"));
      expect(committed).toEqual(Option.some(1));
      expect(textOf("#count")).toBe("1");
    }),
  );
});
