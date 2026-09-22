import { registerDom } from "./dom-setup.js";

registerDom();

import { QueryCache, QueryFailure, implementQuery, query, useQuery } from "effect-frame/actor";
import type { QueryEntry, Source } from "effect-frame/actor";
import { select as selectSource } from "effect-frame/actor/client";
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
  mount,
  orErrored,
  ready,
  readyWithStale,
  render,
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
} from "effect";
import { describe, expect, it } from "effect-bun-test";

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

/**
 * Bind a source outside a view's setup, by building the marker directly.
 * `View.bind` does the same; this spells out that a `Bound` is only data.
 */
const bound = <A, B>(source: Source<A>, project: (value: A) => B): Bound<B> => ({
  _tag: "Bound",
  source: selectSource(source, project),
});

/**
 * Deliver every pending host write. `render` already yields to the forked
 * subscription fibers before it flushes the reactive graph; a readiness
 * change travels through more of them (the query source, the shared
 * broadcast, the settled source, the derived pending source), so the test
 * runs it twice rather than guessing a count.
 */
const flush = Effect.andThen(render, render);

const staleClass = (stale: boolean): string => {
  if (stale) {
    return "stale";
  }
  return "fresh";
};

/** Mount a scope view, which takes no props of its own. */
const mountScoped = <E, R>(view: View.View<Record<string, never>, E, R>, root: HTMLElement) =>
  mount(view, {}, Dom.host, root);

/**
 * The scope tests below use the public QueryTest layer. The handler keeps its
 * responses in a test service so each test can make a read pending, ready, or
 * failed without replacing the cache or transport.
 */
