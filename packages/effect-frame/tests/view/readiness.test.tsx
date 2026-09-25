import { registerDom } from "./dom-setup.js";

registerDom();

import {
  QueryCache,
  QueryFailure,
  implementQuery,
  query,
  useQuery,
  Policies,
  Policy,
} from "effect-frame/actor";
import type { QueryEntry, Source } from "effect-frame/actor";
import { Behavior, Value, select as selectSource, spawn } from "effect-frame/actor/client";
import { QueryTest } from "effect-frame/actor/testing";
import {
  Await,
  Dom,
  Errored,
  Html,
  Loading,
  Query,
  QueryState,
  View,
  ViewTest,
  mount,
  orErrored,
  ready,
  readyWithStale,
} from "effect-frame/view";
import type { Bound, ReadyValue } from "effect-frame/view";
import {
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
  SubscriptionRef,
} from "effect";
import { describe, expect, it } from "effect-bun-test";

/** The one policy table: every contract and query here declares `public`. */
const policies = Layer.succeed(Policies, Policies.of({ public: Policy.allowAll }));

/**
 * PROTOTYPE (ticket #16). Readiness through context, in a real document.
 *
 * Two shapes are proved side by side: `ready` inside `Loading`, where the
 * scope removes the consumer until a value exists, and `Await`, where the
 * view matches the union itself. Neither throws and neither catches.
 */

const makeRoot = Effect.sync(() => document.createElement("main"));

const textOf = (root: HTMLElement, selector: string): string =>
  root.querySelector(selector)?.textContent ?? "";

const has = (root: HTMLElement, selector: string): boolean =>
  Option.isSome(Option.fromNullishOr(root.querySelector(selector)));

const textAt = (root: Node, selector: string): string => {
  if (!(root instanceof HTMLElement)) {
    return "";
  }
  return textOf(root, selector);
};

const hasAt = (root: Node, selector: string): boolean => {
  if (!(root instanceof HTMLElement)) {
    return false;
  }
  return has(root, selector);
};

/**
 * Bind a source outside a view's setup, by building the marker directly.
 * `View.bind` does the same; this spells out that a `Bound` is only data.
 */
const bound = <A, B>(source: Source<A>, project: (value: A) => B): Bound<B> => ({
  _tag: "Bound",
  source: selectSource(source, project),
});

const staleClass = (stale: boolean): string => {
  if (stale) {
    return "stale";
  }
  return "fresh";
};

/** Mount a scope view, which takes no props of its own. */
const mountScoped = <E, R>(view: View.View<Record<string, never>, E, R>, root: HTMLElement) =>
  ViewTest.make({
    host: Dom.host,
    root,
    setup: (host, mountRoot) => mount(view, {}, host, mountRoot),
  });

/**
 * The scope tests below use the public QueryTest layer. The handler keeps its
 * responses in a test service so each test can make a read pending, ready, or
 * failed without replacing the cache or transport.
 */
const ReadinessQuery = query("ReadinessView", {
  policy: "public",
  args: Schema.Struct({ id: Schema.String }),
  result: Schema.String,
});

type ReadinessResponse =
  | { readonly _tag: "Ready"; readonly value: string }
  | { readonly _tag: "Pending"; readonly gate: Deferred.Deferred<void>; readonly value: string }
  | { readonly _tag: "Failed"; readonly error: string };

interface ReadinessFixturesService {
  readonly responses: Ref.Ref<ReadonlyMap<string, ReadinessResponse>>;
}

class ReadinessFixtures extends Context.Service<ReadinessFixtures, ReadinessFixturesService>()(
  "effect-frame/tests/view/readiness.test/ReadinessFixtures",
) {}

const ReadinessLive = implementQuery(ReadinessQuery, ({ id }) =>
  Effect.gen(function* () {
    const fixtures = yield* ReadinessFixtures;
    const response = yield* Ref.get(fixtures.responses).pipe(
      Effect.map(
        (responses): ReadinessResponse => responses.get(id) ?? { _tag: "Ready", value: id },
      ),
    );
    if (response._tag === "Pending") {
      yield* Deferred.await(response.gate);
      const afterGate = yield* Ref.get(fixtures.responses).pipe(
        Effect.map((responses): ReadinessResponse => responses.get(id) ?? response),
      );
      if (afterGate._tag === "Failed") {
        return yield* Effect.fail(afterGate.error);
      }
      return afterGate.value;
    }
    if (response._tag === "Failed") {
      return yield* Effect.fail(response.error);
    }
    return response.value;
  }),
);

const readinessLayer = QueryTest.layer({ queries: [ReadinessLive] }).pipe(
  Layer.provide(policies),
  Layer.provideMerge(
    Layer.effect(
      ReadinessFixtures,
      Effect.map(Ref.make<ReadonlyMap<string, ReadinessResponse>>(new Map()), (responses) => ({
        responses,
      })),
    ),
  ),
);

