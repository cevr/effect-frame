import { registerDom } from "./dom-setup.js";

registerDom();

import {
  ActorTransport,
  Behavior,
  Policies,
  Policy,
  QueryCache,
  contract,
  implementQuery,
  implementTransparent,
  queryCacheLayer,
  ref,
  useQuery,
  Source,
} from "effect-frame/actor";
import type { TransportService } from "effect-frame/actor";
import { QueryTest } from "effect-frame/actor/testing";
import { Location, Route, hydrate, renderDocument } from "effect-frame/router";
import type { AnyRoute, LocationService, NotFoundProps } from "effect-frame/router";
import { For, Loading, View, ready } from "effect-frame/view";
import * as Driven from "effect-frame/view/driven";
import { Context, Deferred, Effect, Layer, Option, Ref, Schema, Stream } from "effect";
import { describe, expect, it } from "effect-bun-test";
import {
  Label,
  append,
  eventually,
  frame,
  idOf,
  install,
  parsing,
  textOf,
  lateRecord,
} from "../view/streaming-fixture.js";

/**
 * A driven route (#36): its leaves are drawn over the op wire (#18 §6).
 * The server's document draws each leaf's view over its drive, the client
 * hydrates everything else, and the op wire opens only once the document
 * is over (#22 §5). Then the wire adopts the nodes the document drew, and
 * its patches move them. A leaf whose view is a client view is refused:
 * at the type level, and when the tree is declared.
 *
 * Every wait is a gate the test opens: the layout's query, and the
 * document's close.
 */

const origin = "http://app.test";

const Add = Schema.TaggedStruct("Add", { amount: Schema.Finite });
type Add = Schema.Schema.Type<typeof Add>;

const Room = contract("DrivenRoom", {
  version: 1,
  policy: "public",
  key: Schema.String,
  snapshot: Schema.Finite,
  message: Schema.Union([Add]),
});

const RoomLive = implementTransparent(
  Room,
  Behavior.reducer<number, Add>({ initial: 0, reduce: (state, message) => state + message.amount }),
);

/** The driven view: a count, and a button whose handler runs on the server. */
const RoomView = (params: { readonly room: string }) =>
  Effect.gen(function* () {
    const room = yield* Effect.orDie(ref(Room, params.room));
    return (
      <div>
        <p id="count">{View.bind(room.state, (count) => String(count))}</p>
        <button
          id="add"
          type="button"
          onClick={View.event(() => Effect.asVoid(room.send({ _tag: "Add", amount: 1 })))}
        >
          add
        </button>
      </div>
    );
  });

const roomDrive = (params: { readonly room: string }) => ({ contract: Room, key: params.room });

const shellSegment = Route.segment("rooms", { path: "/rooms", params: Schema.Struct({}) });

const roomSegment = Route.child(shellSegment, "room", {
  path: ":room",
  params: Schema.Struct({ room: Schema.String }),
});

const Rotate = Schema.TaggedStruct("Rotate", {});
type Rotate = Schema.Schema.Type<typeof Rotate>;

/** A keyed list whose `Rotate` moves the first item to the end. */
const Lineup = contract("DrivenLineup", {
  version: 1,
  policy: "public",
  key: Schema.String,
  snapshot: Schema.Array(Schema.String),
  message: Schema.Union([Rotate]),
});

const LineupLive = implementTransparent(
  Lineup,
  Behavior.reducer<ReadonlyArray<string>, Rotate>({
    initial: ["a", "b", "c"],
    reduce: (state) => [...state.slice(1), ...state.slice(0, 1)],
  }),
);

const LineupView = (params: { readonly room: string }) =>
  Effect.gen(function* () {
    const lineup = yield* Effect.orDie(ref(Lineup, params.room));
    return (
      <ul id="lineup">
        <For each={Source.select(lineup.state, (items) => items)} keyBy={(item) => item}>
          {(item) => <li>{View.bind(item, (value) => value)}</li>}
        </For>
      </ul>
    );
  });

const lineup = Route.driven("lineup", {
  path: "/lineup/:room",
  params: Schema.Struct({ room: Schema.String }),
  search: Route.search(Schema.Struct({})),
  drive: (params: { readonly room: string }) => ({ contract: Lineup, key: params.room }),
  view: LineupView,
});

class RoomClosed extends Schema.TaggedError<RoomClosed>()("RoomClosed", {
  room: Schema.String,
}) {}