const ReadinessQuery = query("ReadinessView", {
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

        yield* mountScoped(Page, root);
        expect(textOf(root, "#pending")).toBe("loading");
        expect(has(root, "#title")).toBe(false);

        yield* setResponse(fixtures, "title", readyResponse("Alpha"));
        yield* Deferred.succeed(gate, void 0);
        yield* flush;
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

      yield* mountScoped(Page, root);
      yield* flush;
      expect(textOf(root, "#title")).toBe("Alpha");
      expect(textOf(root, "#stale")).toBe("false");

      // The Refetch row: content stays, the fallback does not come back.
      const gate = yield* Deferred.make<void>();
      yield* setResponse(fixtures, "title", pendingResponse(gate, "Beta"));
      const entry = yield* Deferred.await(entryReady);
      const refreshing = yield* Effect.forkChild(entry.refresh);
      yield* flush;
      expect(has(root, "#pending")).toBe(false);
      expect(textOf(root, "#title")).toBe("Alpha");
      expect(textOf(root, "#stale")).toBe("true");

      yield* setResponse(fixtures, "title", readyResponse("Beta"));
      yield* Deferred.succeed(gate, void 0);
      yield* Fiber.join(refreshing);
      yield* flush;
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
        yield* setResponse(fixtures, "left", pendingResponse(leftGate, "one"));
        yield* setResponse(fixtures, "right", pendingResponse(rightGate, "two"));

        const Page = () =>
          Loading({
            fallback: <p id="pending">loading</p>,
            children: Effect.gen(function* () {
              const left = yield* useQuery(ReadinessQuery, { id: "left" });
              const right = yield* useQuery(ReadinessQuery, { id: "right" });
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

        yield* mountScoped(Page, root);
        expect(textOf(root, "#pending")).toBe("loading");

        yield* setResponse(fixtures, "left", readyResponse("one"));
        yield* Deferred.succeed(leftGate, void 0);
        yield* flush;
        expect(textOf(root, "#pending")).toBe("loading");

        yield* setResponse(fixtures, "right", readyResponse("two"));
        yield* Deferred.succeed(rightGate, void 0);
        yield* flush;
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

        yield* mountScoped(Page, root);
        expect(textOf(root, "#pending")).toBe("loading");
        expect(has(root, "#failed")).toBe(false);

        const entry = yield* Deferred.await(entryReady);
        yield* setResponse(fixtures, "failure", failedResponse("boom"));
        yield* Deferred.succeed(initialGate, void 0);
        yield* Stream.runHead(
          Stream.filter(entry.state.changes, (state) => state._tag === "Failed"),
        );
        yield* flush;
        // A failed query has settled, so Loading releases its fallback.
        expect(has(root, "#pending")).toBe(false);
        // Errored owns the region and carries the typed failure.
        expect(textOf(root, "#failed")).toBe("boom");
        expect(has(root, "#title")).toBe(false);

        // The real cache keeps Failed during a refetch. It does not expose
        // the controlled Failed -> Loading transition below.
        yield* setResponse(fixtures, "failure", pendingResponse(retryGate, "unused"));
        const retrying = yield* Effect.forkChild(entry.refresh);
        yield* flush;
        expect(textOf(root, "#failed")).toBe("boom");
        expect(has(root, "#pending")).toBe(false);

        yield* setResponse(fixtures, "failure", readyResponse("Alpha"));
        yield* Deferred.succeed(retryGate, void 0);
        yield* Fiber.join(retrying);
        yield* flush;
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

      yield* mountScoped(Page, root);
      expect(textOf(root, "#controlled-pending")).toBe("loading");

      yield* controlled.reject("boom");
      yield* flush;
      expect(has(root, "#controlled-pending")).toBe(false);
      expect(textOf(root, "#controlled-failed")).toBe("boom");

      yield* controlled.refetch;
      yield* flush;
      expect(has(root, "#controlled-failed")).toBe(false);
      expect(textOf(root, "#controlled-pending")).toBe("loading");

      yield* controlled.resolve("Alpha");
      yield* flush;
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

      yield* mountScoped(Page, root);
      expect(textOf(root, "#outer-pending")).toBe("outer");

      // The outer query lands: the outer content appears, and the inner
      // scope is still showing its own fallback.
      yield* setResponse(fixtures, "outer", readyResponse("Header"));
      yield* Deferred.succeed(outerGate, void 0);
      yield* flush;
      expect(has(root, "#outer-pending")).toBe(false);
      expect(textOf(root, "#header")).toBe("Header");
      expect(textOf(root, "#inner-pending")).toBe("inner");
      expect(has(root, "#body")).toBe(false);

      yield* setResponse(fixtures, "inner", readyResponse("Body"));
      yield* Deferred.succeed(innerGate, void 0);
      yield* flush;
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

      yield* mountScoped(Page, root);
      expect(textOf(root, "#q-loading")).toBe("loading");

      yield* controlled.resolve("Alpha");
      yield* flush;
      expect(has(root, "#q-loading")).toBe(false);
      expect(textOf(root, "#q-ready")).toBe("Alpha");
      expect(root.querySelector("#q-ready")?.getAttribute("class")).toBe("fresh");

      yield* controlled.refetch;
      yield* flush;
      expect(textOf(root, "#q-ready")).toBe("Alpha");
      expect(root.querySelector("#q-ready")?.getAttribute("class")).toBe("stale");

      yield* controlled.reject("boom");
      yield* flush;
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

      yield* mountScoped(Page, root);
      expect(textOf(root, "#await-loading")).toBe("loading");

      yield* controlled.resolve("Alpha");
      yield* flush;
      expect(has(root, "#await-loading")).toBe(false);
      expect(textOf(root, "#await-ready")).toBe("Alpha");

      yield* controlled.reject("boom");
      yield* flush;
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

        yield* mountScoped(Page, root);
        // The first query already had a value, but the second has not, so the
        // scope is still pending. Registration order does not matter.
        expect(textOf(root, "#pending")).toBe("loading");

        yield* setResponse(fixtures, "second", readyResponse("two"));
        yield* Deferred.succeed(secondGate, void 0);
        yield* flush;
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

        yield* mountScoped(Page, root);
        yield* flush;
        expect(textOf(root, "#pending-fallback")).toBe("loading");

        // Closing the owner's scope removes only its contribution. The
        // sibling remains registered, so the boundary can settle.
        yield* Scope.close(owner, Exit.void);
        yield* flush;
        expect(has(root, "#pending-fallback")).toBe(false);
        expect(textOf(root, "#sibling-value")).toBe("sibling");

        yield* setResponse(fixtures, "pending", readyResponse("pending"));
        yield* Deferred.succeed(pendingGate, void 0);
        yield* flush;
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

        yield* mountScoped(Page, root);
        yield* flush;
        expect(textOf(root, "#failed-owner-error")).toBe("boom");
        expect(has(root, "#failed-owner-content")).toBe(false);

        yield* Scope.close(owner, Exit.void);
        yield* flush;
        expect(has(root, "#failed-owner-error")).toBe(false);
        expect(textOf(root, "#failed-owner-content")).toBe("content");
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
});
