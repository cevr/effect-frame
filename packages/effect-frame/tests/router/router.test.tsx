import { registerDom } from "./dom-setup.js";

registerDom();

import type { Source } from "effect-frame/actor";
import { Link, Location, Route, Router, followLinks, link, mount } from "effect-frame/router";
import type { LocationService } from "effect-frame/router";
import { Dom, View, render } from "effect-frame/view";
import type { Node } from "effect-frame/view";
import { Deferred, Effect, Fiber, Option, Queue, Ref, Schema, Stream } from "effect";
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
const BookSearch = Route.search(Schema.Struct({ q: Schema.String.pipe(Route.withDefault("")) }));
type BookSearchValue = (typeof BookSearch)["Type"];

let homeMounts = 0;
let updateBookSearch: (update: Route.SearchUpdater<BookSearchValue>) => Effect.Effect<void> = () =>
  Effect.void;
let replaceBookSearch: (update: Route.SearchUpdater<BookSearchValue>) => Effect.Effect<void> = () =>
  Effect.void;

const Home = (_props: Route.RouteProps<{}, {}>) =>
  Effect.gen(function* () {
    const router = yield* Router;
    homeMounts += 1;
    // A typed link: the href comes from the route's own Schemas, and
    // `active` follows the router. Declared before `book` exists at runtime
    // only in source order; the route is a module-level constant.
    const toBook = yield* link(book, { id: "5" }, { q: "" });
    const nextBook = yield* link(book, { id: "5" }, (previous) => ({ q: `${previous.q}x` }));
    const here = yield* link(home, {}, {});
    return (
      <section id="home">
        <a id="to-book" href="/books/7">
          book
        </a>
        <Link link={toBook} class="nav">
          typed
        </Link>
        <Link link={nextBook} class="next">
          next
        </Link>
        <Link link={here} replace>
          home
        </Link>
        <button id="go" onClick={View.event(() => router.replace("/books/9"))}>
          go
        </button>
      </section>
    );
  });

const Book = (
  props: Route.RouteProps<{ readonly id: string }, BookSearchValue>,
): Effect.Effect<Node, never, Router> =>
  Effect.gen(function* () {
    updateBookSearch = props.updateSearch;
    replaceBookSearch = props.replaceSearch;
    const params = yield* props.params.get;
    const nextSearch = yield* link(book, params, (previous) => ({ q: `${previous.q}x` }));
    const toHome = yield* link(home, {}, {});
    return (
      <section id="book-page">
        <h1 id="book">{View.bind(props.params, (values) => values.id)}</h1>
        <p id="book-search">{View.bind(props.search, (search) => search.q)}</p>
        <button
          id="update-search"
          onClick={View.event(() => props.updateSearch((previous) => ({ q: `${previous.q}a` })))}
        >
          update
        </button>
        <button
          id="replace-search"
          onClick={View.event(() => props.replaceSearch((previous) => ({ q: `${previous.q}r` })))}
        >
          replace
        </button>
        <Link link={nextSearch} class="same-book">
          next
        </Link>
        <Link link={toHome} replace>
          home
        </Link>
      </section>
    );
  });

const NotFound = (props: { readonly url: Source<URL> }) =>
  Effect.succeed(<p id="missing">{View.bind(props.url, (url) => url.pathname)}</p>);

// Annotated because `Home` links to `home` and `book`, and `book` to none:
// the checker would otherwise chase the cycle.
const home: Route.Route<"home", typeof Nothing, typeof Nothing, Router> = Route.client("home", {
  path: "/",
  params: Nothing,
  search: Nothing,
  view: Home,
});
const BookParams = Schema.Struct({ id: Schema.String });
const book: Route.Route<"book", typeof BookParams, typeof BookSearch, Router> = Route.client(
  "book",
  {
    path: "/books/:id",
    params: BookParams,
    search: BookSearch,
    view: Book,
  },
);