/** A driven view whose drawing fails with a typed error. */
const ClosedRoom = (params: { readonly room: string }) =>
  Effect.fail(RoomClosed.make({ room: params.room }));

const closedSegment = Route.segment("closed", { path: "/closed", params: Schema.Struct({}) });

/** A driven leaf whose view fails: its leaf draws the `errored` view. */
const closed = Route.driven(
  "closed",
  Route.layout(
    closedSegment,
    [
      Route.leaf(
        Route.child(closedSegment, "closedRoom", {
          path: ":room",
          params: Schema.Struct({ room: Schema.String }),
        }),
        Route.drivenView({ drive: roomDrive, view: ClosedRoom }),
        { errored: () => <p id="closed">closed</p> },
      ),
    ],
    (props) => props.outlet,
  ),
);

/** The layout's title: its query is held, so the document stays open until the test releases it. */
const Title = Loading({
  fallback: <p id="pending-title">loading</p>,
  children: Effect.gen(function* () {
    const entry = yield* useQuery(Label, { id: "title" });
    const value = yield* ready(entry.state, { label: "?" });
    return <h1 id="title">{View.bind(value, (found) => found.label)}</h1>;
  }),
});

/** The layout is an ordinary view: it hydrates, and its query streams. */
const app = Route.driven(
  "rooms",
  Route.layout(
    shellSegment,
    [Route.leaf(roomSegment, Route.drivenView({ drive: roomDrive, view: RoomView }))],
    (props) =>
      Effect.gen(function* () {
        const title = yield* Title;
        const outlet = yield* props.outlet;
        return (
          <section>
            {title}
            {outlet}
          </section>
        );
      }),
  ),
);

const NotFound = (_props: NotFoundProps) => Effect.succeed(<p id="missing">missing</p>);

const locationAt = (href: string): Effect.Effect<LocationService> =>
  Effect.map(Ref.make(new URL(href)), (current) => ({
    current: Ref.get(current),
    push: (url) => Ref.set(current, url),
    replace: (url) => Ref.set(current, url),
    pops: Stream.never,
  }));

/** One in-process host both sides reach: the room, and a layout query held on `title`. */
const sharedHost = (title: Deferred.Deferred<void>) =>
  Layer.build(
    QueryTest.layer({
      queries: [implementQuery(Label, () => Effect.as(Deferred.await(title), { label: "Rooms" }))],
      implementations: [RoomLive, LineupLive],
    }).pipe(
      Layer.provide(Layer.succeed(Policies, Policies.of({ public: Policy.allowAll }))),
      Layer.orDie,
    ),
  );

/** A side over `transport`, with its own query cache. */
const sideOver = (transport: TransportService) =>
  Effect.map(
    Layer.build(queryCacheLayer.pipe(Layer.provide(Layer.succeed(ActorTransport, transport)))),
    (built) => Context.add(built, ActorTransport, transport),
  );

/** What the in-process wire saw, by the leaf's path. */
interface WireLog {
  readonly connects: Array<string>;
  readonly sends: Array<string>;
  /** Sends interrupted before they reached the session. */
  readonly interrupted: Array<string>;
  /** While set, a send waits here before it reaches the session. */
  hold: Option.Option<Deferred.Deferred<void>>;
}

const wireLog = (): WireLog => ({ connects: [], sends: [], interrupted: [], hold: Option.none() });

/**
 * The op wire's two ends, in process: `connect` opens a `Driven.session` for
 * the driven leaf `Route.drivenAt` finds at the URL, as a server end would.
 */
const wireOver = <R,>(
  routes: ReadonlyArray<AnyRoute<R>>,
  transport: TransportService,
  log: WireLog,
): Route.OpWireService => ({
  reconnectAfter: "10 millis",
  connect: (url) =>
    Effect.gen(function* () {
      log.connects.push(url.pathname);
      const at = yield* Effect.fromOption(Route.drivenAt(routes, url)).pipe(
        Effect.mapError(() => Route.WireFailed.make({ reason: "no driven leaf here" })),
      );
      const session = yield* Driven.session(at.view, at.props, at.drive).pipe(
        Effect.provideService(ActorTransport, transport),
        Effect.mapError((error) => Route.WireFailed.make({ reason: String(error) })),
      );
      return {
        resume: session.resume,
        patches: Stream.mapError(session.patches, (error) =>
          Route.WireFailed.make({ reason: error._tag }),
        ),
        send: (event) =>
          Effect.gen(function* () {
            log.sends.push(url.pathname);
            yield* Option.match(log.hold, { onNone: () => Effect.void, onSome: Deferred.await });
            yield* session.fire(event);
          }).pipe(
            Effect.onInterrupt(() => Effect.sync(() => void log.interrupted.push(url.pathname))),
          ),
      };
    }),
});

