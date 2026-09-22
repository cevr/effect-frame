import { registerDom } from "./dom-setup.js";

registerDom();

import { Location, Route, Router, UrlState, link, mount } from "effect-frame/router";
import type { LocationService } from "effect-frame/router";
import { Behavior, Value, spawn } from "effect-frame/actor";
import type { Source } from "effect-frame/actor";
import { Dom, View, render } from "effect-frame/view";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Queue,
  Ref,
  Schema,
  SchemaGetter,
  Stream,
} from "effect";
import { describe, expect, it } from "effect-bun-test";

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
const CountSearch = Route.search(
  Schema.Struct({ count: Schema.FiniteFromString.pipe(Route.withDefault(0)) }).pipe(
    Schema.encodeKeys({ count: "c" }),
  ),
);
const PaneSearch = Route.search(
  Schema.Struct({ pane: Schema.String.pipe(Route.withDefault("")) }).pipe(
    Schema.encodeKeys({ pane: "p" }),
  ),
);
const PageSearch = Route.search(
  Schema.Struct({ page: Schema.String.pipe(Route.withDefault("home")) }),
);
const ViewSearch = Route.search(Schema.Struct({ view: Schema.String.pipe(Route.withDefault("")) }));
const OpaqueRouteSearch = Route.SearchRecord.pipe(
  Schema.decodeTo(Schema.Struct({ route: Schema.String.pipe(Route.withDefault("")) }), {
    decode: SchemaGetter.transform((record) => ({
      route: Option.getOrElse(
        Option.flatMap(Option.fromNullishOr(record["route"]), (values) =>
          Option.fromNullishOr(values[0]),
        ),
        () => "",
      ),
    })),
    encode: SchemaGetter.transform((value): Route.SearchRecord => ({
      route: [value.route ?? ""],
      view: ["OVERWRITTEN"],
    })),
  }),
);
const Workspace = Route.SearchRecord.pipe(
  Schema.decodeTo(Schema.Struct({ panes: Schema.Array(Schema.String) }), {
    decode: SchemaGetter.transform((record) => ({
      panes: Option.getOrElse(Option.fromNullishOr(record["workspace"]), () => []),
    })),
    encode: SchemaGetter.transform((value): Route.SearchRecord => ({
      workspace: [...value.panes],
    })),
  }),
);

const WorkspaceWithFilters = Route.SearchRecord.pipe(
  Schema.decodeTo(
    Schema.Struct({
      panes: Schema.Array(Schema.Struct({ q: Schema.String, filters: Schema.String })),
    }),
    {
      decode: SchemaGetter.transform((record) => ({
        panes: [0, 1].map((index) => {
          const suffix = suffixOf(index);
          return {
            q: Option.getOrElse(
              Option.flatMap(Option.fromNullishOr(record[`q${suffix}`]), (values) =>
                Option.fromNullishOr(values[0]),
              ),
              () => "",
            ),
            filters: Option.getOrElse(
              Option.flatMap(Option.fromNullishOr(record[`filters${suffix}`]), (values) =>
                Option.fromNullishOr(values[0]),
              ),
              () => "",
            ),
          };
        }),
      })),
      encode: SchemaGetter.transform((value): Route.SearchRecord => {
        const encoded: Record<string, Array<string>> = {};
        for (const [index, pane] of value.panes.entries()) {
          const suffix = suffixOf(index);
          encoded[`q${suffix}`] = [pane.q];
          encoded[`filters${suffix}`] = [pane.filters];
        }
        return encoded;
      }),
    },
  ),
);

const suffixOf = (index: number): string => {
  if (index === 0) {
    return "";
  }
  return "2";
};

let counterState: Option.Option<UrlState.State<(typeof CountSearch)["Type"]>> = Option.none();
let paneState: Option.Option<UrlState.State<(typeof PaneSearch)["Type"]>> = Option.none();
let workspaceWithFiltersState: Option.Option<
  UrlState.State<(typeof WorkspaceWithFilters)["Type"]>