const setResponse = (
  fixtures: ReadinessFixturesService,
  id: string,
  response: ReadinessResponse,
): Effect.Effect<void> =>
  Ref.update(fixtures.responses, (responses) => {
    const next = new Map(responses);
    next.set(id, response);
    return next;
  });

const readyResponse = (value: string): ReadinessResponse => ({ _tag: "Ready", value });

const pendingResponse = (gate: Deferred.Deferred<void>, value: string): ReadinessResponse => ({
  _tag: "Pending",
  gate,
  value,
});

const failedResponse = (error: string): ReadinessResponse => ({ _tag: "Failed", error });

const errorText = (value: Option.Option<unknown>): string =>
  Option.match(value, {
    onNone: () => "",
    onSome: (error) =>
      Option.match(Option.liftPredicate(error, Schema.is(QueryFailure)), {
        onNone: () => "unknown",
        onSome: (failure) => {
          if (failure._tag === "QueryFailed") {
            return failure.detail;
          }
          return "unknown";
        },
      }),
  });

describe("readiness through context", () => {
  it.scoped.layer(readinessLayer)(
    "the facade holds the fallback until the query has a first value",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const fixtures = yield* ReadinessFixtures;
        const gate = yield* Deferred.make<void>();
        yield* setResponse(fixtures, "title", pendingResponse(gate, "Alpha"));

        const Page = () =>
          Loading({
            fallback: <p id="pending">loading</p>,
            children: Effect.gen(function* () {
              const entry = yield* useQuery(ReadinessQuery, { id: "title" });
              const title = yield* ready(entry.state, "");
              return <h1 id="title">{View.bind(title)}</h1>;
            }),
          });

        const page = yield* mountScoped(Page, root);
        expect(textOf(root, "#pending")).toBe("loading");
        expect(has(root, "#title")).toBe(false);

        yield* setResponse(fixtures, "title", readyResponse("Alpha"));
        yield* Deferred.succeed(gate, void 0);
        yield* page.waitFor({
          label: "first readiness value appears",
          until: (actualRoot) =>
            !hasAt(actualRoot, "#pending") && textAt(actualRoot, "#title") === "Alpha",
        });
        expect(has(root, "#pending")).toBe(false);
        expect(textOf(root, "#title")).toBe("Alpha");
      }),
  );

  it.scoped.layer(readinessLayer)("a refetch holds the content and exposes the stale flag", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const fixtures = yield* ReadinessFixtures;
      yield* setResponse(fixtures, "title", readyResponse("Alpha"));
      const entryReady = yield* Deferred.make<QueryEntry<string, QueryFailure>>();

      const Page = () =>
        Loading({
          fallback: <p id="pending">loading</p>,
          children: Effect.gen(function* () {
            const entry = yield* useQuery(ReadinessQuery, { id: "title" });
            yield* Deferred.succeed(entryReady, entry);
            const title = yield* readyWithStale(entry.state, "");
            return (
              <section>
                <h1 id="title">{View.bind(title, (state: ReadyValue<string>) => state.value)}</h1>
                <span id="stale">{View.bind(title, (state) => String(state.stale))}</span>
              </section>
            );
          }),
        });

      const page = yield* mountScoped(Page, root);
      yield* page.waitFor({
        label: "initial query value appears",
        until: (actualRoot) => textAt(actualRoot, "#title") === "Alpha",
      });
      expect(textOf(root, "#title")).toBe("Alpha");
      expect(textOf(root, "#stale")).toBe("false");

      // The Refetch row: content stays, the fallback does not come back.
      const gate = yield* Deferred.make<void>();
      yield* setResponse(fixtures, "title", pendingResponse(gate, "Beta"));
      const entry = yield* Deferred.await(entryReady);
      const refreshing = yield* Effect.forkChild(entry.refresh);
      yield* page.waitFor({
        label: "refetch marks content stale",
        until: (actualRoot) => textAt(actualRoot, "#stale") === "true",
      });
      expect(has(root, "#pending")).toBe(false);
      expect(textOf(root, "#title")).toBe("Alpha");
      expect(textOf(root, "#stale")).toBe("true");

      yield* setResponse(fixtures, "title", readyResponse("Beta"));
      yield* Deferred.succeed(gate, void 0);
      yield* Fiber.join(refreshing);
      yield* page.waitFor({
        label: "refetch value appears",
        until: (actualRoot) =>
          textAt(actualRoot, "#title") === "Beta" && textAt(actualRoot, "#stale") === "false",
      });
      expect(textOf(root, "#title")).toBe("Beta");
      expect(textOf(root, "#stale")).toBe("false");
    }),
  );

  it.scoped.layer(readinessLayer)(
    "two queries under one scope hold the fallback until both arrive",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const fixtures = yield* ReadinessFixtures;
        const leftGate = yield* Deferred.make<void>();
        const rightGate = yield* Deferred.make<void>();
        const leftObserved = yield* Deferred.make<void>();
        yield* setResponse(fixtures, "left", pendingResponse(leftGate, "one"));
        yield* setResponse(fixtures, "right", pendingResponse(rightGate, "two"));

        const Page = () =>
          Loading({
            fallback: <p id="pending">loading</p>,
            children: Effect.gen(function* () {
              const left = yield* useQuery(ReadinessQuery, { id: "left" });
              const right = yield* useQuery(ReadinessQuery, { id: "right" });
              yield* Effect.forkChild(
                Stream.runHead(
                  Stream.filter(left.state.changes, (state) => state._tag !== "Loading"),
                ).pipe(Effect.andThen(Deferred.succeed(leftObserved, void 0).pipe(Effect.asVoid))),
              );
              const a = yield* ready(left.state, "");
              const b = yield* ready(right.state, "");
              return (
                <section>
                  <span id="a">{View.bind(a)}</span>
                  <span id="b">{View.bind(b)}</span>
                </section>
              );
            }),
          });

        const page = yield* mountScoped(Page, root);
        expect(textOf(root, "#pending")).toBe("loading");

        yield* setResponse(fixtures, "left", readyResponse("one"));
        yield* Deferred.succeed(leftGate, void 0);
        // The source receipt makes the following unchanged Loading assertion
        // causal. The predicate was already true before the left result ran.
        yield* Deferred.await(leftObserved);
        yield* page.waitFor({
          label: "first query remains pending",
          until: (actualRoot) => textAt(actualRoot, "#pending") === "loading",
        });
        expect(textOf(root, "#pending")).toBe("loading");

        yield* setResponse(fixtures, "right", readyResponse("two"));
        yield* Deferred.succeed(rightGate, void 0);
        yield* page.waitFor({
          label: "both queries settle",
          until: (actualRoot) =>
            !hasAt(actualRoot, "#pending") &&
            textAt(actualRoot, "#a") === "one" &&
            textAt(actualRoot, "#b") === "two",
        });
        expect(has(root, "#pending")).toBe(false);
        expect(textOf(root, "#a")).toBe("one");
        expect(textOf(root, "#b")).toBe("two");
      }),
  );

  it.scoped.layer(readinessLayer)(
    "a real query routes failure to Errored and releases Loading",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const fixtures = yield* ReadinessFixtures;
        const initialGate = yield* Deferred.make<void>();
        const retryGate = yield* Deferred.make<void>();
        const entryReady = yield* Deferred.make<QueryEntry<string, QueryFailure>>();
        yield* setResponse(fixtures, "failure", pendingResponse(initialGate, "unused"));

        // `Errored` outside, `Loading` inside: the order a reader expects.
        // #26 made this order leave content behind; a shown branch now owns
        // its nodes, so either order holds.
        const Page = () =>
          Errored({
            fallback: (error) => <p id="failed">{bound(error, errorText)}</p>,
            children: Effect.gen(function* () {
              const entry = yield* useQuery(ReadinessQuery, { id: "failure" });
              yield* Deferred.succeed(entryReady, entry);
              const inner = Loading({
                fallback: <p id="pending">loading</p>,
                children: Effect.gen(function* () {
                  const title = yield* ready(yield* orErrored(entry.state), "");
                  return <h1 id="title">{View.bind(title)}</h1>;
                }),
              });
              return yield* inner;
            }),
          });

        const page = yield* mountScoped(Page, root);
        expect(textOf(root, "#pending")).toBe("loading");
        expect(has(root, "#failed")).toBe(false);

        const entry = yield* Deferred.await(entryReady);
        yield* setResponse(fixtures, "failure", failedResponse("boom"));
        yield* Deferred.succeed(initialGate, void 0);
        yield* Stream.runHead(
          Stream.filter(entry.state.changes, (state) => state._tag === "Failed"),
        );
        yield* page.waitFor({
          label: "query failure is shown",
          until: (actualRoot) => textAt(actualRoot, "#failed") === "boom",
        });
        // A failed query has settled, so Loading releases its fallback.
        expect(has(root, "#pending")).toBe(false);
        // Errored owns the region and carries the typed failure.
        expect(textOf(root, "#failed")).toBe("boom");
        expect(has(root, "#title")).toBe(false);

        // The real cache keeps Failed during a refetch. It does not expose
        // the controlled Failed -> Loading transition below.
        yield* setResponse(fixtures, "failure", pendingResponse(retryGate, "unused"));
        const retrying = yield* Effect.forkChild(entry.refresh);
        expect(textOf(root, "#failed")).toBe("boom");
        expect(has(root, "#pending")).toBe(false);

        yield* setResponse(fixtures, "failure", readyResponse("Alpha"));
        yield* Deferred.succeed(retryGate, void 0);
        yield* Fiber.join(retrying);
        yield* page.waitFor({
          label: "retry value is shown",
          until: (actualRoot) => textAt(actualRoot, "#title") === "Alpha",
        });
        expect(has(root, "#failed")).toBe(false);
        expect(has(root, "#pending")).toBe(false);
        expect(textOf(root, "#title")).toBe("Alpha");
      }),
  );

  it.scoped("a controlled source can show Loading while a failed query retries", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      // This source-level fixture covers a view transition that QueryCache
      // deliberately does not expose: Failed stays Failed until its refresh
      // succeeds. Ordinary query/readiness behavior uses QueryTest above.
      const controlled = yield* QueryState.fakeQuery<string, string>();

      const Page = () =>
        Errored({
          fallback: (error) => (
            <p id="controlled-failed">
              {bound(error, (found) => Option.getOrElse(found, () => "?"))}
            </p>
          ),
          children: Effect.gen(function* () {
            const inner = Loading({
              fallback: <p id="controlled-pending">loading</p>,
              children: Effect.gen(function* () {
                const title = yield* ready(yield* orErrored(controlled.source), "");
                return <h1 id="controlled-title">{View.bind(title)}</h1>;
              }),
            });
            return yield* inner;
          }),
        });

      const page = yield* mountScoped(Page, root);
      expect(textOf(root, "#controlled-pending")).toBe("loading");

      yield* page.act(controlled.reject("boom"), {
        label: "controlled failure is shown",
        until: (actualRoot) => textAt(actualRoot, "#controlled-failed") === "boom",
      });
      expect(has(root, "#controlled-pending")).toBe(false);
      expect(textOf(root, "#controlled-failed")).toBe("boom");

      yield* page.act(controlled.refetch, {
        label: "controlled retry shows loading",
        until: (actualRoot) => hasAt(actualRoot, "#controlled-pending"),
      });
      expect(has(root, "#controlled-failed")).toBe(false);
      expect(textOf(root, "#controlled-pending")).toBe("loading");

      yield* page.act(controlled.resolve("Alpha"), {
        label: "controlled retry resolves",
        until: (actualRoot) => textAt(actualRoot, "#controlled-title") === "Alpha",
      });
      expect(has(root, "#controlled-pending")).toBe(false);
      expect(textOf(root, "#controlled-title")).toBe("Alpha");
    }),
  );

  it.scoped.layer(readinessLayer)("nested scopes each wait only for their own queries", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const fixtures = yield* ReadinessFixtures;
      const outerGate = yield* Deferred.make<void>();
      const innerGate = yield* Deferred.make<void>();
      yield* setResponse(fixtures, "outer", pendingResponse(outerGate, "Header"));
      yield* setResponse(fixtures, "inner", pendingResponse(innerGate, "Body"));

      const Page = () =>
        Loading({
          fallback: <p id="outer-pending">outer</p>,
          children: Effect.gen(function* () {
            const outer = yield* useQuery(ReadinessQuery, { id: "outer" });
            const header = yield* ready(outer.state, "");
            const nested = Loading({
              fallback: <p id="inner-pending">inner</p>,
              children: Effect.gen(function* () {
                const inner = yield* useQuery(ReadinessQuery, { id: "inner" });
                const body = yield* ready(inner.state, "");
                return <p id="body">{View.bind(body)}</p>;
              }),
            });
            return (
              <section>
                <h1 id="header">{View.bind(header)}</h1>
                {yield* nested}
              </section>
            );
          }),
        });

      const page = yield* mountScoped(Page, root);
      expect(textOf(root, "#outer-pending")).toBe("outer");

      // The outer query lands: the outer content appears, and the inner
      // scope is still showing its own fallback.
      yield* setResponse(fixtures, "outer", readyResponse("Header"));
      yield* Deferred.succeed(outerGate, void 0);
      yield* page.waitFor({
        label: "outer query settles",
        until: (actualRoot) =>
          !hasAt(actualRoot, "#outer-pending") &&
          textAt(actualRoot, "#header") === "Header" &&
          textAt(actualRoot, "#inner-pending") === "inner",
      });
      expect(has(root, "#outer-pending")).toBe(false);
      expect(textOf(root, "#header")).toBe("Header");
      expect(textOf(root, "#inner-pending")).toBe("inner");
      expect(has(root, "#body")).toBe(false);

      yield* setResponse(fixtures, "inner", readyResponse("Body"));
      yield* Deferred.succeed(innerGate, void 0);
      yield* page.waitFor({
        label: "inner query settles",
        until: (actualRoot) => textAt(actualRoot, "#body") === "Body",
      });
      expect(has(root, "#inner-pending")).toBe(false);
      expect(textOf(root, "#body")).toBe("Body");
    }),
  );

  it.scoped("Query draws one of three branches and exposes the stale flag", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      // Query consumes a Source directly and has no cache or transport
      // boundary. Keep this as a source-level union test; ordinary query and
      // readiness behavior uses QueryTest above.
      const controlled = yield* QueryState.fakeQuery<string, string>();
      const Page = () =>
        Effect.succeed(
          <Query
            state={controlled.source}
            loading={<p id="q-loading">loading</p>}
            ready={(value, stale) => (
              <h1 id="q-ready" class={bound(stale, staleClass)}>
                {bound(value, (text) => text)}
              </h1>
            )}
            failed={(error) => <p id="q-failed">{bound(error, (text) => text)}</p>}
          />,
        );

      const page = yield* mountScoped(Page, root);
      expect(textOf(root, "#q-loading")).toBe("loading");

      yield* page.act(controlled.resolve("Alpha"), {
        label: "query value appears",
        until: (actualRoot) => textAt(actualRoot, "#q-ready") === "Alpha",
      });
      expect(has(root, "#q-loading")).toBe(false);
      expect(textOf(root, "#q-ready")).toBe("Alpha");
      expect(root.querySelector("#q-ready")?.getAttribute("class")).toBe("fresh");

      yield* page.act(controlled.refetch, {
        label: "query value becomes stale",
        until: (actualRoot) =>
          textAt(actualRoot, "#q-ready") === "Alpha" &&
          actualRoot instanceof HTMLElement &&
          actualRoot.querySelector("#q-ready")?.getAttribute("class") === "stale",
      });
      expect(textOf(root, "#q-ready")).toBe("Alpha");
      expect(root.querySelector("#q-ready")?.getAttribute("class")).toBe("stale");

      yield* page.act(controlled.reject("boom"), {
        label: "query failure appears",
        until: (actualRoot) => textAt(actualRoot, "#q-failed") === "boom",
      });
      expect(has(root, "#q-ready")).toBe(false);
      expect(textOf(root, "#q-failed")).toBe("boom");
    }),
  );

  // Await also consumes a source directly, so this test stays at the view
  // union boundary instead of manufacturing a transport for it.
  it.scoped("Await matches the union to one of three views, with no scope", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const controlled = yield* QueryState.fakeQuery<string, string>();

      const Page = () =>
        Await({
          query: controlled.source,
          loading: <p id="await-loading">loading</p>,
          ready: (value: Source<ReadyValue<string>>) => (
            <h1 id="await-ready">{bound(value, (state) => state.value)}</h1>
          ),
          failed: (error: Source<string>) => (
            <p id="await-failed">{bound(error, (text) => text)}</p>
          ),
        });

      const page = yield* mountScoped(Page, root);
      expect(textOf(root, "#await-loading")).toBe("loading");

      yield* page.act(controlled.resolve("Alpha"), {
        label: "await value appears",
        until: (actualRoot) => textAt(actualRoot, "#await-ready") === "Alpha",
      });
      expect(has(root, "#await-loading")).toBe(false);
      expect(textOf(root, "#await-ready")).toBe("Alpha");

      yield* page.act(controlled.reject("boom"), {
        label: "await failure appears",
        until: (actualRoot) => textAt(actualRoot, "#await-failed") === "boom",
      });
      expect(has(root, "#await-ready")).toBe(false);
      expect(textOf(root, "#await-failed")).toBe("boom");
    }),
  );

  it.scoped.layer(readinessLayer)(
    "a query registered after first paint puts the fallback back",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const fixtures = yield* ReadinessFixtures;
        const secondGate = yield* Deferred.make<void>();
        yield* setResponse(fixtures, "first", readyResponse("one"));
        yield* setResponse(fixtures, "second", pendingResponse(secondGate, "two"));

        const Page = () =>
          Loading({
            fallback: <p id="pending">loading</p>,
            children: Effect.gen(function* () {
              const first = yield* useQuery(ReadinessQuery, { id: "first" });
              const a = yield* ready(first.state, "");
              // A second query registers after the first already had a value.
              const second = yield* useQuery(ReadinessQuery, { id: "second" });
              const b = yield* ready(second.state, "");
              return (
                <section>
                  <span id="a">{View.bind(a)}</span>
                  <span id="b">{View.bind(b)}</span>
                </section>
              );
            }),
          });

        const page = yield* mountScoped(Page, root);
        // The first query already had a value, but the second has not, so the
        // scope is still pending. Registration order does not matter.
        expect(textOf(root, "#pending")).toBe("loading");

        yield* setResponse(fixtures, "second", readyResponse("two"));
        yield* Deferred.succeed(secondGate, void 0);
        yield* page.waitFor({
          label: "late query settles",
          until: (actualRoot) =>
            !hasAt(actualRoot, "#pending") && textAt(actualRoot, "#b") === "two",
        });
        expect(has(root, "#pending")).toBe(false);
        expect(textOf(root, "#a")).toBe("one");
        expect(textOf(root, "#b")).toBe("two");
      }),
  );

  it.scoped.layer(readinessLayer)(
    "removes a pending owner registration while preserving its settled sibling",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const fixtures = yield* ReadinessFixtures;
        const pendingGate = yield* Deferred.make<void>();
        const owner = yield* Scope.make();
        yield* setResponse(fixtures, "sibling", readyResponse("sibling"));
        yield* setResponse(fixtures, "pending", pendingResponse(pendingGate, "pending"));

        const Page = () =>
          Loading({
            fallback: <p id="pending-fallback">loading</p>,
            children: Effect.gen(function* () {
              const sibling = yield* useQuery(ReadinessQuery, { id: "sibling" });
              const pending = yield* useQuery(ReadinessQuery, { id: "pending" });
              const siblingValue = yield* ready(sibling.state, "");
              const pendingValue = yield* Scope.provide(ready(pending.state, ""), owner);
              return (
                <section>
                  <p id="sibling-value">{View.bind(siblingValue)}</p>
                  <p id="pending-value">{View.bind(pendingValue)}</p>
                </section>
              );
            }),
          });

        const page = yield* mountScoped(Page, root);
        expect(textOf(root, "#pending-fallback")).toBe("loading");

        // Closing the owner's scope removes only its contribution. The
        // sibling remains registered, so the boundary can settle.
        yield* Scope.close(owner, Exit.void);
        yield* page.waitFor({
          label: "closed owner releases pending fallback",
          until: (actualRoot) =>
            !hasAt(actualRoot, "#pending-fallback") &&
            textAt(actualRoot, "#sibling-value") === "sibling",
        });
        expect(has(root, "#pending-fallback")).toBe(false);
        expect(textOf(root, "#sibling-value")).toBe("sibling");

        yield* setResponse(fixtures, "pending", readyResponse("pending"));
        yield* Deferred.succeed(pendingGate, void 0);
        yield* page.waitFor({
          label: "released owner value appears",
          until: (actualRoot) => textAt(actualRoot, "#pending-value") === "pending",
        });
        expect(textOf(root, "#pending-value")).toBe("pending");
      }),
  );

  it.scoped.layer(readinessLayer)(
    "removes a failed owner registration from an Errored boundary",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const fixtures = yield* ReadinessFixtures;
        const owner = yield* Scope.make();
        yield* setResponse(fixtures, "failed", failedResponse("boom"));

        const Page = () =>
          Errored({
            fallback: (error) => <p id="failed-owner-error">{bound(error, errorText)}</p>,
            children: Effect.gen(function* () {
              const entry = yield* useQuery(ReadinessQuery, { id: "failed" });
              yield* Scope.provide(orErrored(entry.state), owner);
              return <p id="failed-owner-content">content</p>;
            }),
          });

        const page = yield* mountScoped(Page, root);
        yield* page.waitFor({
          label: "owned failure appears",
          until: (actualRoot) => textAt(actualRoot, "#failed-owner-error") === "boom",
        });
        expect(textOf(root, "#failed-owner-error")).toBe("boom");
        expect(has(root, "#failed-owner-content")).toBe(false);

        yield* Scope.close(owner, Exit.void);
        yield* page.waitFor({
          label: "closed error owner releases fallback",
          until: (actualRoot) => textAt(actualRoot, "#failed-owner-content") === "content",
        });
        expect(has(root, "#failed-owner-error")).toBe(false);
        expect(textOf(root, "#failed-owner-content")).toBe("content");
      }),
  );

  it.scoped.layer(readinessLayer)(
    "a row that registers after first paint is never connected while its scope is pending",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const fixtures = yield* ReadinessFixtures;
        const lateGate = yield* Deferred.make<void>();
        yield* setResponse(fixtures, "shown", readyResponse("shown"));
        yield* setResponse(fixtures, "late", pendingResponse(lateGate, "late"));
        const reveal = yield* Deferred.make<Effect.Effect<void>>();

        const LateCard = Effect.gen(function* () {
          const entry = yield* useQuery(ReadinessQuery, { id: "late" });
          const value = yield* ready(entry.state, "");
          return <p id="late-card">{View.bind(value)}</p>;
        });
        const Page = () =>
          Loading({
            fallback: <p id="late-pending">loading</p>,
            children: Effect.gen(function* () {
              const entry = yield* useQuery(ReadinessQuery, { id: "shown" });
              const value = yield* ready(entry.state, "");
              const revealed = yield* spawn(Behavior.value(false));
              yield* Deferred.succeed(reveal, Effect.asVoid(revealed.send(Value.Set(true))));
              const late = yield* View.list({
                each: selectSource(revealed.state, (open): ReadonlyArray<string> =>
                  Option.match(Option.liftPredicate(open, Boolean), {
                    onNone: () => [],
                    onSome: () => ["late"],
                  }),
                ),
                keyBy: (name: string) => name,
                row: () => LateCard,
              });
              return (
                <section id="late-page">
                  <p id="late-shown">{View.bind(value)}</p>
                  {late}
                </section>
              );
            }),
          });

        const page = yield* mountScoped(Page, root);
        yield* page.waitFor({
          label: "first paint",
          until: (actualRoot) => textAt(actualRoot, "#late-shown") === "shown",
        });

        // Every element connected under the root that is or holds the card.
        const connected: Array<string> = [];
        const note = (records: ReadonlyArray<MutationRecord>): void => {
          for (const record of records) {
            for (const added of Array.from(record.addedNodes)) {
              if (
                added instanceof HTMLElement &&
                (added.id === "late-card" || has(added, "#late-card"))
              ) {
                connected.push(added.id || added.tagName);
              }
            }
          }
        };
        const observer = new MutationObserver(note);
        yield* Effect.acquireRelease(
          Effect.sync(() => observer.observe(root, { childList: true, subtree: true })),
          () => Effect.sync(() => observer.disconnect()),
        );

        yield* Effect.flatten(Deferred.await(reveal));
        yield* page.waitFor({
          label: "the late registration puts the fallback back",
          until: (actualRoot) => hasAt(actualRoot, "#late-pending"),
        });
        yield* Effect.sync(() => note(observer.takeRecords()));
        // The card was built while the scope was pending: none of its nodes
        // reached the root.
        expect(connected).toEqual([]);
        expect(has(root, "#late-card")).toBe(false);

        yield* Deferred.succeed(lateGate, void 0);
        yield* page.waitFor({
          label: "the late card lands with its value",
          until: (actualRoot) =>
            !hasAt(actualRoot, "#late-pending") && textAt(actualRoot, "#late-card") === "late",
        });
        expect(textOf(root, "#late-shown")).toBe("shown");
      }),
  );

  it.scoped("a change read before a late registration does not bring the content back", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const shown = yield* QueryState.fakeQuery<string, string>();
      const late = yield* QueryState.fakeQuery<string, string>();
      const rows = yield* SubscriptionRef.make<ReadonlyArray<string>>([]);

      const LateCard = Effect.gen(function* () {
        const value = yield* ready(late.source, "");
        return <p id="late-card">{View.bind(value)}</p>;
      });
      const Page = () =>
        Loading({
          fallback: <p id="late-pending">loading</p>,
          children: Effect.gen(function* () {
            const value = yield* ready(shown.source, "");
            const card = yield* View.list({
              each: { get: SubscriptionRef.get(rows), changes: SubscriptionRef.changes(rows) },
              keyBy: (name: string) => name,
              row: () => LateCard,
            });
            return (
              <section id="late-page">
                <p id="late-shown">{View.bind(value)}</p>
                {card}
              </section>
            );
          }),
        });

      const page = yield* mountScoped(Page, root);
      yield* page.act(shown.resolve("shown"), {
        label: "first paint",
        until: (actualRoot) => textAt(actualRoot, "#late-shown") === "shown",
      });

      // Every element connected under the root that is or holds the card.
      const connected: Array<string> = [];
      const note = (records: ReadonlyArray<MutationRecord>): void => {
        for (const record of records) {
          for (const added of Array.from(record.addedNodes)) {
            if (
              added instanceof HTMLElement &&
              (added.id === "late-card" || has(added, "#late-card"))
            ) {
              connected.push(added.id || added.tagName);
            }
          }
        }
      };
      const observer = new MutationObserver(note);
      yield* Effect.acquireRelease(
        Effect.sync(() => observer.observe(root, { childList: true, subtree: true })),
        () => Effect.sync(() => observer.disconnect()),
      );

      // A registered query changes, and before the scope has read that
      // change the card registers: the scope's read of the change, taken
      // over the registrations it had, says settled.
      yield* page.act(Effect.andThen(shown.refetch, SubscriptionRef.set(rows, ["late"])), {
        label: "the late registration puts the fallback back",
        until: (actualRoot) => hasAt(actualRoot, "#late-pending"),
      });
      yield* page.act(shown.resolve("fresh"), {
        label: "the scope has read every change of the shown query",
        until: (actualRoot) => hasAt(actualRoot, "#late-pending"),
      });
      yield* Effect.sync(() => note(observer.takeRecords()));
      expect(connected).toEqual([]);
      expect(has(root, "#late-card")).toBe(false);

      yield* page.act(late.resolve("late"), {
        label: "the late card lands with its value",
        until: (actualRoot) =>
          !hasAt(actualRoot, "#late-pending") && textAt(actualRoot, "#late-card") === "late",
      });
      expect(textOf(root, "#late-shown")).toBe("fresh");
    }),
  );

  it.scoped.layer(readinessLayer)(
    "closing a readiness boundary releases its query cache entries",
    () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const fixtures = yield* ReadinessFixtures;
        const gate = yield* Deferred.make<void>();
        yield* setResponse(fixtures, "boundary", pendingResponse(gate, "boundary"));
        const boundary = yield* Scope.make();

        const Page = () =>
          Loading({
            fallback: <p id="boundary-pending">loading</p>,
            children: Effect.gen(function* () {
              const entry = yield* useQuery(ReadinessQuery, { id: "boundary" });
              const value = yield* ready(entry.state, "");
              return <p id="boundary-value">{View.bind(value)}</p>;
            }),
          });

        yield* Scope.provide(mountScoped(Page, root), boundary);
        const cache = yield* QueryCache;
        expect((yield* cache.active).length).toBe(1);
        expect(textOf(root, "#boundary-pending")).toBe("loading");

        yield* Scope.close(boundary, Exit.void);
        expect((yield* cache.active).length).toBe(0);
        expect(root.childNodes.length).toBe(0);
      }),
  );
});