/** The page's own client half: `hydrate` over `#app`, with or without a wire. */
const hydratePage = (
  client: Context.Context<ActorTransport | QueryCache>,
  url: URL,
  routes: ReadonlyArray<AnyRoute<ActorTransport | QueryCache | Location>>,
  wire: Option.Option<Route.OpWireService>,
) =>
  Effect.gen(function* () {
    const root = yield* Effect.fromOption(Option.fromNullishOr(document.getElementById("app")));
    const location = yield* locationAt(url.href);
    return yield* hydrate({
      routes,
      notFound: NotFound,
      root,
      ...Option.match(wire, { onNone: () => ({}), onSome: (opened) => ({ wire: opened }) }),
    }).pipe(Effect.provideService(Location, location));
  }).pipe(Effect.orDie, Effect.provideContext(client));

/** Let every fiber that is ready run: nothing here waits on the clock. */
const settle = Effect.gen(function* () {
  for (let step = 0; step < 200; step += 1) {
    yield* Effect.yieldNow;
  }
});

const firstChunk = <R,>(routes: ReadonlyArray<AnyRoute<R>>, url: URL) =>
  Effect.flatMap(
    renderDocument({ routes, notFound: NotFound, url, document: frame, closeWhen: Effect.never }),
    (outcome) => {
      if (outcome._tag === "Rendered") {
        return Effect.map(Stream.runHead(outcome.body), Option.getOrThrow);
      }
      return Effect.die(`expected a document, got a redirect to ${outcome.location.href}`);
    },
  );

const wholeDocument = <R,>(routes: ReadonlyArray<AnyRoute<R>>, url: URL) =>
  Effect.flatMap(
    renderDocument({ routes, notFound: NotFound, url, document: frame, closeWhen: Effect.never }),
    (outcome) => {
      if (outcome._tag === "Rendered") {
        return Effect.map(Stream.runCollect(outcome.body), (chunks) => Array.from(chunks).join(""));
      }
      return Effect.die(`expected a document, got a redirect to ${outcome.location.href}`);
    },
  );

/** The flat form: one driven leaf, no layout, so its document closes at once. */
const flat = Route.driven("room", {
  path: "/room/:room",
  params: Schema.Struct({ room: Schema.String }),
  search: Route.search(Schema.Struct({})),
  drive: roomDrive,
  view: RoomView,
});

/** A view that reads the query cache: it can be drawn on the client only. */
const CachedTitle = (_params: { readonly room: string }) =>
  Effect.gen(function* () {
    yield* QueryCache;
    return <p>cached</p>;
  });

const countNode = () => Option.fromNullishOr(document.querySelector("[data-frame-driven] #count"));

