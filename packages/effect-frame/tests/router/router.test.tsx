import { registerDom } from "./dom-setup.js";

registerDom();

import type { Source } from "effect-frame/actor";
import { Location, Route, Router, followLinks, mount } from "effect-frame/router";
import type { LocationService } from "effect-frame/router";
import { Dom, View, render } from "effect-frame/view";
import { Effect, Option, Queue, Ref, Schema, Stream } from "effect";
import { describe, expect, it } from "effect-bun-test";

/**
 * The router in a real document with a fake location. The fake records
 * every push and replace and can pop on request, so back navigation is
 * tested without a browser history.
 */

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

const makeRoot = Effect.sync(() => document.createElement("main"));

const textOf = (root: HTMLElement, selector: string): string =>
  root.querySelector(selector)?.textContent ?? "";

const Nothing = Schema.Struct({});

let homeMounts = 0;

const Home = View.make((_props: Route.RouteProps<unknown, unknown>) =>
  Effect.gen(function* () {
    const router = yield* Router;
    homeMounts += 1;
    return (
      <section id="home">
        <a id="to-book" href="/books/7">
          book
        </a>
        <button id="go" onClick={View.event(() => router.navigate("/books/9", { replace: true }))}>
          go
        </button>
      </section>
    );
  }),
);

const Book = View.make((props: Route.RouteProps<{ readonly id: string }, unknown>) =>
  Effect.succeed(<h1 id="book">{View.bind(props.params, (params) => params.id)}</h1>),
);

const NotFound = View.make((props: { readonly url: Source<URL> }) =>
  Effect.succeed(<p id="missing">{View.bind(props.url, (url) => url.pathname)}</p>),
);

const home = Route.spa("home", { path: "/", params: Nothing, search: Nothing, view: Home });
const book = Route.spa("book", {
  path: "/books/:id",
  params: Schema.Struct({ id: Schema.String }),
  search: Nothing,
  view: Book,
});

const start = (initial: string) =>
  Effect.gen(function* () {
    const root = yield* makeRoot;
    const location = yield* makeLocation(initial);
    const router = yield* mount({
      routes: [home, book],
      notFound: NotFound,
      host: Dom.host,
      root,
    }).pipe(Effect.provideService(Location, location.service));
    yield* followLinks(root, router);
    return { root, location, router };
  });

describe("router", () => {
  it.scoped("shows the route the initial URL matches, or not-found", () =>
    Effect.gen(function* () {
      const found = yield* start("http://app.test/");
      expect(textOf(found.root, "#home")).toContain("book");

      const missing = yield* start("http://app.test/nowhere");
      expect(textOf(missing.root, "#missing")).toBe("/nowhere");
    }),
  );

  it.scoped("navigate pushes and swaps the view; the previous one is gone", () =>
    Effect.gen(function* () {
      const { root, location, router } = yield* start("http://app.test/");
      yield* router.navigate("/books/3");
      yield* render;
      expect(textOf(root, "#book")).toBe("3");
      expect(root.querySelector("#home")).toBeNull();
      expect(location.history).toEqual(["push /books/3"]);
    }),
  );

  it.scoped("a navigation within the same route stays: the view keeps its identity", () =>
    Effect.gen(function* () {
      const { root, router } = yield* start("http://app.test/books/1");
      const before = root.querySelector("#book");
      yield* router.navigate("/books/2");
      yield* render;
      expect(textOf(root, "#book")).toBe("2");
      expect(root.querySelector("#book")).toBe(before);
    }),
  );

  it.scoped("navigating to the current URL is not a move", () =>
    Effect.gen(function* () {
      const { location, router } = yield* start("http://app.test/books/1");
      yield* router.navigate("/books/1");
      expect(location.history).toEqual([]);
    }),
  );

  it.scoped("a same-origin link click is intercepted; a modified click is not", () =>
    Effect.gen(function* () {
      const { root, location } = yield* start("http://app.test/");
      const link = Option.getOrThrow(Option.fromNullishOr(root.querySelector("#to-book")));
      const plain = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
      link.dispatchEvent(plain);
      yield* render;
      expect(plain.defaultPrevented).toBe(true);
      expect(textOf(root, "#book")).toBe("7");
      expect(location.history).toEqual(["push /books/7"]);

      const modified = new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true });
      root.dispatchEvent(modified);
      yield* render;
      expect(modified.defaultPrevented).toBe(false);
      expect(location.history).toEqual(["push /books/7"]);
    }),
  );

  it.scoped("replace does not push, and the view can reach the Router", () =>
    Effect.gen(function* () {
      const { root, location } = yield* start("http://app.test/");
      root.querySelector("#go")?.dispatchEvent(new Event("click"));
      yield* render;
      expect(textOf(root, "#book")).toBe("9");
      expect(location.history).toEqual(["replace /books/9"]);
    }),
  );

  it.scoped("a pop shows the popped URL and reports it as a pop", () =>
    Effect.gen(function* () {
      const { root, location, router } = yield* start("http://app.test/");
      yield* router.navigate("/books/4");
      yield* location.pop("/");
      yield* render;
      expect(root.querySelector("#book")).toBeNull();
      expect(textOf(root, "#home")).toContain("book");
      const last = yield* router.navigations.get;
      expect(last.kind).toBe("pop");
      expect(last.url.pathname).toBe("/");
    }),
  );

  it.scoped("a route that exits is set up again when it is entered again", () =>
    Effect.gen(function* () {
      const seen = homeMounts;
      const { router } = yield* start("http://app.test/");
      yield* router.navigate("/books/4");
      yield* router.navigate("/");
      yield* render;
      expect(homeMounts).toBe(seen + 2);
    }),
  );
});
