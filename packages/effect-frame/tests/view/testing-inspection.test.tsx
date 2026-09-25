import { registerDom } from "./dom-setup.js";

registerDom();

import {
  Actor,
  Behavior,
  implementQuery,
  query,
  type LocalActorRef,
  type SetValue,
  Policies,
  Policy,
  QueryCache,
} from "effect-frame/actor";
import { QueryTest } from "effect-frame/actor/testing";
import {
  Location,
  Route,
  mount as mountRouter,
  type LocationService,
  type NotFoundProps,
  NavigationBehavior,
} from "effect-frame/router";
import { Dom, Await, View } from "effect-frame/view";
import { ViewTest } from "effect-frame/view/testing";
import * as Frame from "../../src/frame.js";
// @ts-expect-error Effect keeps this pinned scope counter runtime-only; this test checks scope ownership.
import { scopeFinalizerCountUnsafe } from "../../../../node_modules/effect/dist/internal/effect.js";
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "effect-bun-test";

/** The one policy table: every contract and query here declares `public`. */
const policies = Layer.succeed(Policies, Policies.of({ public: Policy.allowAll }));

const BlockedQuery = query("ViewTestInspectionBlocked", {
  version: 1,
  policy: "public",
  args: Schema.Struct({}),
  result: Schema.String,
  depends: [],
});

class BlockControl extends Context.Service<
  BlockControl,
  {
    readonly gate: Deferred.Deferred<void>;
    readonly started: Deferred.Deferred<void>;
    readonly reads: Ref.Ref<number>;
  }
>()("effect-frame/tests/view/testing-inspection.test/BlockControl") {}

const BlockedLive = implementQuery(BlockedQuery, {
  run: () =>
    Effect.gen(function* () {
      const control = yield* BlockControl;
      yield* Ref.update(control.reads, (reads) => reads + 1);
      yield* Deferred.succeed(control.started, void 0);
      yield* Deferred.await(control.gate);
      return "ready";
    }),
});

const SearchPage = () =>
  View.loading({
    fallback: <p id="loading">loading</p>,
    content: Effect.gen(function* () {
      const entry = yield* QueryCache.use((cache) => cache.open(BlockedQuery, {}));
      yield* View.readyWithStale(entry.state, "");
      return (
        <Await
          state={entry.state}
          loading={<p id="query-loading">query-loading</p>}
          ready={(value) => <p id="result">{View.bind(value)}</p>}
          failed={() => <p id="failed">failed</p>}
        />
      );
    }),
  });

const InspectionPage = (local: LocalActorRef<string, SetValue<string>>) =>
  Effect.gen(function* () {
    const search = yield* SearchPage();
    return (
      <section>
        <output id="actor">{View.bind(local.state, String)}</output>
        {search}
      </section>
    );
  });

const makeControl = Effect.gen(function* () {
  return BlockControl.of({
    gate: yield* Deferred.make<void>(),
    started: yield* Deferred.make<void>(),
    reads: yield* Ref.make(0),
  });
});

const makeQueryRoot = (name: string, control: BlockControl["Service"]) =>
  QueryTest.layer({ queries: [BlockedLive] }).pipe(
    Layer.provide(policies),
    Layer.provideMerge(Layer.succeed(BlockControl, control)),
    Layer.provideMerge(TestClock.layer()),
    Layer.provideMerge(Frame.layer({ name })),
  );

const emptySnapshot: Frame.Snapshot = {
  version: 1,
  root: { id: Schema.decodeSync(Frame.Identity)("fixture-root"), name: "fixture" },
  collection: "sampled",
  startedAt: 0,
  finishedAt: 0,
  mounts: [],
  routes: [],
  actors: [],
  queries: [],
  urlStates: [],
  commands: { _tag: "Available", records: [] },
};

const hasElement = (root: Node, selector: string): boolean =>
  root instanceof HTMLElement && Option.isSome(Option.fromNullishOr(root.querySelector(selector)));

const textAt = (root: Node, selector: string): string => {
  if (!(root instanceof HTMLElement)) {
    return "";
  }
  return Option.match(Option.fromNullishOr(root.querySelector(selector)), {
    onNone: () => "",
    onSome: (element) => Option.getOrElse(Option.fromNullishOr(element.textContent), () => ""),
  });
};