describe("a driven route (#36)", () => {
  it.scopedLive(
    "the op wire opens only after the document closes, then adopts the drawn nodes",
    () =>
      Effect.gen(function* () {
        const title = yield* Deferred.make<void>();
        const host = yield* sharedHost(title);
        const transport = Context.get(host, ActorTransport);
        const server = yield* sideOver(transport);
        const writer = yield* ref(Room, "r1").pipe(Effect.provideContext(server));
        yield* writer.call({ _tag: "Add", amount: 2 }, { timeout: "1 second" });

        // Only the shell has arrived: the layout's query is still held.
        const url = new URL(`${origin}/rooms/r1`);
        const first = yield* firstChunk([app], url).pipe(Effect.provideContext(server));
        expect(first).toContain("data-frame-driven");
        yield* parsing;
        yield* install(first);
        const drawn = Option.getOrThrow(countNode());
        expect(drawn.textContent).toBe("2");

        // The page hydrates with a wire: `hydrate` holds it until the document is over.
        const log = wireLog();
        const client = yield* sideOver(transport);
        const { report } = yield* hydratePage(
          client,
          url,
          [app],
          Option.some(wireOver([app], transport, log)),
        );
        expect(report.mismatches).toEqual([]);
        expect(report.unclaimed).toBe(0);

        // The document is open: no wire, and the drawn nodes are untouched.
        yield* settle;
        expect(log.connects).toEqual([]);
        expect(Option.getOrThrow(countNode())).toBe(drawn);

        // The layout's patch lands; the document is still open.
        yield* Deferred.succeed(title, void 0);
        yield* append(lateRecord(idOf("title"), "Rooms"));
        yield* eventually("the layout's patch", () => textOf("#title") === "Rooms");
        yield* settle;
        expect(log.connects).toEqual([]);

        // The document closes: the wire opens, once, for the leaf's URL.
        yield* append({ _tag: "Closed", patched: [idOf("title")] });
        yield* eventually("the wire", () => log.connects.length === 1);
        expect(log.connects).toEqual(["/rooms/r1"]);

        // The wire adopted the document's nodes: nothing was drawn twice,
        // and the server's patches move the node the document drew.
        yield* writer.call({ _tag: "Add", amount: 10 }, { timeout: "1 second" });
        yield* eventually("the server's patch", () => drawn.textContent === "12");
        expect(document.querySelectorAll("#count").length).toBe(1);
        expect(Option.getOrThrow(countNode())).toBe(drawn);

        // The adopted button runs the server's handler.
        const button = Option.getOrThrow(
          Option.filter(
            Option.fromNullishOr(document.querySelector("[data-frame-driven] #add")),
            (found): found is HTMLElement => found instanceof HTMLElement,
          ),
        );
        button.click();
        yield* eventually("the handler's patch", () => drawn.textContent === "13");
        expect(log.connects).toEqual(["/rooms/r1"]);
      }),
    10_000,
  );

  it.scopedLive(
    "a flat driven route adopts its document, and a change of params follows the new drive",
    () =>
      Effect.gen(function* () {
        const host = yield* sharedHost(yield* Deferred.make<void>());
        const transport = Context.get(host, ActorTransport);
        const server = yield* sideOver(transport);
        const first = yield* ref(Room, "a").pipe(Effect.provideContext(server));
        const second = yield* ref(Room, "b").pipe(Effect.provideContext(server));
        yield* first.call({ _tag: "Add", amount: 1 }, { timeout: "1 second" });
        yield* second.call({ _tag: "Add", amount: 20 }, { timeout: "1 second" });

        const url = new URL(`${origin}/room/a`);
        const html = yield* wholeDocument([flat], url).pipe(Effect.provideContext(server));
        yield* install(html);
        const drawn = Option.getOrThrow(countNode());
        expect(drawn.textContent).toBe("1");

        const log = wireLog();
        const client = yield* sideOver(transport);
        const { router, report } = yield* hydratePage(
          client,
          url,
          [flat],
          Option.some(wireOver([flat], transport, log)),
        );
        expect(report.mismatches).toEqual([]);

        yield* eventually("the wire", () => log.connects.length === 1);
        yield* first.call({ _tag: "Add", amount: 1 }, { timeout: "1 second" });
        yield* eventually("the first drive's patch", () => drawn.textContent === "2");
        expect(Option.getOrThrow(countNode())).toBe(drawn);

        // New params name a new drive: the leaf follows it, over a new session.
        yield* router.navigate("/room/b");
        yield* eventually("the second drive", () =>
          Option.exists(countNode(), (node) => node.textContent === "20"),
        );
        expect(log.connects).toEqual(["/room/a", "/room/b"]);
        expect(document.querySelectorAll("#count").length).toBe(1);
        yield* second.call({ _tag: "Add", amount: 1 }, { timeout: "1 second" });
        yield* eventually("the second drive's patch", () =>
          Option.exists(countNode(), (node) => node.textContent === "21"),
        );

        // The button now sends to the second drive only: the first
        // connection's listeners left with it.
        const button = Option.getOrThrow(
          Option.filter(
            Option.fromNullishOr(document.querySelector("[data-frame-driven] #add")),
            (found): found is HTMLElement => found instanceof HTMLElement,
          ),
        );
        button.click();
        yield* eventually("the handler's patch", () =>
          Option.exists(countNode(), (node) => node.textContent === "22"),
        );
        yield* settle;
        expect(log.sends).toEqual(["/room/b"]);
        expect(yield* first.state.get).toBe(2);
      }),
    10_000,
  );

  it.scopedLive("a page with no op wire keeps each driven leaf as its document drew it", () =>
    Effect.gen(function* () {
      const host = yield* sharedHost(yield* Deferred.make<void>());
      const transport = Context.get(host, ActorTransport);
      const server = yield* sideOver(transport);
      const writer = yield* ref(Room, "s").pipe(Effect.provideContext(server));
      yield* writer.call({ _tag: "Add", amount: 5 }, { timeout: "1 second" });
      const url = new URL(`${origin}/room/s`);
      const html = yield* wholeDocument([flat], url).pipe(Effect.provideContext(server));
      yield* install(html);
      const drawn = Option.getOrThrow(countNode());

      const client = yield* sideOver(transport);
      const { report, resumed } = yield* hydratePage(client, url, [flat], Option.none());
      yield* resumed.closed;
      expect(report.mismatches).toEqual([]);
      yield* writer.call({ _tag: "Add", amount: 1 }, { timeout: "1 second" });
      yield* settle;
      expect(Option.getOrThrow(countNode())).toBe(drawn);
      expect(drawn.textContent).toBe("5");
    }),
  );
  it.scopedLive("a patch that moves an adopted node to the end moves it", () =>
    Effect.gen(function* () {
      const host = yield* sharedHost(yield* Deferred.make<void>());
      const transport = Context.get(host, ActorTransport);
      const server = yield* sideOver(transport);
      const url = new URL(`${origin}/lineup/l1`);
      const html = yield* wholeDocument([lineup], url).pipe(Effect.provideContext(server));
      yield* install(html);
      const items = () =>
        Array.from(document.querySelectorAll("#lineup li"), (li) => li.textContent);
      expect(items()).toEqual(["a", "b", "c"]);
      const first = Option.getOrThrow(Option.fromNullishOr(document.querySelector("#lineup li")));

      const log = wireLog();
      const client = yield* sideOver(transport);
      yield* hydratePage(client, url, [lineup], Option.some(wireOver([lineup], transport, log)));
      yield* eventually("the wire", () => log.connects.length === 1);

      // The server moves the first item to the end: the adopted node moves.
      const writer = yield* ref(Lineup, "l1").pipe(Effect.provideContext(server));
      yield* writer.call({ _tag: "Rotate" }, { timeout: "1 second" });
      yield* eventually("the move", () => items().join() === "b,c,a");
      expect(document.querySelectorAll("#lineup li")[2]).toBe(first);
    }),
  );

  it.scopedLive("a driven view's failure keeps its errored view through hydration", () =>
    Effect.gen(function* () {
      const host = yield* sharedHost(yield* Deferred.make<void>());
      const transport = Context.get(host, ActorTransport);
      const server = yield* sideOver(transport);
      const url = new URL(`${origin}/closed/c1`);
      const html = yield* wholeDocument([closed], url).pipe(Effect.provideContext(server));
      yield* install(html);
      expect(textOf("#closed")).toBe("closed");

      const client = yield* sideOver(transport);
      const { report, resumed } = yield* hydratePage(client, url, [closed], Option.none());
      yield* resumed.closed;
      yield* settle;
      expect(report.mismatches).toEqual([]);
      expect(textOf("#closed")).toBe("closed");
    }),
  );

  it.scopedLive(
    "a send still in flight when the leaf moves on is interrupted with its connection",
    () =>
      Effect.gen(function* () {
        const host = yield* sharedHost(yield* Deferred.make<void>());
        const transport = Context.get(host, ActorTransport);
        const server = yield* sideOver(transport);
        const first = yield* ref(Room, "h1").pipe(Effect.provideContext(server));
        const second = yield* ref(Room, "h2").pipe(Effect.provideContext(server));
        yield* first.call({ _tag: "Add", amount: 1 }, { timeout: "1 second" });
        yield* second.call({ _tag: "Add", amount: 30 }, { timeout: "1 second" });
        const url = new URL(`${origin}/room/h1`);
        const html = yield* wholeDocument([flat], url).pipe(Effect.provideContext(server));
        yield* install(html);
        const drawn = Option.getOrThrow(countNode());

        const log = wireLog();
        const client = yield* sideOver(transport);
        const { router } = yield* hydratePage(
          client,
          url,
          [flat],
          Option.some(wireOver([flat], transport, log)),
        );
        yield* eventually("the wire", () => log.connects.length === 1);
        yield* first.call({ _tag: "Add", amount: 1 }, { timeout: "1 second" });
        yield* eventually("the adoption", () => drawn.textContent === "2");

        // A click whose send is held on its way to the first session.
        const held = yield* Deferred.make<void>();
        log.hold = Option.some(held);
        const button = Option.getOrThrow(
          Option.filter(
            Option.fromNullishOr(document.querySelector("[data-frame-driven] #add")),
            (found): found is HTMLElement => found instanceof HTMLElement,
          ),
        );
        button.click();
        yield* eventually("the held send", () => log.sends.length === 1);

        // The leaf moves on: the first connection closes, and its send with it.
        yield* router.navigate("/room/h2");
        yield* eventually("the send's interruption", () => log.interrupted.length === 1);
        expect(log.interrupted).toEqual(["/room/h1"]);
        yield* Deferred.succeed(held, void 0);
        yield* eventually("the second drive", () =>
          Option.exists(countNode(), (node) => node.textContent === "30"),
        );
        yield* settle;
        expect(yield* first.state.get).toBe(2);
      }),
  );
});