// SSR tests use prebuilt source states because there is no live client cache
// in a string render. The live query boundary is covered above.
describe("readiness on the server", () => {
  it.scoped("a Loading with no registration shows its content", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const Page = (_props: Record<string, never>) =>
        Loading({
          fallback: <p id="pending">loading</p>,
          children: Effect.succeed(<p id="static">nothing to wait for</p>),
        });

      const page = yield* mountScoped(Page, root);
      yield* page.waitFor({
        label: "the content, with nothing registered",
        until: (actual) => hasAt(actual, "#static") && !hasAt(actual, "#pending"),
      });
      const html = yield* Html.renderToString(Page, {});
      expect(html).toContain('<p id="static">nothing to wait for</p>');
      expect(html).not.toContain('id="pending"');
    }),
  );

  it.scoped("a server render draws the fallback for a query with no value yet", () =>
    Effect.gen(function* () {
      const controlled = yield* QueryState.fakeQuery<string, string>();
      const Page = () =>
        Loading({
          fallback: <p id="pending">loading</p>,
          children: Effect.gen(function* () {
            const title = yield* ready(controlled.source, "");
            return <h1 id="title">{View.bind(title)}</h1>;
          }),
        });

      const html = yield* Html.renderToString(Page, {});
      // Streaming SSR is the row that will hold this scope open and resolve
      // it in the client; a non-streaming render simply draws the fallback.
      expect(html).toContain('<p id="pending">loading</p>');
      expect(html).not.toContain('id="title"');
    }),
  );

  it.scoped("a query already resolved renders its content, not its fallback", () =>
    Effect.gen(function* () {
      const controlled = yield* QueryState.fakeQuery<string, string>(
        QueryState.ready<string, string>("Alpha"),
      );
      const Page = () =>
        Loading({
          fallback: <p id="pending">loading</p>,
          children: Effect.gen(function* () {
            const title = yield* ready(controlled.source, "");
            return <h1 id="title">{View.bind(title)}</h1>;
          }),
        });

      const html = yield* Html.renderToString(Page, {});
      expect(html).toContain('<h1 id="title">Alpha</h1>');
      expect(html).not.toContain('id="pending"');
    }),
  );

  it.scoped("an already failed source renders Errored around Loading in one HTML frame", () =>
    Effect.gen(function* () {
      const controlled = yield* QueryState.fakeQuery<string, string>(QueryState.failed("boom"));
      const Page = () =>
        Errored({
          fallback: (error) => (
            <p id="error">
              {bound(error, (value) => Option.match(value, { onNone: () => "", onSome: String }))}
            </p>
          ),
          children: Loading({
            fallback: <p id="pending">loading</p>,
            children: Effect.gen(function* () {
              yield* orErrored(controlled.source);
              return <p id="content">wrong content</p>;
            }),
          }),
        });

      const html = yield* Html.renderToString(Page, {});
      expect(html).toContain('<p id="error">boom</p>');
      expect(html).not.toContain('id="pending"');
      expect(html).not.toContain('id="content"');
    }),
  );
});