> = Option.none();
let workspaceWrongKeysState: Option.Option<UrlState.State<(typeof Workspace)["Type"]>> =
  Option.none();
let routeSearchProps: Option.Option<Route.RouteProps<{}, (typeof PageSearch)["Type"]>> =
  Option.none();
let opaqueRouteReplace: Option.Option<
  Route.RouteProps<{}, (typeof OpaqueRouteSearch)["Type"]>["replaceSearch"]
> = Option.none();
let reusableItems: Option.Option<(items: ReadonlyArray<string>) => Effect.Effect<void>> =
  Option.none();
const Counter = (_props: Route.RouteProps<{}, {}>) =>
  Effect.gen(function* () {
    const state = yield* UrlState.make(CountSearch);
    counterState = Option.some(state);
    return <p id="counter">{View.bind(state.state, (value) => String(value.count))}</p>;
  });

const counter = Route.client("counter", {
  path: "/counter",
  params: Nothing,
  search: Nothing,
  view: Counter,
});

const Dual = (_props: Route.RouteProps<{}, {}>) =>
  Effect.gen(function* () {
    const count = yield* UrlState.make(CountSearch);
    const pane = yield* UrlState.make(PaneSearch);
    counterState = Option.some(count);
    paneState = Option.some(pane);
    return (
      <section id="dual">
        <p id="dual-count">{View.bind(count.state, (value) => String(value.count))}</p>
        <p id="dual-pane">{View.bind(pane.state, (value) => value.pane)}</p>
      </section>
    );
  });

const dual = Route.client("dual", {
  path: "/dual",
  params: Nothing,
  search: Nothing,
  view: Dual,
});

const WorkspaceWrongKeysState = (_props: Route.RouteProps<{}, {}>) =>
  Effect.gen(function* () {
    workspaceWrongKeysState = Option.some(yield* UrlState.make(Workspace, { keys: ["wrong"] }));
    return <span />;
  });

const workspaceWrongKeys = Route.client("workspace-wrong-keys", {
  path: "/workspace-wrong-keys",
  params: Nothing,
  search: Nothing,
  view: WorkspaceWrongKeysState,
});

const WorkspaceWithFiltersState = (_props: Route.RouteProps<{}, {}>) =>
  Effect.gen(function* () {
    const state = yield* UrlState.make(WorkspaceWithFilters, {
      keys: ["filters2", "q2", "filters", "q"],
    });
    workspaceWithFiltersState = Option.some(state);
    return <span />;
  });

const workspaceWithFiltersStateRoute = Route.client("workspace-with-filters-state", {
  path: "/workspace-with-filters-state",
  params: Nothing,
  search: Nothing,
  view: WorkspaceWithFiltersState,
});

const collisionView = (_props: Route.RouteProps<{}, {}>) =>
  Effect.gen(function* () {
    yield* UrlState.make(CountSearch);
    yield* UrlState.make(CountSearch);
    return <span />;
  });

const collision = Route.client("collision", {
  path: "/collision",
  params: Nothing,
  search: Nothing,
  view: collisionView,
});

const routeCollisionView = (props: Route.RouteProps<{}, (typeof CountSearch)["Type"]>) =>
  Effect.gen(function* () {
    yield* UrlState.make(CountSearch);
    return <span>{View.bind(props.search, (value) => String(value.count))}</span>;
  });

const routeCollision = Route.client("route-collision", {
  path: "/route-collision",
  params: Nothing,
  search: CountSearch,
  view: routeCollisionView,
});

const Other = (_props: Route.RouteProps<{}, {}>) =>
  Effect.gen(function* () {
    const state = yield* UrlState.make(CountSearch);
    return <p id="other">{View.bind(state.state, (value) => String(value.count))}</p>;
  });