describe("Route.driven forbids a client-only view (#18)", () => {
  it.effect("a driven tree whose leaf has a client view is refused when it is declared", () =>
    Effect.sync(() => {
      const clientLeaf = Route.leaf(roomSegment, (props) =>
        Effect.map(props.params.get, (params) => <p>{params.room}</p>),
      );
      expect(() =>
        Route.driven(
          "refused",
          Route.layout(shellSegment, [clientLeaf], (props) => props.outlet),
        ),
      ).toThrow(expect.objectContaining({ _tag: "BranchRejected", segment: "room" }));
      // A tree of driven leaves is accepted, and a layout may be any view.
      expect(
        Route.drivenAt([app], new URL(`${origin}/rooms/r9`)).pipe(Option.map((at) => at.drive.key)),
      ).toEqual(Option.some("r9"));
      expect(Route.drivenAt([app], new URL(`${origin}/elsewhere`))).toEqual(Option.none());
    }),
  );

  it.effect("sibling leaves that share a segment name each resolve to their own drive", () =>
    Effect.sync(() => {
      const shared = Route.segment("shared", { path: "/r", params: Schema.Struct({}) });
      const first = Route.child(shared, "item", {
        path: "a/:room",
        params: Schema.Struct({ room: Schema.String }),
      });
      const second = Route.child(shared, "item", {
        path: "b/:room",
        params: Schema.Struct({ room: Schema.String }),
      });
      const siblings = Route.driven(
        "siblings",
        Route.layout(
          shared,
          [
            Route.leaf(first, Route.drivenView({ drive: roomDrive, view: RoomView })),
            Route.leaf(
              second,
              Route.drivenView({
                drive: (params: { readonly room: string }) => ({
                  contract: Lineup,
                  key: params.room,
                }),
                view: LineupView,
              }),
            ),
          ],
          (props) => props.outlet,
        ),
      );
      const contractAt = (path: string) =>
        Route.drivenAt([siblings], new URL(`${origin}${path}`)).pipe(
          Option.map((at) => at.drive.contract.name),
        );
      expect(contractAt("/r/a/x")).toEqual(Option.some("DrivenRoom"));
      expect(contractAt("/r/b/x")).toEqual(Option.some("DrivenLineup"));
    }),
  );
});