const conditionFailure = (exit: Exit.Exit<unknown, unknown>): ViewTest.ConditionNotObserved => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const error = Cause.findErrorOption(exit.cause);
    expect(Option.isSome(error)).toBe(true);
    if (Option.isSome(error) && Schema.is(ViewTest.ConditionNotObserved)(error.value)) {
      return error.value;
    }
  }
  expect(false).toBe(true);
  return Option.getOrThrow(Option.none<ViewTest.ConditionNotObserved>());
};

describe("ViewTest Frame inspection", () => {
  it.scoped.layer(
    QueryTest.layer({ queries: [BlockedLive] }).pipe(
      Layer.provide(policies),
      Layer.provideMerge(Layer.effect(BlockControl, makeControl)),
      Layer.provideMerge(TestClock.layer()),
      Layer.provideMerge(Frame.layer({ name: "view-test-inspection" })),
    ),
  )("reports the same root's blocked query and local actor on failure", () =>
    Effect.gen(function* () {
      const control = yield* BlockControl;
      const local = yield* Actor.local(Behavior.value("local"));
      const root = document.createElement("main");
      const page = yield* ViewTest.make({
        host: Dom.host,
        root,
        rootId: "view-test-root",
        setup: (host, mountRoot) => View.mount(() => InspectionPage(local), {}, host, mountRoot),
      });

      yield* Deferred.await(control.started);
      yield* page.waitFor({
        label: "blocked query loading",
        until: (actualRoot) => hasElement(actualRoot, "#loading"),
      });
      const rootBeforeFailure = yield* Frame.inspect;
      yield* TestClock.adjust("2 seconds");
      const appTimeBefore = yield* Clock.currentTimeMillis;

      const failure = conditionFailure(
        yield* Effect.exit(
          page.waitFor({
            label: "deliberately false inspection condition",
            timeout: "20 millis",
            until: () => false,
          }),
        ),
      );

      expect(yield* Clock.currentTimeMillis).toBe(appTimeBefore);
      expect(failure.rootId).toBe("view-test-root");
      expect(failure.inspection._tag).toBe("Available");
      if (failure.inspection._tag === "Available") {
        const snapshot = failure.inspection.snapshot;
        expect(snapshot.root.id).toBe(rootBeforeFailure.root.id);
        expect(snapshot.root.name).toBe("view-test-inspection");
        expect(snapshot.mounts).toHaveLength(1);
        expect(snapshot.mounts[0]?.phase).toBe("mounted");
        expect(snapshot.queries).toHaveLength(1);
        expect(snapshot.queries[0]?.key).toContain("ViewTestInspectionBlocked");
        expect(snapshot.queries[0]?.state).toBe("Loading");
        expect(snapshot.queries[0]?.ageMs).toBe(2_000);
        expect(snapshot.actors).toHaveLength(1);
        expect(snapshot.actors[0]?.kind).toBe("local");
        expect(snapshot.actors[0]?.revision).toBe(0);
        expect(snapshot.commands).toEqual({ _tag: "Available", records: [] });
        expect(Schema.is(Frame.Snapshot)(snapshot)).toBe(true);
      }
      expect(yield* Ref.get(control.reads)).toBe(1);
    }),
  );

  it.scoped("keeps identical query failures in their own Frame roots", () =>
    Effect.gen(function* () {
      const firstControl = yield* makeControl;
      const secondControl = yield* makeControl;
      const firstScope = yield* Scope.make();
      const secondScope = yield* Scope.make();
      const firstContext = yield* Scope.provide(
        Layer.build(makeQueryRoot("first-view-test-root", firstControl)),
        firstScope,
      );
      const secondContext = yield* Scope.provide(
        Layer.build(makeQueryRoot("second-view-test-root", secondControl)),
        secondScope,
      );
      const firstRoot = document.createElement("main");
      const secondRoot = document.createElement("main");
      const makePage = <Services,>(
        context: Context.Context<Services>,
        scope: Scope.Scope,
        root: HTMLElement,
      ) =>
        Scope.provide(
          Effect.provideContext(
            ViewTest.make({
              host: Dom.host,
              root,
              setup: (host, mountRoot) => View.mount(SearchPage, {}, host, mountRoot),
            }),
            context,
          ),
          scope,
        );
      const firstPage = yield* makePage(firstContext, firstScope, firstRoot);
      const secondPage = yield* makePage(secondContext, secondScope, secondRoot);
      yield* Deferred.await(firstControl.started);
      yield* Deferred.await(secondControl.started);
      yield* firstPage.waitFor({
        label: "first loading",
        until: (actualRoot) => hasElement(actualRoot, "#loading"),
      });
      yield* secondPage.waitFor({
        label: "second loading",
        until: (actualRoot) => hasElement(actualRoot, "#loading"),
      });

      const firstBefore = yield* Effect.provideContext(Frame.inspect, firstContext);
      const secondBefore = yield* Effect.provideContext(Frame.inspect, secondContext);
      const firstFailure = conditionFailure(
        yield* Effect.exit(
          firstPage.waitFor({
            label: "first root only",
            timeout: "20 millis",
            until: () => false,
          }),
        ),
      );

      expect(firstFailure.inspection._tag).toBe("Available");
      if (firstFailure.inspection._tag === "Available") {
        expect(firstFailure.inspection.snapshot.root.id).toBe(firstBefore.root.id);
        expect(firstFailure.inspection.snapshot.root.id).not.toBe(secondBefore.root.id);
        expect(firstFailure.inspection.snapshot.queries[0]?.id).toBe(firstBefore.queries[0]?.id);
        expect(firstFailure.inspection.snapshot.queries[0]?.id).not.toBe(
          secondBefore.queries[0]?.id,
        );
      }
      yield* Scope.close(firstScope, Exit.void);
      yield* Scope.close(secondScope, Exit.void);
    }),
  );

  it.scoped("does not collect inspection after a successful action", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const frame = Frame.Service.of({
        inspect: Effect.map(
          Ref.update(calls, (count) => count + 1),
          () => emptySnapshot,
        ),
      });
      const root = document.createElement("main");
      const page = yield* Effect.provideService(
        ViewTest.make({
          host: Dom.host,
          root,
          setup: (host, mountRoot) =>
            View.mount(() => Effect.succeed(<p id="ready">ready</p>), {}, host, mountRoot),
        }),
        Frame.Service,
        frame,
      );

      yield* page.act(Effect.void, {
        label: "already true action result",
        until: (actualRoot) => hasElement(actualRoot, "#ready"),
      });
      expect(yield* Ref.get(calls)).toBe(0);
    }),
  );

  it.scoped("reports and cancels a never-completing diagnostic", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const finalized = yield* Deferred.make<void>();
      const frame = Frame.Service.of({
        inspect: Effect.gen(function* () {
          yield* Deferred.succeed(started, void 0);
          return yield* Effect.ensuring(Effect.never, Deferred.succeed(finalized, void 0));
        }),
      });
      const page = yield* Effect.provideService(
        ViewTest.make({
          host: Dom.host,
          root: document.createElement("main"),
          setup: (host, mountRoot) =>
            View.mount(() => Effect.succeed(<p id="never">never</p>), {}, host, mountRoot),
        }),
        Frame.Service,
        frame,
      );
      const failure = conditionFailure(
        yield* Effect.exit(
          page.waitFor({
            label: "diagnostic timeout",
            timeout: "20 millis",
            until: () => false,
          }),
        ),
      );

      expect(yield* Deferred.isDone(started)).toBe(true);
      expect(yield* Deferred.isDone(finalized)).toBe(true);
      expect(failure.inspection).toEqual({ _tag: "Unavailable", reason: "CollectionTimedOut" });
    }),
  );

  it.scoped.layer(Frame.layer({ name: "view-test-scope-lifetime" }))(
    "closes completed diagnostic scopes while the harness remains open",
    () =>
      Effect.gen(function* () {
        const root = document.createElement("main");
        const page = yield* ViewTest.make({
          host: Dom.host,
          root,
          setup: (host, mountRoot) =>
            Effect.gen(function* () {
              yield* View.mount(
                () => Effect.succeed(<p id="stable">stable</p>),
                {},
                host,
                mountRoot,
              );
              return yield* Effect.scope;
            }),
        });
        const baseline = scopeFinalizerCountUnsafe(page.setup);
        const counts: Array<number> = [baseline];

        for (let index = 0; index < 4; index += 1) {
          const failure = conditionFailure(
            yield* Effect.exit(
              page.waitFor({
                label: `repeated diagnostic ${String(index)}`,
                timeout: "5 millis",
                until: () => false,
              }),
            ),
          );
          expect(failure.inspection._tag).toBe("Available");
          counts.push(scopeFinalizerCountUnsafe(page.setup));
        }

        expect(counts).toEqual([baseline, baseline, baseline, baseline, baseline]);
        yield* page.close;
      }),
  );

  it.scoped("uses the construction Clock for failure inspection", () =>
    Effect.gen(function* () {
      const constructionContext = yield* Layer.build(TestClock.layer());
      const frame = Frame.Service.of({
        inspect: Effect.map(Clock.currentTimeMillis, (now) => ({
          ...emptySnapshot,
          startedAt: now,
          finishedAt: now,
        })),
      });
      const page = yield* Effect.provideContext(
        ViewTest.make({
          host: Dom.host,
          root: document.createElement("main"),
          setup: (host, mountRoot) =>
            View.mount(
              () => Effect.succeed(<p id="construction-clock">clock</p>),
              {},
              host,
              mountRoot,
            ),
        }),
        Context.add(constructionContext, Frame.Service, frame),
      );

      yield* Effect.provideContext(TestClock.adjust("7 seconds"), constructionContext);
      const callerClock = Context.get(Context.empty(), Clock.Clock);
      const failure = conditionFailure(
        yield* Effect.provideService(
          Effect.exit(
            page.waitFor({
              label: "construction Clock inspection",
              timeout: "20 millis",
              until: () => false,
            }),
          ),
          Clock.Clock,
          callerClock,
        ),
      );

      expect(failure.inspection._tag).toBe("Available");
      if (failure.inspection._tag === "Available") {
        expect(failure.inspection.snapshot.startedAt).toBe(7_000);
        expect(failure.inspection.snapshot.finishedAt).toBe(7_000);
      }
    }),
  );

  it.scoped("keeps a timeout committed while delayed inspection observes a later host write", () =>
    Effect.gen(function* () {
      const inspectionStarted = yield* Deferred.make<void>();
      const releaseInspection = yield* Deferred.make<void>();
      const frame = Frame.Service.of({
        inspect: Effect.gen(function* () {
          yield* Deferred.succeed(inspectionStarted, void 0);
          yield* Deferred.await(releaseInspection);
          return emptySnapshot;
        }),
      });
      const root = document.createElement("main");
      const page = yield* Effect.provideService(
        ViewTest.make({
          host: Dom.host,
          root,
          setup: (host, mountRoot) =>
            Effect.sync(() => {
              const node = document.createElement("p");
              node.id = "delayed";
              host.insert(mountRoot, node, Option.none());
              return {
                complete: () => host.setText(node, "done"),
              };
            }),
        }),
        Frame.Service,
        frame,
      );
      const waiting = yield* page
        .waitFor({
          label: "delayed diagnostic condition",
          timeout: "20 millis",
          until: (actualRoot) => textAt(actualRoot, "#delayed") === "done",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(inspectionStarted);
      page.setup.complete();
      yield* Deferred.succeed(releaseInspection, void 0);
      const failure = conditionFailure(yield* Fiber.await(waiting));

      expect(root.querySelector("#delayed")?.textContent).toBe("done");
      expect(failure.inspection._tag).toBe("Available");
    }),
  );

  it.scoped("reports a diagnostic defect as unavailable", () =>
    Effect.gen(function* () {
      const frame = Frame.Service.of({ inspect: Effect.die("inspection defect") });
      const page = yield* Effect.provideService(
        ViewTest.make({
          host: Dom.host,
          root: document.createElement("main"),
          setup: (host, mountRoot) =>
            View.mount(() => Effect.succeed(<p id="defect">defect</p>), {}, host, mountRoot),
        }),
        Frame.Service,
        frame,
      );
      const failure = conditionFailure(
        yield* Effect.exit(
          page.waitFor({
            label: "defective diagnostic",
            timeout: "20 millis",
            until: () => false,
          }),
        ),
      );

      expect(failure.inspection).toEqual({ _tag: "Unavailable", reason: "CollectionDefect" });
    }),
  );

  it.scoped("interrupts diagnostic collection when the harness closes", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const frame = Frame.Service.of({
        inspect: Deferred.succeed(started, void 0).pipe(Effect.andThen(Effect.never)),
      });
      const root = document.createElement("main");
      const page = yield* Effect.provideService(
        ViewTest.make({
          host: Dom.host,
          root,
          setup: (host, mountRoot) =>
            View.mount(() => Effect.succeed(<p id="close">close</p>), {}, host, mountRoot),
        }),
        Frame.Service,
        frame,
      );
      const waiting = yield* page
        .waitFor({
          label: "close during diagnostics",
          timeout: "20 millis",
          until: () => false,
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* page.close;
      const failure = conditionFailure(yield* Fiber.await(waiting));
      expect(failure.inspection).toEqual({ _tag: "Unavailable", reason: "CollectionDefect" });
      expect(failure.rootDisposed).toBe(false);
      expect(root.childNodes).toHaveLength(0);
    }),
  );

  it.scoped.layer(
    QueryTest.layer({ queries: [BlockedLive] }).pipe(
      Layer.provide(policies),
      Layer.provideMerge(Layer.effect(BlockControl, makeControl)),
      Layer.provideMerge(TestClock.layer()),
      Layer.provideMerge(Frame.layer({ name: "view-test-routed-inspection" })),
    ),
  )("includes the mounted route in a routed ViewTest failure", () =>
    Effect.gen(function* () {
      const control = yield* BlockControl;
      const location: LocationService = {
        current: Effect.succeed(new URL("http://app.test/search?q=blocked")),
        push: () => Effect.void,
        replace: () => Effect.void,
        pops: Stream.empty,
      };
      const routeSegment = Route.segment("search", {
        path: "/search",
        params: Schema.Struct({}),
        search: Route.search(Schema.Struct({ query: Schema.String.pipe(Route.withDefault("")) })),
      });
      const route = Route.client(
        "search",
        Route.leaf(routeSegment, () => SearchPage()),
      );
      const notFound = (_props: NotFoundProps) => Effect.succeed(<p id="missing">missing</p>);
      const root = document.createElement("main");
      const page = yield* ViewTest.make({
        host: Dom.host,
        root,
        rootId: "view-test-routed-root",
        setup: (host, mountRoot) =>
          mountRouter({
            landing: NavigationBehavior.Restore,
            traversalReadLimit: "3 seconds",
            routes: [route],
            notFound,
            host,
            root: mountRoot,
          }).pipe(Effect.provideService(Location, location)),
      });

      yield* Deferred.await(control.started);
      yield* page.waitFor({
        label: "routed blocked query loading",
        until: (actualRoot) => hasElement(actualRoot, "#loading"),
      });
      const failure = conditionFailure(
        yield* Effect.exit(
          page.waitFor({
            label: "routed inspection condition",
            timeout: "20 millis",
            until: () => false,
          }),
        ),
      );

      expect(failure.rootId).toBe("view-test-routed-root");
      expect(failure.inspection._tag).toBe("Available");
      if (failure.inspection._tag === "Available") {
        const snapshot = failure.inspection.snapshot;
        expect(snapshot.mounts.some((mountRecord) => mountRecord.phase === "mounted")).toBe(true);
        expect(snapshot.routes).toHaveLength(1);
        expect(snapshot.routes[0]?.routeName).toBe("search");
        expect(snapshot.routes[0]?.phase).toBe("mounted");
        expect(snapshot.queries).toHaveLength(1);
        expect(snapshot.queries[0]?.state).toBe("Loading");
      }
    }),
  );
});
