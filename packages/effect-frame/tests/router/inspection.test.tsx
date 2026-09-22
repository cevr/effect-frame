import { registerDom } from "./dom-setup.js";

registerDom();

import { Location, Route, UrlState, mount } from "effect-frame/router";
import type { LocationService } from "effect-frame/router";
import type { Source } from "effect-frame/actor";
import { Dom, View, render } from "effect-frame/view";
import { Deferred, Effect, Fiber, Option, Queue, Ref, Schema, SchemaGetter, Stream } from "effect";
import { describe, expect, it } from "effect-bun-test";
import * as Frame from "../../src/frame.js";

interface FakeLocation {
  readonly service: LocationService;
  readonly history: Array<string>;
  readonly pop: (href: string) => Effect.Effect<void>;
}

const makeLocation = (initial: string): Effect.Effect<FakeLocation> =>
  Effect.gen(function* () {
    const current = yield* Ref.make(new URL(initial));
    const pops = yield* Queue.unbounded<URL>();
    const history: Array<string> = [];
    return {
      service: {
        current: Ref.get(current),
        push: (url) =>
          Effect.andThen(
            Ref.set(current, url),
            Effect.sync(() => {
              history.push(`push ${url.pathname}${url.search}`);
            }),
          ),
        replace: (url) =>
          Effect.andThen(
            Ref.set(current, url),
            Effect.sync(() => {
              history.push(`replace ${url.pathname}${url.search}`);
            }),
          ),
        pops: Stream.fromQueue(pops),
      },
      history,
      pop: (href) =>
        Effect.gen(function* () {
          const url = new URL(href, initial);
          yield* Ref.set(current, url);
          yield* Queue.offer(pops, url);
        }),
    };
  });

const Nothing = Schema.Struct({});
const BookParams = Schema.Struct({ id: Schema.String });
const BookSearch = Route.search(
  Schema.Struct({ tab: Schema.String.pipe(Route.withDefault("all")) }),
);
const FilterSearch = Route.search(
  Schema.Struct({ filter: Schema.String.pipe(Route.withDefault("")) }),
);
type FilterState = (typeof FilterSearch)["Type"];

class CustomValue {
  readonly label = "custom";
}

interface CycleValue {
  self?: CycleValue;
}

const WeirdParams = Route.PathRecord.pipe(
  Schema.decodeTo(Schema.Unknown, {
    decode: SchemaGetter.transform(() => {
      const cycle: CycleValue = {};
      cycle["self"] = cycle;
      return {
        // oxlint-disable-next-line effect/noGlobals -- diagnostic test needs Date input
        date: new Date(0),
        custom: new CustomValue(),
        cycle,
      };
    }),
    encode: SchemaGetter.transform((): Route.PathRecord => ({ id: "1" })),
  }),
);

const NotFound = (props: { readonly url: Source<URL> }) =>
  Effect.succeed(<p id="missing">{View.bind(props.url, (url) => url.pathname)}</p>);

const makeBook = (ready: Deferred.Deferred<UrlState.State<FilterState>>) =>
  Route.client("book", {
    path: "/books/:id",
    params: BookParams,
    search: BookSearch,
    view: (_props) =>
      Effect.gen(function* () {
        const state = yield* UrlState.make(FilterSearch);
        yield* Deferred.succeed(ready, state);
        return <p id="book">{View.bind(state.state, (value) => value.filter)}</p>;
      }),
  });

const makeStart = <R,>(initial: string, routes: ReadonlyArray<Route.AnyRoute<R>>) =>
  Effect.gen(function* () {
    const root = document.createElement("main");
    const location = yield* makeLocation(initial);
    const router = yield* mount({
      routes,
      notFound: NotFound,
      host: Dom.host,
      root,
    }).pipe(Effect.provideService(Location, location.service));
    return { root, location, router };
  });

const routeNamed = (snapshot: Frame.Snapshot, name: string) =>
  Option.getOrThrow(
    Option.fromNullishOr(snapshot.routes.find((route) => route.routeName === name)),
  );

const urlStateFor = (snapshot: Frame.Snapshot, key: string) =>
  Option.getOrThrow(
    Option.fromNullishOr(snapshot.urlStates.find((state) => state.keys.includes(key))),
  );