// ---------------------------------------------------------------------------
// A client-only view does not compile (#18)
// ---------------------------------------------------------------------------

/** A view whose read can fail: its leaf names an `errored` view, as any leaf. */
const FailingRoom = (params: { readonly room: string }) =>
  Effect.map(ref(Room, params.room), () => <p>room</p>);

export const recovered = Route.leaf(
  roomSegment,
  Route.drivenView({ drive: roomDrive, view: FailingRoom }),
  { errored: () => <p>failed</p> },
);

// Negative fixtures below are TypeScript errors by design. The Effect language
// service reports the same mismatch separately, so it is paused for them only.
// @effect-diagnostics missingEffectContext:off
// @effect-diagnostics missingEffectError:off

// @ts-expect-error a driven view may need its drive's transport and its Scope only.
export const cachedView = Route.drivenView({ drive: roomDrive, view: CachedTitle });

export const cachedFlat = Route.driven("cached", {
  path: "/cached/:room",
  params: Schema.Struct({ room: Schema.String }),
  search: Route.search(Schema.Struct({})),
  drive: roomDrive,
  // @ts-expect-error the flat form refuses the same view.
  view: CachedTitle,
});

// @ts-expect-error a driven view that can fail needs its leaf's `errored` view.
export const unrecovered = Route.leaf(
  roomSegment,
  Route.drivenView({ drive: roomDrive, view: FailingRoom }),
);