const other = Route.client("other", {
  path: "/other",
  params: Nothing,
  search: Nothing,
  view: Other,
});

const RouteAndViewState = (props: Route.RouteProps<{}, (typeof PageSearch)["Type"]>) =>
  Effect.gen(function* () {
    routeSearchProps = Option.some(props);
    const state = yield* UrlState.make(CountSearch);
    counterState = Option.some(state);
    return (
      <section id="route-and-view">
        <p id="route-page">{View.bind(props.search, (value) => value.page)}</p>
        <p id="route-count">{View.bind(state.state, (value) => String(value.count))}</p>
      </section>
    );
  });

const routeAndView = Route.client("route-and-view", {
  path: "/route-and-view",
  params: Nothing,
  search: PageSearch,
  view: RouteAndViewState,
});

const OpaqueRouteView = (props: Route.RouteProps<{}, (typeof OpaqueRouteSearch)["Type"]>) =>
  Effect.gen(function* () {
    opaqueRouteReplace = Option.some(props.replaceSearch);
    yield* UrlState.make(ViewSearch);
    return <span id="opaque-route">{View.bind(props.search, (value) => value.route)}</span>;
  });

const opaqueRoute = Route.client("opaque-route", {
  path: "/opaque-route",
  params: Nothing,
  search: OpaqueRouteSearch,
  searchKeys: ["route"],
  view: OpaqueRouteView,
});

const ReusableClaims = (_props: Route.RouteProps<{}, {}>) =>
  Effect.gen(function* () {
    const items = yield* spawn(Behavior.value<ReadonlyArray<string>>(["first"]));
    reusableItems = Option.some((next) =>
      Effect.asVoid(
        Effect.catchTag(items.call(Value.Set(next)), "ActorStopped", () => Effect.void),
      ),
    );
    const rows = yield* View.list({
      each: items.state,
      keyBy: (item) => item,
      row: (_item) =>
        Effect.gen(function* () {
          const state = yield* UrlState.make(PaneSearch);
          return <span>{View.bind(state.state, (value) => value.pane)}</span>;
        }),
    });
    return <section id="reusable-claims">{rows}</section>;
  });

const reusableClaims = Route.client("reusable-claims", {
  path: "/reusable-claims",
  params: Nothing,
  search: Nothing,
  view: ReusableClaims,
});

const InterruptedClaim = (_props: Route.RouteProps<{}, {}>) =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<void>();
    const fiber = yield* Effect.forkScoped(
      Effect.scoped(
        Effect.gen(function* () {
          yield* UrlState.make(PaneSearch);
          yield* Deferred.succeed(ready, void 0);
          return yield* Effect.never;
        }),
      ),
    );
    yield* Deferred.await(ready);
    yield* Fiber.interrupt(fiber);
    yield* UrlState.make(PaneSearch);
    return <span id="interrupted-claim">ok</span>;
  });

const interruptedClaim = Route.client("interrupted-claim", {
  path: "/interrupted-claim",
  params: Nothing,
  search: Nothing,
  view: InterruptedClaim,
});

const RequiredSearch = Route.search(Schema.Struct({ mode: Schema.Literals(["a", "b"]) }));
const requiredView = (_props: Route.RouteProps<{}, {}>) =>
  Effect.gen(function* () {
    yield* UrlState.make(RequiredSearch);
    return <span />;
  });
const required = Route.client("required", {
  path: "/required",
  params: Nothing,
  search: Nothing,
  view: requiredView,
});

const MissingOpaqueKeys = (_props: Route.RouteProps<{}, {}>) =>
  Effect.gen(function* () {
    yield* UrlState.make(Workspace);
    return <span />;
  });

const missingOpaqueKeys = Route.client("missing-opaque-keys", {
  path: "/missing-opaque-keys",
  params: Nothing,
  search: Nothing,
  view: MissingOpaqueKeys,
});