describe("Frame router inspection", () => {
  it.scoped.layer(Frame.layer({ name: "router" }))(
    "samples mounted routes and URL state from live framework memory",
    () =>
      Effect.gen(function* () {
        const ready = yield* Deferred.make<UrlState.State<FilterState>>();
        const { location, router } = yield* makeStart(
          "http://app.test/books/7?tab=one&filter=first",
          [makeBook(ready)],
        );
        const state = yield* Deferred.await(ready);

        const initial = yield* Frame.inspect;
        expect(initial.root.name).toBe("router");
        expect(initial.mounts).toHaveLength(1);
        expect(initial.mounts[0]?.phase).toBe("mounted");
        expect(initial.routes).toHaveLength(1);
        expect(initial.urlStates).toHaveLength(1);
        const initialRoute = routeNamed(initial, "book");
        expect(initialRoute.phase).toBe("mounted");
        expect(initialRoute.params).toEqual({
          _tag: "Value",
          value: { id: { _tag: "Value", value: "7" } },
        });
        expect(initialRoute.search).toEqual({
          _tag: "Value",
          value: { tab: { _tag: "Value", value: "one" } },
        });
        expect(initialRoute.canonicalRouteName).toBe("book");
        expect(initialRoute.canonicalUrl).toBe("http://app.test/books/7?tab=one&filter=first");
        const initialState = urlStateFor(initial, "filter");
        expect(initialState.keys).toEqual(["filter"]);
        expect(initialState.value).toEqual({
          _tag: "Value",
          value: { filter: { _tag: "Value", value: "first" } },
        });

        yield* router.navigate("/books/8?tab=two&filter=second");
        yield* render;
        const moved = yield* Frame.inspect;
        const movedRoute = routeNamed(moved, "book");
        expect(movedRoute.routeInstanceId).toBe(initialRoute.routeInstanceId);
        expect(movedRoute.params).toEqual({
          _tag: "Value",
          value: { id: { _tag: "Value", value: "8" } },
        });
        expect(movedRoute.search).toEqual({
          _tag: "Value",
          value: { tab: { _tag: "Value", value: "two" } },
        });
        expect(movedRoute.canonicalUrl).toBe("http://app.test/books/8?tab=two&filter=second");
        expect(urlStateFor(moved, "filter").value).toEqual({
          _tag: "Value",
          value: { filter: { _tag: "Value", value: "second" } },
        });
        expect(initialRoute.canonicalUrl).toBe("http://app.test/books/7?tab=one&filter=first");

        yield* state.set({ filter: "replaced" });
        yield* state.push.update((previous) => ({ filter: `${previous.filter}-pushed` }));
        yield* location.pop("/books/8?tab=back&filter=back");
        yield* render;
        const back = yield* Frame.inspect;
        expect(routeNamed(back, "book").search).toEqual({
          _tag: "Value",
          value: { tab: { _tag: "Value", value: "back" } },
        });
        expect(urlStateFor(back, "filter").value).toEqual({
          _tag: "Value",
          value: { filter: { _tag: "Value", value: "back" } },
        });
        expect(location.history).toEqual([
          "push /books/8?tab=two&filter=second",
          "replace /books/8?tab=two&filter=replaced",
          "push /books/8?tab=two&filter=replaced-pushed",
        ]);

        yield* router.navigate("/missing");
        const missing = yield* Frame.inspect;
        expect(missing.urlStates).toHaveLength(0);
        expect(missing.mounts).toHaveLength(1);
        expect(missing.routes).toHaveLength(1);
        expect(routeNamed(missing, "not-found").phase).toBe("mounted");
      }),
  );

  it.scoped.layer(Frame.layer({ name: "entering" }))(
    "keeps the old route while a new route setup is blocked",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const old = Route.client("old", {
          path: "/old",
          params: Nothing,
          search: Route.search(Nothing),
          view: () => Effect.succeed(<p id="old">old</p>),
        });
        const slow = Route.client("slow", {
          path: "/slow",
          params: Nothing,
          search: Route.search(Nothing),
          view: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, void 0);
              yield* Deferred.await(release);
              return <p id="slow">slow</p>;
            }),
        });
        const { router } = yield* makeStart("http://app.test/old", [old, slow]);
        const moving = yield* Effect.forkScoped(router.navigate("/slow"));
        yield* Deferred.await(started);

        const entering = yield* Frame.inspect;
        expect(entering.routes).toHaveLength(2);
        const oldRoute = routeNamed(entering, "old");
        const slowRoute = routeNamed(entering, "slow");
        expect(oldRoute.phase).toBe("mounted");
        expect(slowRoute.phase).toBe("entering");
        expect(oldRoute.ownerId).not.toBe(slowRoute.ownerId);
        expect(oldRoute.canonicalRouteName).toBe("slow");
        expect(entering.mounts).toHaveLength(2);
        expect(entering.mounts.some((mountRecord) => mountRecord.phase === "entering")).toBe(true);
        expect(entering.mounts.some((mountRecord) => mountRecord.phase === "mounted")).toBe(true);

        yield* Deferred.succeed(release, void 0);
        yield* Fiber.join(moving);
        const complete = yield* Frame.inspect;
        expect(complete.routes).toHaveLength(1);
        expect(routeNamed(complete, "slow").phase).toBe("mounted");
        expect(complete.mounts).toHaveLength(1);
        expect(complete.mounts[0]?.phase).toBe("mounted");
      }),
  );

  it.scoped.layer(Frame.layer({ name: "diagnostics" }))(
    "keeps unsupported route values explicit and bounded",
    () =>
      Effect.gen(function* () {
        const weird = Route.client("weird", {
          path: "/weird/:id",
          params: WeirdParams,
          search: Route.search(Nothing),
          view: () => Effect.succeed(<p>weird</p>),
        });
        yield* makeStart("http://app.test/weird/1", [weird]);
        const route = routeNamed(yield* Frame.inspect, "weird");
        expect(route.params).toEqual({
          _tag: "Value",
          value: {
            date: { _tag: "Opaque", reason: "unsupported-object" },
            custom: { _tag: "Opaque", reason: "unsupported-object" },
            cycle: {
              _tag: "Value",
              value: { self: { _tag: "Opaque", reason: "cycle" } },
            },
          },
        });
      }),
  );
});