const start = (initial: string, routes: ReadonlyArray<Route.AnyRoute<Router>> = [home, book]) =>
  Effect.gen(function* () {
    const root = yield* makeRoot;
    const location = yield* makeLocation(initial);
    const router = yield* mount({
      routes,
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

  it.scoped("a typed link prints the route's href, says when it is current, and moves", () =>
    Effect.gen(function* () {
      const { root, router, location } = yield* start("http://app.test/");
      const anchors = Array.from(root.querySelectorAll("a"));
      const typed = anchors.find((a) => a.textContent === "typed");
      const next = anchors.find((a) => a.textContent === "next");
      const here = anchors.find((a) => a.textContent === "home");
      expect(typed?.getAttribute("href")).toBe("/books/5");
      expect(next?.getAttribute("href")).toBe("/books/5?q=x");
      expect(typed?.getAttribute("aria-current")).toBeNull();
      expect(here?.getAttribute("aria-current")).toBe("page");
      expect((yield* router.current.get).name).toBe("home");

      typed?.click();
      yield* render;
      expect(textOf(root, "#book")).toBe("5");
      expect((yield* router.current.get).name).toBe("book");
      expect(location.history).toEqual(["push /books/5"]);
    }),
  );

  it.scoped("a replacing link replaces the entry", () =>
    Effect.gen(function* () {
      const { root, router, location } = yield* start("http://app.test/books/1");
      const here = Array.from(root.querySelectorAll("a")).find((a) => a.textContent === "home");
      here?.click();
      yield* render;
      expect((yield* router.current.get).name).toBe("home");
      expect(location.history).toEqual(["replace /"]);
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

  it.scoped("a functional search update stays on the route and updates its props", () =>
    Effect.gen(function* () {
      const { root, location, router } = yield* start("http://app.test/books/1");
      const before = root.querySelector("#book");
      yield* updateBookSearch((previous) => ({ q: `${previous.q}a` }));
      yield* render;
      expect(textOf(root, "#book-search")).toBe("a");
      expect(root.querySelector("#book")).toBe(before);
      expect((yield* router.current.get).name).toBe("book");
      expect(location.history).toEqual(["push /books/1?q=a"]);
    }),
  );

  it.scoped("concurrent functional updates serialize against the latest URL", () =>
    Effect.gen(function* () {
      const { root, location } = yield* start("http://app.test/books/1");
      yield* Effect.all(
        [
          updateBookSearch((previous) => ({ q: `${previous.q}a` })),
          updateBookSearch((previous) => ({ q: `${previous.q}b` })),
        ],
        { concurrency: "unbounded" },
      );
      yield* render;
      const search = textOf(root, "#book-search");
      expect(search.length).toBe(2);
      expect(search.includes("a")).toBe(true);
      expect(search.includes("b")).toBe(true);
      expect(location.history.length).toBe(2);
    }),
  );

  it.scoped("replaceSearch replaces the current history entry", () =>
    Effect.gen(function* () {
      const { location } = yield* start("http://app.test/books/1");
      yield* updateBookSearch((previous) => ({ q: `${previous.q}a` }));
      yield* replaceBookSearch((previous) => ({ q: `${previous.q}r` }));
      expect(location.history).toEqual(["push /books/1?q=a", "replace /books/1?q=ar"]);
    }),
  );

  it.scoped("an update from a disposed route does not restore its old URL", () =>
    Effect.gen(function* () {
      const { location, router } = yield* start("http://app.test/books/1");
      yield* router.navigate("/");
      yield* updateBookSearch((previous) => ({ q: `${previous.q}stale` }));
      expect(location.history).toEqual(["push /"]);
      expect((yield* router.current.get).name).toBe("home");
    }),
  );

  it.scoped("a disposed route action cannot mutate a later route instance", () =>
    Effect.gen(function* () {
      const { location, router, root } = yield* start("http://app.test/books/1");
      const stale = updateBookSearch;
      const staleReplace = replaceBookSearch;
      yield* router.navigate("/");
      yield* router.navigate("/books/2?q=new");
      yield* stale((previous) => ({ q: `${previous.q}-stale` }));
      yield* staleReplace((previous) => ({ q: `${previous.q}-replace-stale` }));
      yield* render;
      expect(textOf(root, "#book-search")).toBe("new");
      expect(location.history).toEqual(["push /", "push /books/2?q=new"]);
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
      const anchor = Option.getOrThrow(Option.fromNullishOr(root.querySelector("#to-book")));
      const updater = Option.getOrThrow(Option.fromNullishOr(root.querySelector(".next")));
      const modified = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
      updater.dispatchEvent(modified);
      const middle = new MouseEvent("click", { bubbles: true, cancelable: true, button: 1 });
      updater.dispatchEvent(middle);
      expect(modified.defaultPrevented).toBe(false);
      expect(middle.defaultPrevented).toBe(false);

      const plain = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
      anchor.dispatchEvent(plain);
      yield* render;
      expect(plain.defaultPrevented).toBe(true);
      expect(textOf(root, "#book")).toBe("7");
      expect(location.history).toEqual(["push /books/7"]);

      yield* render;
      expect(location.history).toEqual(["push /books/7"]);
    }),
  );

  it.scoped("a typed Link updater prints the same href it navigates", () =>
    Effect.gen(function* () {
      const { root, location, router } = yield* start("http://app.test/");
      const next = Option.getOrThrow(Option.fromNullishOr(root.querySelector(".next")));
      expect(next.getAttribute("href")).toBe("/books/5?q=x");
      next.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      yield* render;
      expect((yield* router.current.get).url.search).toBe("?q=x");
      expect(location.history).toEqual(["push /books/5?q=x"]);
    }),
  );

  it.scoped("two immediate updater Link clicks compose against the latest URL", () =>
    Effect.gen(function* () {
      const { root, location } = yield* start("http://app.test/books/1");
      const next = Option.getOrThrow(Option.fromNullishOr(root.querySelector(".same-book")));
      expect(next.getAttribute("href")).toBe("/books/1?q=x");
      const first = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
      const second = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
      next.dispatchEvent(first);
      next.dispatchEvent(second);
      yield* render;
      expect(textOf(root, "#book-search")).toBe("xx");
      expect(location.history).toEqual(["push /books/1?q=x", "push /books/1?q=xx"]);
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

  it.scoped("a stale pop does not override a later queued push", () =>
    Effect.gen(function* () {
      const setupStarted = yield* Deferred.make<void>();
      const releaseSetup = yield* Deferred.make<void>();
      const slow = Route.client("slow", {
        path: "/slow",
        params: Nothing,
        search: Nothing,
        view: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(setupStarted, void 0);
            yield* Deferred.await(releaseSetup);
            return <p id="slow">slow</p>;
          }),
      });
      const { root, location, router } = yield* start("http://app.test/", [home, book, slow]);

      const slowMove = yield* Effect.forkScoped(router.navigate("/slow"));
      yield* Deferred.await(setupStarted);
      const bookMove = yield* Effect.forkScoped(router.navigate("/books/2"));
      yield* location.pop("/");
      yield* Deferred.succeed(releaseSetup, void 0);
      yield* Fiber.join(slowMove);
      yield* Fiber.join(bookMove);
      yield* render;

      expect(textOf(root, "#book")).toBe("2");
      expect(textOf(root, "#home")).toBe("");
      expect(location.history).toEqual(["push /slow", "push /books/2"]);
      expect((yield* router.current.get).url.pathname).toBe("/books/2");
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