const NotFound = (props: { readonly url: Source<URL> }) =>
  Effect.succeed(<p id="missing">{View.bind(props.url, (url) => url.pathname)}</p>);

const startWith = <R,>(initial: string, routes: ReadonlyArray<Route.AnyRoute<R>>) =>
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

const start = (initial: string) => startWith(initial, [counter]);

describe("UrlState", () => {
  it.scoped("derives from the URL and replaces by default", () =>
    Effect.gen(function* () {
      const { root, location } = yield* start("http://app.test/counter");
      expect(root.querySelector("#counter")?.textContent).toBe("0");
      const state = Option.getOrThrow(counterState);
      yield* state.set({ count: 2 });
      yield* render;
      expect(root.querySelector("#counter")?.textContent).toBe("2");
      expect(location.history).toEqual(["replace /counter?c=2"]);
    }),
  );

  it.scoped("push operations create history entries and updates read the latest URL", () =>
    Effect.gen(function* () {
      const { location } = yield* start("http://app.test/counter?c=1");
      const state = Option.getOrThrow(counterState);
      yield* Effect.all(
        [
          state.push.update((previous) => ({ count: previous.count + 1 })),
          state.push.update((previous) => ({ count: previous.count + 1 })),
        ],
        { concurrency: "unbounded" },
      );
      expect(location.history).toEqual(["push /counter?c=2", "push /counter?c=3"]);
    }),
  );

  it.scoped("preserves unrelated route and view keys", () =>
    Effect.gen(function* () {
      const { location } = yield* start("http://app.test/counter?other=x&c=1&tail=y");
      const state = Option.getOrThrow(counterState);
      yield* state.set({ count: 2 });
      expect(location.history).toEqual(["replace /counter?other=x&c=2&tail=y"]);
    }),
  );

  it.scoped("uses the omitted value for malformed raw values", () =>
    Effect.gen(function* () {
      const { root, location } = yield* start("http://app.test/counter?c=oops");
      expect(root.querySelector("#counter")?.textContent).toBe("0");
      const state = Option.getOrThrow(counterState);
      yield* state.update((previous) => ({ count: previous.count + 1 }));
      expect(location.history).toEqual(["replace /counter?c=1"]);
    }),
  );

  it.scoped("preserves the URL hash while replacing owned keys", () =>
    Effect.gen(function* () {
      const { router } = yield* start("http://app.test/counter?c=1#focus");
      const state = Option.getOrThrow(counterState);
      yield* state.set({ count: 2 });
      expect((yield* router.current.get).url.href).toBe("http://app.test/counter?c=2#focus");
    }),
  );

  it.scoped("keeps the source valid after a malformed pop", () =>
    Effect.gen(function* () {
      const { root, location } = yield* start("http://app.test/counter?c=1");
      yield* location.pop("/counter?c=oops");
      yield* render;
      expect(root.querySelector("#counter")?.textContent).toBe("0");
    }),
  );

  it.scoped("serializes concurrent owners against one canonical URL", () =>
    Effect.gen(function* () {
      const { root, location } = yield* startWith("http://app.test/dual?c=0&p=", [dual]);
      const count = Option.getOrThrow(counterState);
      const pane = Option.getOrThrow(paneState);
      const before = root.querySelector("#dual");
      yield* Effect.all(
        [
          count.update((previous) => ({ count: previous.count + 1 })),
          pane.update((previous) => ({ pane: `${previous.pane}x` })),
        ],
        { concurrency: "unbounded" },
      );
      yield* render;
      expect(root.querySelector("#dual")).toBe(before);
      expect(root.querySelector("#dual-count")?.textContent).toBe("1");
      expect(root.querySelector("#dual-pane")?.textContent).toBe("x");
      expect(location.history).toEqual(["replace /dual?c=1&p=", "replace /dual?c=1&p=x"]);
    }),
  );

  it.scoped("route search updates preserve view state and its later canonical update", () =>
    Effect.gen(function* () {
      const { root, location, router } = yield* startWith(
        "http://app.test/route-and-view?page=one&c=1&unknown=x",
        [routeAndView],
      );
      const before = root.querySelector("#route-and-view");
      const props = Option.getOrThrow(routeSearchProps);
      const state = Option.getOrThrow(counterState);
      const typed = yield* link(routeAndView, {}, (previous) => ({
        page: `${previous.page}-link`,
      })).pipe(Effect.provideService(Router, router));
      expect(yield* typed.href.get).toBe("/route-and-view?page=one-link&c=1&unknown=x");
      yield* typed.go;
      yield* render;
      expect(location.history).toEqual(["push /route-and-view?page=one-link&c=1&unknown=x"]);
      yield* props.updateSearch((previous) => ({ page: `${previous.page}-next` }));
      yield* render;
      expect(root.querySelector("#route-and-view")).toBe(before);
      expect(root.querySelector("#route-page")?.textContent).toBe("one-link-next");
      expect(root.querySelector("#route-count")?.textContent).toBe("1");
      expect(location.history).toEqual([
        "push /route-and-view?page=one-link&c=1&unknown=x",
        "push /route-and-view?page=one-link-next&c=1&unknown=x",
      ]);
      yield* state.update((previous) => ({ count: previous.count + 1 }));
      expect(location.history).toEqual([
        "push /route-and-view?page=one-link&c=1&unknown=x",
        "push /route-and-view?page=one-link-next&c=1&unknown=x",
        "replace /route-and-view?page=one-link-next&c=2&unknown=x",
      ]);
    }),
  );

  it.scoped("rejects undeclared route keys before route mutation writes history", () =>
    Effect.gen(function* () {
      const { location, router } = yield* startWith(
        "http://app.test/opaque-route?route=SAFE&view=SAFE",
        [opaqueRoute],
      );
      const replace = Option.getOrThrow(opaqueRouteReplace);
      const typed = yield* link(opaqueRoute, {}, { route: "next" }).pipe(
        Effect.provideService(Router, router),
      );
      const replaceResult = yield* Effect.exit(replace(() => ({ route: "next" })));
      const linkResult = yield* Effect.exit(typed.go);
      expect(Exit.isFailure(replaceResult)).toBe(true);
      expect(Exit.isFailure(linkResult)).toBe(true);
      expect(location.history).toEqual([]);
    }),
  );

  it.scoped("claims custom encoded keys and preserves codec order", () =>
    Effect.gen(function* () {
      const { location } = yield* startWith(
        "http://app.test/workspace-with-filters-state?filters2=old-date&q2=old-second&filters=old-rank&q=old-first",
        [workspaceWithFiltersStateRoute],
      );
      const state = Option.getOrThrow(workspaceWithFiltersState);
      yield* state.set({
        panes: [
          { q: "first", filters: "rank" },
          { q: "second", filters: "date" },
        ],
      });
      expect(location.history).toEqual([
        "replace /workspace-with-filters-state?q=first&filters=rank&q2=second&filters2=date",
      ]);
    }),
  );

  it.scoped("releases claims when a route scope closes", () =>
    Effect.gen(function* () {
      const { location, router, root } = yield* startWith("http://app.test/counter", [
        counter,
        other,
      ]);
      const stale = Option.getOrThrow(counterState);
      yield* router.navigate("/other");
      yield* stale.set({ count: 9 });
      yield* render;
      expect(root.querySelector("#other")?.textContent).toBe("0");
      expect(location.history).toEqual(["push /other"]);
    }),
  );

  it.scoped("allows the same key in overlapping different route instances", () =>
    Effect.gen(function* () {
      const { router, root } = yield* startWith("http://app.test/counter", [counter, other]);
      yield* router.navigate("/other");
      yield* render;
      expect(root.querySelector("#other")?.textContent).toBe("0");
    }),
  );

  it.scoped("releases a child claim before reusing it in the same route", () =>
    Effect.gen(function* () {
      const { root } = yield* startWith("http://app.test/reusable-claims", [reusableClaims]);
      const setItems = Option.getOrThrow(reusableItems);
      expect(root.querySelectorAll("#reusable-claims span")).toHaveLength(1);
      yield* setItems([]);
      yield* render;
      expect(root.querySelectorAll("#reusable-claims span")).toHaveLength(0);
      yield* setItems(["second"]);
      yield* render;
      expect(root.querySelectorAll("#reusable-claims span")).toHaveLength(1);
    }),
  );

  it.scoped("releases a claim when its owning fiber is interrupted", () =>
    Effect.gen(function* () {
      const { root } = yield* startWith("http://app.test/interrupted-claim", [interruptedClaim]);
      expect(root.querySelector("#interrupted-claim")?.textContent).toBe("ok");
    }),
  );

  it.scoped("refuses route and view key collisions at mount", () =>
    Effect.gen(function* () {
      const routeCollisionResult = yield* Effect.exit(
        startWith("http://app.test/route-collision?c=1", [routeCollision]),
      );
      const viewCollisionResult = yield* Effect.exit(
        startWith("http://app.test/collision", [collision]),
      );
      expect(Exit.isFailure(routeCollisionResult)).toBe(true);
      expect(Exit.isFailure(viewCollisionResult)).toBe(true);
    }),
  );

  it.scoped("refuses opaque codecs without explicit keys", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        startWith("http://app.test/missing-opaque-keys", [missingOpaqueKeys]),
      );
      expect(Exit.isFailure(result)).toBe(true);
    }),
  );

  it.scoped("refuses a URL-state codec without an omitted fallback", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(startWith("http://app.test/required", [required]));
      expect(Exit.isFailure(result)).toBe(true);
    }),
  );

  it.scoped("rejects encoded keys outside an opaque claim before history writes", () =>
    Effect.gen(function* () {
      const { location } = yield* startWith("http://app.test/workspace-wrong-keys", [
        workspaceWrongKeys,
      ]);
      const state = Option.getOrThrow(workspaceWrongKeysState);
      const result = yield* Effect.exit(state.set({ panes: ["one"] }));
      expect(Exit.isFailure(result)).toBe(true);
      expect(location.history).toEqual([]);
    }),
  );

  it.live("keeps opaque codec ownership separate from route definitions", () =>
    Effect.sync(() => {
      const opaque = Route.client("opaque", {
        path: "/opaque",
        params: Nothing,
        search: Workspace,
        view: (_props: Route.RouteProps<{}, (typeof Workspace)["Type"]>) =>
          Effect.succeed(<span />),
      });
      expect(opaque.searchKeys.known).toBe(false);
      const declared = Route.client("declared-opaque", {
        path: "/declared-opaque",
        params: Nothing,
        search: Workspace,
        searchKeys: ["workspace"],
        view: (_props: Route.RouteProps<{}, (typeof Workspace)["Type"]>) =>
          Effect.succeed(<span />),
      });
      expect(declared.searchKeys).toEqual({ known: true, keys: ["workspace"] });
      expect(() =>
        Route.client("bad-declaration", {
          path: "/bad-declaration",
          params: Nothing,
          search: Workspace,
          searchKeys: ["wrong"],
          view: (_props: Route.RouteProps<{}, (typeof Workspace)["Type"]>) =>
            Effect.succeed(<span />),
        }),
      ).not.toThrow();
      expect(() =>
        Route.client("bad-fixed-declaration", {
          path: "/bad-fixed-declaration",
          params: Nothing,
          search: CountSearch,
          searchKeys: ["wrong"],
          view: (_props: Route.RouteProps<{}, (typeof CountSearch)["Type"]>) =>
            Effect.succeed(<span />),
        }),
      ).toThrow();
    }),
  );
});
