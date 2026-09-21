import { registerDom } from "./dom-setup.js";

registerDom();

import type { Source } from "effect-frame/actor";
import { select as selectSource } from "effect-frame/actor/client";
import {
  Await,
  Dom,
  Errored,
  Html,
  Loading,
  QueryState,
  View,
  mount,
  orErrored,
  ready,
  readyWithStale,
  render,
} from "effect-frame/view";
import type { Bound, ReadyValue } from "effect-frame/view";
import { Effect, Option } from "effect";
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
 * Bind a source outside a view's setup. `Await` hands its branches a plain
 * `Source`, and a branch is a `Node`, not an Effect, so there is no
 * `View.Context` in reach. Building the marker directly is what the facade
 * would otherwise do, and it shows the cost of `Await`'s shape.
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

/** Mount a scope view, which takes no props of its own. */
const mountScoped = <E, R>(view: View.View<Record<string, never>, E, R>, root: HTMLElement) =>
  mount(view, {}, Dom.host, root);

describe("readiness through context", () => {
  it.scoped("the facade holds the fallback until the query has a first value", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const query = yield* QueryState.fakeQuery<string, string>();

      const Page = Loading({
        fallback: <p id="pending">loading</p>,
        children: Effect.gen(function* () {
          const view = yield* View.Context;
          const title = yield* ready(query.source, "");
          return <h1 id="title">{view.bind(title)}</h1>;
        }),
      });

      yield* mountScoped(Page, root);
      expect(textOf(root, "#pending")).toBe("loading");
      expect(has(root, "#title")).toBe(false);

      yield* query.resolve("Alpha");
      yield* flush;
      expect(has(root, "#pending")).toBe(false);
      expect(textOf(root, "#title")).toBe("Alpha");
    }),
  );

  it.scoped("a refetch holds the content and exposes the stale flag", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const query = yield* QueryState.fakeQuery<string, string>();

      const Page = Loading({
        fallback: <p id="pending">loading</p>,
        children: Effect.gen(function* () {
          const view = yield* View.Context;
          const title = yield* readyWithStale(query.source, "");
          return (
            <section>
              <h1 id="title">{view.bind(title, (state: ReadyValue<string>) => state.value)}</h1>
              <span id="stale">{view.bind(title, (state) => String(state.stale))}</span>
            </section>
          );
        }),
      });

      yield* mountScoped(Page, root);
      yield* query.resolve("Alpha");
      yield* flush;
      expect(textOf(root, "#title")).toBe("Alpha");
      expect(textOf(root, "#stale")).toBe("false");

      // The Refetch row: content stays, the fallback does not come back.
      yield* query.refetch;
      yield* flush;
      expect(has(root, "#pending")).toBe(false);
      expect(textOf(root, "#title")).toBe("Alpha");
      expect(textOf(root, "#stale")).toBe("true");

      yield* query.resolve("Beta");
      yield* flush;
      expect(textOf(root, "#title")).toBe("Beta");
      expect(textOf(root, "#stale")).toBe("false");
    }),
  );

  it.scoped("two queries under one scope hold the fallback until both arrive", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const left = yield* QueryState.fakeQuery<string, string>();
      const right = yield* QueryState.fakeQuery<string, string>();

      const Page = Loading({
        fallback: <p id="pending">loading</p>,
        children: Effect.gen(function* () {
          const view = yield* View.Context;
          const a = yield* ready(left.source, "");
          const b = yield* ready(right.source, "");
          return (
            <section>
              <span id="a">{view.bind(a)}</span>
              <span id="b">{view.bind(b)}</span>
            </section>
          );
        }),
      });

      yield* mountScoped(Page, root);
      expect(textOf(root, "#pending")).toBe("loading");

      yield* left.resolve("one");
      yield* flush;
      expect(textOf(root, "#pending")).toBe("loading");

      yield* right.resolve("two");
      yield* flush;
      expect(has(root, "#pending")).toBe(false);
      expect(textOf(root, "#a")).toBe("one");
      expect(textOf(root, "#b")).toBe("two");
    }),
  );

  it.scoped("a failure routes to the Errored scope and the loading fallback lets go", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const query = yield* QueryState.fakeQuery<string, string>();

      // `Errored` outside, `Loading` inside: the order a reader expects.
      // #26 made this order leave content behind; a shown branch now owns
      // its nodes, so either order holds.
      const Page = Errored({
        fallback: (error) => (
          <p id="failed">{bound(error, (found) => Option.getOrElse(found, () => "?"))}</p>
        ),
        children: Effect.gen(function* () {
          const inner = Loading({
            fallback: <p id="pending">loading</p>,
            children: Effect.gen(function* () {
              const view = yield* View.Context;
              const title = yield* ready(yield* orErrored(query.source), "");
              return <h1 id="title">{view.bind(title)}</h1>;
            }),
          });
          return yield* inner.setup({});
        }),
      });

      yield* mountScoped(Page, root);
      expect(textOf(root, "#pending")).toBe("loading");
      expect(has(root, "#failed")).toBe(false);

      yield* query.reject("boom");
      yield* flush;
      // The loading fallback lets go, because a failed query has settled.
      expect(has(root, "#pending")).toBe(false);
      // The error fallback owns the region from here, and carries the error.
      expect(textOf(root, "#failed")).toBe("boom");
      expect(has(root, "#title")).toBe(false);

      // A retry: the query is in flight again, so the error fallback lets go
      // and the loading fallback comes back.
      yield* query.refetch;
      yield* flush;
      expect(has(root, "#failed")).toBe(false);
      expect(textOf(root, "#pending")).toBe("loading");

      yield* query.resolve("Alpha");
      yield* flush;
      expect(has(root, "#pending")).toBe(false);
      expect(textOf(root, "#title")).toBe("Alpha");
    }),
  );

  it.scoped("nested scopes each wait only for their own queries", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const outer = yield* QueryState.fakeQuery<string, string>();
      const inner = yield* QueryState.fakeQuery<string, string>();

      const Page = Loading({
        fallback: <p id="outer-pending">outer</p>,
        children: Effect.gen(function* () {
          const view = yield* View.Context;
          const header = yield* ready(outer.source, "");
          const nested = Loading({
            fallback: <p id="inner-pending">inner</p>,
            children: Effect.gen(function* () {
              const body = yield* ready(inner.source, "");
              return <p id="body">{view.bind(body)}</p>;
            }),
          });
          return (
            <section>
              <h1 id="header">{view.bind(header)}</h1>
              {yield* nested.setup({})}
            </section>
          );
        }),
      });

      yield* mountScoped(Page, root);
      expect(textOf(root, "#outer-pending")).toBe("outer");

      // The outer query lands: the outer content appears, and the inner
      // scope is still showing its own fallback.
      yield* outer.resolve("Header");
      yield* flush;
      expect(has(root, "#outer-pending")).toBe(false);
      expect(textOf(root, "#header")).toBe("Header");
      expect(textOf(root, "#inner-pending")).toBe("inner");
      expect(has(root, "#body")).toBe(false);

      yield* inner.resolve("Body");
      yield* flush;
      expect(has(root, "#inner-pending")).toBe(false);
      expect(textOf(root, "#body")).toBe("Body");
    }),
  );

  it.scoped("Await matches the union to one of three views, with no scope", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const query = yield* QueryState.fakeQuery<string, string>();

      const Page = Await({
        query: query.source,
        before: { value: "", error: "" },
        loading: <p id="await-loading">loading</p>,
        ready: (value: Source<ReadyValue<string>>) => (
          <h1 id="await-ready">{bound(value, (state) => state.value)}</h1>
        ),
        failed: (error: Source<string>) => <p id="await-failed">{bound(error, (text) => text)}</p>,
      });

      yield* mountScoped(Page, root);
      expect(textOf(root, "#await-loading")).toBe("loading");

      yield* query.resolve("Alpha");
      yield* flush;
      expect(has(root, "#await-loading")).toBe(false);
      expect(textOf(root, "#await-ready")).toBe("Alpha");

      yield* query.reject("boom");
      yield* flush;
      expect(has(root, "#await-ready")).toBe(false);
      expect(textOf(root, "#await-failed")).toBe("boom");
    }),
  );

  it.scoped("a query registered after first paint puts the fallback back", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      const first = yield* QueryState.fakeQuery<string, string>(
        QueryState.ready<string, string>("one"),
      );
      const second = yield* QueryState.fakeQuery<string, string>();

      const Page = Loading({
        fallback: <p id="pending">loading</p>,
        children: Effect.gen(function* () {
          const view = yield* View.Context;
          const a = yield* ready(first.source, "");
          // A second query registers after the first already had a value.
          const b = yield* ready(second.source, "");
          return (
            <section>
              <span id="a">{view.bind(a)}</span>
              <span id="b">{view.bind(b)}</span>
            </section>
          );
        }),
      });

      yield* mountScoped(Page, root);
      // The first query already had a value, but the second has not, so the
      // scope is still pending. Registration order does not matter.
      expect(textOf(root, "#pending")).toBe("loading");

      yield* second.resolve("two");
      yield* flush;
      expect(has(root, "#pending")).toBe(false);
      expect(textOf(root, "#a")).toBe("one");
      expect(textOf(root, "#b")).toBe("two");
    }),
  );
});

describe("readiness on the server", () => {
  it.scoped("a server render draws the fallback for a query with no value yet", () =>
    Effect.gen(function* () {
      const query = yield* QueryState.fakeQuery<string, string>();
      const Page = Loading({
        fallback: <p id="pending">loading</p>,
        children: Effect.gen(function* () {
          const view = yield* View.Context;
          const title = yield* ready(query.source, "");
          return <h1 id="title">{view.bind(title)}</h1>;
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
      const query = yield* QueryState.fakeQuery<string, string>(
        QueryState.ready<string, string>("Alpha"),
      );
      const Page = Loading({
        fallback: <p id="pending">loading</p>,
        children: Effect.gen(function* () {
          const view = yield* View.Context;
          const title = yield* ready(query.source, "");
          return <h1 id="title">{view.bind(title)}</h1>;
        }),
      });

      const html = yield* Html.renderToString(Page, {});
      expect(html).toContain('<h1 id="title">Alpha</h1>');
      expect(html).not.toContain('id="pending"');
    }),
  );
});
