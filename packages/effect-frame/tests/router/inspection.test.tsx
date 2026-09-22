import { registerDom } from "./dom-setup.js";

registerDom();

import { Location, Route, UrlState, mount } from "effect-frame/router";
import type { AnyRoute, Entered, LocationService } from "effect-frame/router";
import type { Source } from "effect-frame/actor";
import { Dom, View, render } from "effect-frame/view";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  SchemaGetter,
  Scope,
  Stream,
} from "effect";
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

const DiagnosticRecord = Schema.Record(Schema.String, Frame.DiagnosticValue);

const containsDiagnosticReason = (value: Frame.DiagnosticValue, reason: string): boolean => {
  if (value._tag === "Truncated") {
    return value.reason === reason;
  }
  if (value._tag === "Opaque") {
    return false;
  }
  if (Array.isArray(value.value)) {
    return value.value.some((child) => containsDiagnosticReason(child, reason));
  }
  if (Schema.is(DiagnosticRecord)(value.value)) {
    return Object.values(value.value).some((child) => containsDiagnosticReason(child, reason));
  }
  return false;
};

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

  it.scoped.layer(Frame.layer({ name: "custom-route" }))(
    "does not execute arbitrary custom route inspection work",
    () =>
      Effect.gen(function* () {
        const custom: AnyRoute<never> = {
          name: "custom",
          searchKeys: { known: true, keys: [] },
          enter: () =>
            Option.some(
              Effect.succeed<Entered<never>>({
                setup: Effect.succeed(<p>custom</p>),
                update: () => Effect.succeed(true),
              }),
            ),
        };
        yield* makeStart("http://app.test/custom", [custom]);

        const route = routeNamed(yield* Frame.inspect, "custom");
        expect(route.params).toEqual({ _tag: "Opaque", reason: "unsupported-value" });
        expect(route.search).toEqual({ _tag: "Opaque", reason: "unsupported-value" });
      }),
  );

  it.scoped.layer(Frame.layer({ name: "navigation-resolution" }))(
    "retains the resolved navigation name without re-entering routes or codecs",
    () =>
      Effect.gen(function* () {
        let enterCalls = 0;
        let codecCalls = 0;
        const CountedParams = Route.PathRecord.pipe(
          Schema.decodeTo(Schema.Unknown, {
            decode: SchemaGetter.transform((record) => {
              codecCalls += 1;
              return record;
            }),
            encode: SchemaGetter.transform((): Route.PathRecord => ({ id: "1" })),
          }),
        );
        const base = Route.client("counted", {
          path: "/counted/:id",
          params: CountedParams,
          search: Route.search(Nothing),
          view: () => Effect.succeed(<p>counted</p>),
        });
        const counted: AnyRoute<never> = {
          ...base,
          enter: (url, navigation) => {
            enterCalls += 1;
            return base.enter(url, navigation);
          },
        };
        const { router } = yield* makeStart("http://app.test/counted/1", [counted]);
        const entered = { enterCalls, codecCalls };

        const first = yield* Frame.inspect;
        expect((yield* router.current.get).name).toBe("counted");
        const second = yield* Frame.inspect;

        expect(second.routes[0]?.canonicalRouteName).toBe("counted");
        expect(enterCalls).toBe(entered.enterCalls);
        expect(codecCalls).toBe(entered.codecCalls);
        expect(first.routes[0]?.routeInstanceId).toBe(second.routes[0]?.routeInstanceId);
      }),
  );

  it.scoped.layer(Frame.layer({ name: "diagnostic-bounds" }))(
    "bounds diagnostic keys and cost without invoking accessors",
    () =>
      Effect.gen(function* () {
        const longKey = "x".repeat(1_000);
        const longObject = { [longKey]: "small" };
        const nested = { count: 1 };
        type DeepNode = { next?: DeepNode };
        const deep: DeepNode = {};
        let deepCursor = deep;
        for (let index = 0; index < 10; index += 1) {
          const next: DeepNode = {};
          deepCursor["next"] = next;
          deepCursor = next;
        }
        let getterCalls = 0;
        const accessor = {};
        Object.defineProperty(accessor, "secret", {
          enumerable: true,
          get: () => {
            getterCalls += 1;
            return "should not be read";
          },
        });
        const wide = Object.fromEntries(
          Array.from({ length: 33 }, (_, index) => [`key-${index}`, "value"]),
        );
        const DiagnosticParams = Route.PathRecord.pipe(
          Schema.decodeTo(Schema.Unknown, {
            decode: SchemaGetter.transform(() => ({ longObject, nested, deep, accessor, wide })),
            encode: SchemaGetter.transform((): Route.PathRecord => ({ id: "1" })),
          }),
        );
        const diagnosticRoute = Route.client("bounds", {
          path: "/bounds/:id",
          params: DiagnosticParams,
          search: Route.search(Nothing),
          view: () => Effect.succeed(<p>bounds</p>),
        });
        yield* makeStart("http://app.test/bounds/1", [diagnosticRoute]);

        const first = yield* Frame.inspect;
        const firstParams = routeNamed(first, "bounds").params;
        expect(firstParams).toEqual({
          _tag: "Value",
          value: {
            longObject: { _tag: "Truncated", reason: "maximum-property-name-length" },
            nested: { _tag: "Value", value: { count: { _tag: "Value", value: 1 } } },
            deep: {
              _tag: "Value",
              value: {
                next: {
                  _tag: "Value",
                  value: {
                    next: {
                      _tag: "Value",
                      value: {
                        next: {
                          _tag: "Value",
                          value: {
                            next: {
                              _tag: "Value",
                              value: {
                                next: { _tag: "Truncated", reason: "maximum-depth" },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            accessor: { _tag: "Opaque", reason: "accessor" },
            wide: { _tag: "Truncated", reason: "maximum-entries" },
          },
        });
        expect(getterCalls).toBe(0);
        const encoded = yield* Effect.orDie(
          Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(firstParams),
        );
        expect(encoded.length).toBeLessThan(2_000);

        nested.count = 2;
        const second = yield* Frame.inspect;
        expect(firstParams).toEqual({
          _tag: "Value",
          value: {
            longObject: { _tag: "Truncated", reason: "maximum-property-name-length" },
            nested: { _tag: "Value", value: { count: { _tag: "Value", value: 1 } } },
            deep: {
              _tag: "Value",
              value: {
                next: {
                  _tag: "Value",
                  value: {
                    next: {
                      _tag: "Value",
                      value: {
                        next: {
                          _tag: "Value",
                          value: {
                            next: {
                              _tag: "Value",
                              value: {
                                next: { _tag: "Truncated", reason: "maximum-depth" },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            accessor: { _tag: "Opaque", reason: "accessor" },
            wide: { _tag: "Truncated", reason: "maximum-entries" },
          },
        });
        expect(routeNamed(second, "bounds").params).toEqual({
          _tag: "Value",
          value: {
            longObject: { _tag: "Truncated", reason: "maximum-property-name-length" },
            nested: { _tag: "Value", value: { count: { _tag: "Value", value: 2 } } },
            deep: {
              _tag: "Value",
              value: {
                next: {
                  _tag: "Value",
                  value: {
                    next: {
                      _tag: "Value",
                      value: {
                        next: {
                          _tag: "Value",
                          value: {
                            next: {
                              _tag: "Value",
                              value: {
                                next: { _tag: "Truncated", reason: "maximum-depth" },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            accessor: { _tag: "Opaque", reason: "accessor" },
            wide: { _tag: "Truncated", reason: "maximum-entries" },
          },
        });
      }),
  );

  it.scoped.layer(Frame.layer({ name: "diagnostic-reflection" }))(
    "turns unreadable record and array reflection into opaque values",
    () =>
      Effect.gen(function* () {
        const unreadable = (): never => Option.getOrThrow(Option.none());
        const unreadableRecord = new Proxy({}, { ownKeys: unreadable });
        const unreadableArray = new Proxy([], { getOwnPropertyDescriptor: unreadable });
        const paramsFor = <Value,>(value: Value) =>
          Route.PathRecord.pipe(
            Schema.decodeTo(Schema.Unknown, {
              decode: SchemaGetter.transform(() => value),
              encode: SchemaGetter.transform((): Route.PathRecord => ({ id: "1" })),
            }),
          );
        const recordRoute = Route.client("unreadable-record", {
          path: "/unreadable-record/:id",
          params: paramsFor(unreadableRecord),
          search: Route.search(Nothing),
          view: () => Effect.succeed(<p>record</p>),
        });
        const arrayRoute = Route.client("unreadable-array", {
          path: "/unreadable-array/:id",
          params: paramsFor(unreadableArray),
          search: Route.search(Nothing),
          view: () => Effect.succeed(<p>array</p>),
        });
        const { router } = yield* makeStart("http://app.test/unreadable-record/1", [
          recordRoute,
          arrayRoute,
        ]);

        let snapshot = yield* Frame.inspect;
        expect(routeNamed(snapshot, "unreadable-record").params).toEqual({
          _tag: "Opaque",
          reason: "unreadable-object",
        });

        yield* router.navigate("/unreadable-array/1");
        snapshot = yield* Frame.inspect;
        expect(routeNamed(snapshot, "unreadable-array").params).toEqual({
          _tag: "Opaque",
          reason: "unreadable-object",
        });
      }),
  );

  it.scoped.layer(Frame.layer({ name: "diagnostic-cost" }))(
    "truncates values that exhaust the aggregate diagnostic cost",
    () =>
      Effect.gen(function* () {
        const heavy = Object.fromEntries(
          Array.from({ length: 20 }, (_, index) => [`value-${index}`, "x".repeat(512)]),
        );
        const params = Route.PathRecord.pipe(
          Schema.decodeTo(Schema.Unknown, {
            decode: SchemaGetter.transform(() => ({ heavy })),
            encode: SchemaGetter.transform((): Route.PathRecord => ({ id: "1" })),
          }),
        );
        const route = Route.client("cost", {
          path: "/cost/:id",
          params,
          search: Route.search(Nothing),
          view: () => Effect.succeed(<p>cost</p>),
        });
        yield* makeStart("http://app.test/cost/1", [route]);

        const value = routeNamed(yield* Frame.inspect, "cost").params;
        expect(containsDiagnosticReason(value, "maximum-size")).toBe(true);
      }),
  );

  it.scoped.layer(Frame.layer({ name: "route-failure" }))(
    "closes route-owned setup resources after a failed route transition",
    () =>
      Effect.gen(function* () {
        let released = 0;
        const old = Route.client("old", {
          path: "/old",
          params: Nothing,
          search: Route.search(Nothing),
          view: () => Effect.succeed(<p>old</p>),
        });
        const bad: AnyRoute<never> = {
          name: "bad",
          searchKeys: { known: true, keys: [] },
          enter: () =>
            Option.some(
              Effect.acquireRelease(
                Effect.succeed<Entered<never>>({
                  setup: Effect.die("bad route setup"),
                  update: () => Effect.succeed(true),
                }),
                () => Effect.sync(() => void (released += 1)),
              ),
            ),
        };
        const { router } = yield* makeStart("http://app.test/old", [old, bad]);
        const failed = yield* Effect.exit(router.navigate("/bad"));
        expect(Exit.isFailure(failed)).toBe(true);
        expect(released).toBe(1);
        expect((yield* Frame.inspect).routes.map((route) => route.routeName)).toEqual(["old"]);
        yield* router.navigate("/old");
        expect((yield* router.current.get).name).toBe("old");
        expect((yield* Frame.inspect).routes.map((route) => route.routeName)).toEqual(["old"]);
      }),
  );

  it.scoped.layer(Frame.layer({ name: "route-interruption" }))(
    "closes route-owned resources when mount setup is interrupted",
    () =>
      Effect.gen(function* () {
        const parent = yield* Scope.make();
        const started = yield* Deferred.make<void>();
        const hold = yield* Deferred.make<void>();
        let released = 0;
        const blocked: AnyRoute<never> = {
          name: "blocked",
          searchKeys: { known: true, keys: [] },
          enter: () =>
            Option.some(
              Effect.gen(function* () {
                yield* Effect.acquireRelease(Effect.void, (_value, _exit) =>
                  Effect.sync(() => {
                    released += 1;
                  }),
                );
                yield* Deferred.succeed(started, void 0);
                yield* Deferred.await(hold);
                return yield* Effect.succeed<Entered<never>>({
                  setup: Effect.succeed(<p>blocked</p>),
                  update: () => Effect.succeed(true),
                });
              }),
            ),
        };
        const location = yield* makeLocation("http://app.test/blocked");
        const mounting = yield* Effect.forkChild(
          mount({
            routes: [blocked],
            notFound: NotFound,
            host: Dom.host,
            root: document.createElement("main"),
          }).pipe(Effect.provideService(Location, location.service), Scope.provide(parent)),
        );
        yield* Deferred.await(started);
        yield* Fiber.interrupt(mounting);

        expect(released).toBe(1);
        expect((yield* Frame.inspect).routes).toHaveLength(0);
        yield* Scope.close(parent, Exit.void);
        expect(released).toBe(1);
      }),
  );

  it.scoped.layer(Frame.layer({ name: "route-lifetime" }))(
    "releases route-owned resources when the route exits",
    () =>
      Effect.gen(function* () {
        let released = 0;
        const old = Route.client("old-lifetime", {
          path: "/old-lifetime",
          params: Nothing,
          search: Route.search(Nothing),
          view: () => Effect.succeed(<p>old</p>),
        });
        const owned: AnyRoute<never> = {
          name: "owned",
          searchKeys: { known: true, keys: [] },
          enter: () =>
            Option.some(
              Effect.acquireRelease(
                Effect.succeed<Entered<never>>({
                  setup: Effect.succeed(<p>owned</p>),
                  update: () => Effect.succeed(true),
                }),
                (_value, _exit) =>
                  Effect.sync(() => {
                    released += 1;
                  }),
              ),
            ),
        };
        const { router } = yield* makeStart("http://app.test/old-lifetime", [old, owned]);
        yield* router.navigate("/owned");
        expect(released).toBe(0);
        yield* router.navigate("/old-lifetime");
        expect(released).toBe(1);
      }),
  );

  it.scoped("keeps identical route names independent after one root closes", () =>
    Effect.gen(function* () {
      const route = Route.client("same-route", {
        path: "/same",
        params: Nothing,
        search: Route.search(Nothing),
        view: () => Effect.succeed(<p id="same-route">same</p>),
      });
      const openRoot = Effect.gen(function* () {
        const rootScope = yield* Scope.make();
        const context = yield* Scope.provide(
          Layer.build(Frame.layer({ name: "same-route-root" })),
          rootScope,
        );
        const location = yield* makeLocation("http://app.test/same");
        const router = yield* Effect.provideContext(
          mount({
            routes: [route],
            notFound: NotFound,
            host: Dom.host,
            root: document.createElement("main"),
          }).pipe(Effect.provideService(Location, location.service), Scope.provide(rootScope)),
          context,
        );
        return { context, rootScope, router };
      });

      const first = yield* openRoot;
      const second = yield* openRoot;
      const firstSnapshot = yield* Effect.provideContext(Frame.inspect, first.context);
      const secondSnapshot = yield* Effect.provideContext(Frame.inspect, second.context);
      expect(firstSnapshot.root.name).toBe("same-route-root");
      expect(secondSnapshot.root.name).toBe("same-route-root");
      expect(firstSnapshot.root.id).not.toBe(secondSnapshot.root.id);
      expect(firstSnapshot.routes[0]?.routeName).toBe("same-route");
      expect(secondSnapshot.routes[0]?.routeName).toBe("same-route");
      expect(firstSnapshot.routes[0]?.id).not.toBe(secondSnapshot.routes[0]?.id);

      yield* Scope.close(first.rootScope, Exit.void);
      const secondAfterClose = yield* Effect.provideContext(Frame.inspect, second.context);
      expect(secondAfterClose.root.id).toBe(secondSnapshot.root.id);
      expect(secondAfterClose.routes).toHaveLength(1);
      expect(secondAfterClose.routes[0]?.routeName).toBe("same-route");

      yield* Scope.close(second.rootScope, Exit.void);
    }),
  );
});
