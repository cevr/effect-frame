import { registerDom } from "./dom-setup.js";

registerDom();

import type { Source } from "effect-frame/actor";
import {
  Link,
  Location,
  Route,
  Router,
  followLinks,
  link,
  mount,
  NavigationBehavior,
} from "effect-frame/router";
import type { LocationService } from "effect-frame/router";
import { Dom, View } from "effect-frame/view";
import { ViewTest } from "effect-frame/view/testing";
import type { Node } from "effect-frame/view";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Queue,
  Ref,
  Result,
  Schema,
  Stream,
} from "effect";
import { describe, expect, it } from "effect-bun-test";

/**
 * The router in a real document with a fake location. The fake records
 * every push and replace and can pop on request, so back navigation is
 * tested without a browser history.
 */

interface FakeLocation {
  readonly service: LocationService;
  readonly history: Array<string>;
  readonly awaitMove: Effect.Effect<void>;
  readonly pop: (href: string) => Effect.Effect<void>;
}

const makeLocation = (initial: string): Effect.Effect<FakeLocation> =>
  Effect.gen(function* () {
    const current = yield* Ref.make(new URL(initial));
    const pops = yield* Queue.unbounded<URL>();
    const moves = yield* Queue.unbounded<void>();
    const history: Array<string> = [];
    return {
      service: {
        current: Ref.get(current),
        push: (url) =>
          Effect.andThen(
            Ref.set(current, url),
            Effect.andThen(
              Effect.sync(() => {
                history.push(`push ${url.pathname}${url.search}`);
              }),
              Effect.succeed(Queue.offerUnsafe(moves, void 0)),
            ),
          ),
        replace: (url) =>
          Effect.andThen(
            Ref.set(current, url),
            Effect.andThen(
              Effect.sync(() => {
                history.push(`replace ${url.pathname}${url.search}`);
              }),
              Effect.succeed(Queue.offerUnsafe(moves, void 0)),
            ),
          ),
        pops: Stream.fromQueue(pops),
      },
      history,
      awaitMove: Effect.asVoid(Queue.take(moves)),
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

const textAt = (root: globalThis.Node, selector: string): string => {
  if (!(root instanceof HTMLElement)) {
    return "";
  }
  return textOf(root, selector);
};

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
    const toBook = yield* link(bookSegment, { id: "5" }, { q: "" });
    const nextBook = yield* link(bookSegment, { id: "5" }, (previous) => ({ q: `${previous.q}x` }));
    const here = yield* link(homeSegment, {}, {});
    return (
      <section id="home">
        <a id="to-book" href="/books/7">
          book
        </a>
        <a id="external" href="https://elsewhere.test/books/7">
          elsewhere
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
        <button id="go" onClick={View.event(router.replace("/books/9"))}>
          go
        </button>
      </section>
    );
  });

const Book = (
  props: Route.RouteProps<{ readonly id: string }, BookSearchValue>,
): Effect.Effect<Node, never, Router> =>
  Effect.gen(function* () {
    updateBookSearch = props.pushSearch;
    replaceBookSearch = props.replaceSearch;
    const params = yield* props.params.get;
    const nextSearch = yield* link(bookSegment, params, (previous) => ({ q: `${previous.q}x` }));
    const toHome = yield* link(homeSegment, {}, {});
    return (
      <section id="book-page">
        <h1 id="book">{View.bind(props.params, (values) => values.id)}</h1>
        <p id="book-search">{View.bind(props.search, (search) => search.q)}</p>
        <button
          id="update-search"
          onClick={View.event(props.pushSearch((previous) => ({ q: `${previous.q}a` })))}
        >
          update
        </button>
        <button
          id="replace-search"
          onClick={View.event(props.replaceSearch((previous) => ({ q: `${previous.q}r` })))}
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
const homeSegment = Route.segment("home", { path: "/", params: Nothing, search: Nothing });
const home: Route.Tree<"home", Router> = Route.client("home", Route.leaf(homeSegment, Home));
const BookParams = Schema.Struct({ id: Schema.String });
const bookSegment = Route.segment("book", {
  path: "/books/:id",
  params: BookParams,
  search: BookSearch,
});
const book: Route.Tree<"book", Router> = Route.client("book", Route.leaf(bookSegment, Book));

const start = (initial: string, routes: ReadonlyArray<Route.AnyRoute<Router>> = [home, book]) =>
  Effect.gen(function* () {
    const root = yield* makeRoot;
    const location = yield* makeLocation(initial);
    const page = yield* ViewTest.make({
      host: Dom.host,
      root,
      setup: (host, mountRoot) =>
        mount({
          landing: NavigationBehavior.Restore,
          traversalReadLimit: "3 seconds",
          routes,
          notFound: NotFound,
          host,
          root: mountRoot,
        }).pipe(Effect.provideService(Location, location.service)),
    });
    yield* followLinks(root, page.setup);
    return { root, location, router: page.setup, page };
  });

describe("router", () => {
  it.scoped("mount refuses two routes with one name, and a route named not-found", () =>
    Effect.gen(function* () {
      const other = Route.client("home", Route.leaf(bookSegment, Book));
      const twice = yield* Effect.exit(start("http://app.test/", [home, other]));
      const reservedSegment = Route.segment("not-found", {
        path: "/not-found",
        params: Nothing,
        search: Nothing,
      });
      const reserved = Route.client(
        "not-found",
        Route.leaf(reservedSegment, () => Effect.succeed(<p>reserved</p>)),
      );
      const named = yield* Effect.exit(start("http://app.test/", [home, reserved]));
      const defects = [twice, named].map((exit) =>
        Exit.match(exit, {
          onSuccess: () => "mounted",
          onFailure: (cause) => Result.getOrElse(Cause.findDefect(cause), () => "no defect"),
        }),
      );
      expect(defects).toMatchObject([
        { _tag: "RouteNameRejected", route: "home" },
        { _tag: "RouteNameRejected", route: "not-found" },
      ]);
    }),
  );

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
      const { root, router, location, page } = yield* start("http://app.test/");
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
      yield* page.waitFor({
        label: "typed link route",
        until: (actualRoot) => textAt(actualRoot, "#book") === "5",
      });
      expect((yield* router.current.get).name).toBe("book");
      expect(location.history).toEqual(["push /books/5"]);
    }),
  );

  it.scoped("a replacing link replaces the entry", () =>
    Effect.gen(function* () {
      const { root, router, location, page } = yield* start("http://app.test/books/1");
      const here = Array.from(root.querySelectorAll("a")).find((a) => a.textContent === "home");
      here?.click();
      yield* page.waitFor({
        label: "replacing link route",
        until: (actualRoot) => textAt(actualRoot, "#home") !== "",
      });
      expect((yield* router.current.get).name).toBe("home");
      expect(location.history).toEqual(["replace /"]);
    }),
  );

  it.scoped("navigate pushes and swaps the view; the previous one is gone", () =>
    Effect.gen(function* () {
      const { root, location, router, page } = yield* start("http://app.test/");
      yield* page.act(router.push("/books/3"), {
        label: "navigate to book",
        until: (actualRoot) => textAt(actualRoot, "#book") === "3",
      });
      expect(root.querySelector("#home")).toBeNull();
      expect(location.history).toEqual(["push /books/3"]);
    }),
  );

  it.scoped("a navigation within the same route stays: the view keeps its identity", () =>
    Effect.gen(function* () {
      const { root, router, page } = yield* start("http://app.test/books/1");
      const before = root.querySelector("#book");
      yield* page.act(router.push("/books/2"), {
        label: "same route params",
        until: (actualRoot) => textAt(actualRoot, "#book") === "2",
      });
      expect(root.querySelector("#book")).toBe(before);
    }),
  );

  it.scoped("a functional search update stays on the route and updates its props", () =>
    Effect.gen(function* () {
      const { root, location, router, page } = yield* start("http://app.test/books/1");
      const before = root.querySelector("#book");
      yield* page.act(
        updateBookSearch((previous) => ({ q: `${previous.q}a` })),
        {
          label: "functional search update",
          until: (actualRoot) => textAt(actualRoot, "#book-search") === "a",
        },
      );
      expect(root.querySelector("#book")).toBe(before);
      expect((yield* router.current.get).name).toBe("book");
      expect(location.history).toEqual(["push /books/1?q=a"]);
    }),
  );

  it.scoped("concurrent functional updates serialize against the latest URL", () =>
    Effect.gen(function* () {
      const { root, location, page } = yield* start("http://app.test/books/1");
      yield* Effect.all(
        [
          updateBookSearch((previous) => ({ q: `${previous.q}a` })),
          updateBookSearch((previous) => ({ q: `${previous.q}b` })),
        ],
        { concurrency: "unbounded" },
      );
      yield* page.waitFor({
        label: "concurrent search updates",
        until: (actualRoot) => textAt(actualRoot, "#book-search").length === 2,
      });
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
      yield* router.push("/");
      yield* updateBookSearch((previous) => ({ q: `${previous.q}stale` }));
      expect(location.history).toEqual(["push /"]);
      expect((yield* router.current.get).name).toBe("home");
    }),
  );

  it.scoped("a disposed route action cannot mutate a later route instance", () =>
    Effect.gen(function* () {
      const { location, router, page } = yield* start("http://app.test/books/1");
      const stale = updateBookSearch;
      const staleReplace = replaceBookSearch;
      yield* router.push("/");
      yield* router.push("/books/2?q=new");
      yield* stale((previous) => ({ q: `${previous.q}-stale` }));
      yield* staleReplace((previous) => ({ q: `${previous.q}-replace-stale` }));
      yield* page.waitFor({
        label: "new route search",
        until: (actualRoot) => textAt(actualRoot, "#book-search") === "new",
      });
      expect(location.history).toEqual(["push /", "push /books/2?q=new"]);
    }),
  );

  it.scoped("navigating to the current URL is not a move", () =>
    Effect.gen(function* () {
      const { location, router } = yield* start("http://app.test/books/1");
      yield* router.push("/books/1");
      expect(location.history).toEqual([]);
    }),
  );

  it.scoped("a same-origin link click is intercepted; a modified click is not", () =>
    Effect.gen(function* () {
      const { root, location, page } = yield* start("http://app.test/");
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
      yield* location.awaitMove;
      yield* page.waitFor({
        label: "ordinary link route",
        until: (actualRoot) => textAt(actualRoot, "#book") === "7",
      });
      expect(plain.defaultPrevented).toBe(true);
      expect(textOf(root, "#book")).toBe("7");
      expect(location.history).toEqual(["push /books/7"]);

      expect(location.history).toEqual(["push /books/7"]);
    }),
  );

  it.scoped("a link to another origin is left to the browser", () =>
    Effect.gen(function* () {
      const { root, location } = yield* start("http://app.test/");
      const anchor = Option.getOrThrow(Option.fromNullishOr(root.querySelector("#external")));
      // Registered after the router's listener on the same root, so it runs
      // after it: read its decision, then stop happy-dom from leaving the page.
      let preventedByRouter = true;
      const after = (event: Event) => {
        preventedByRouter = event.defaultPrevented;
        event.preventDefault();
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => root.addEventListener("click", after)),
        () => Effect.sync(() => root.removeEventListener("click", after)),
      );
      const plain = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
      anchor.dispatchEvent(plain);
      expect(preventedByRouter).toBe(false);
      expect(location.history).toEqual([]);
      expect(textOf(root, "#book")).toBe("");
    }),
  );

  it.scoped("a typed Link updater prints the same href it navigates", () =>
    Effect.gen(function* () {
      const { root, location, router, page } = yield* start("http://app.test/");
      const next = Option.getOrThrow(Option.fromNullishOr(root.querySelector(".next")));
      expect(next.getAttribute("href")).toBe("/books/5?q=x");
      next.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      yield* page.waitFor({
        label: "typed updater route",
        until: (actualRoot) => textAt(actualRoot, "#book") === "5",
      });
      expect((yield* router.current.get).url.search).toBe("?q=x");
      expect(location.history).toEqual(["push /books/5?q=x"]);
    }),
  );

  it.scoped("two immediate updater Link clicks compose against the latest URL", () =>
    Effect.gen(function* () {
      const { root, location, page } = yield* start("http://app.test/books/1");
      const next = Option.getOrThrow(Option.fromNullishOr(root.querySelector(".same-book")));
      expect(next.getAttribute("href")).toBe("/books/1?q=x");
      const first = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
      const second = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
      next.dispatchEvent(first);
      next.dispatchEvent(second);
      yield* page.waitFor({
        label: "composed updater route",
        until: (actualRoot) => textAt(actualRoot, "#book-search") === "xx",
      });
      expect(textOf(root, "#book-search")).toBe("xx");
      expect(location.history).toEqual(["push /books/1?q=x", "push /books/1?q=xx"]);
    }),
  );

  it.scoped("replace does not push, and the view can reach the Router", () =>
    Effect.gen(function* () {
      const { root, location, page } = yield* start("http://app.test/");
      root.querySelector("#go")?.dispatchEvent(new Event("click"));
      yield* page.waitFor({
        label: "router replace event",
        until: (actualRoot) => textAt(actualRoot, "#book") === "9",
      });
      expect(location.history).toEqual(["replace /books/9"]);
    }),
  );

  it.scoped("a pop shows the popped URL and reports it as a pop", () =>
    Effect.gen(function* () {
      const { root, location, router, page } = yield* start("http://app.test/");
      yield* router.push("/books/4");
      yield* location.pop("/");
      yield* page.waitFor({
        label: "popped home route",
        until: (actualRoot) => textAt(actualRoot, "#home") !== "",
      });
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
      const slowSegment = Route.segment("slow", {
        path: "/slow",
        params: Nothing,
        search: Nothing,
      });
      const slow = Route.client(
        "slow",
        Route.leaf(slowSegment, () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(setupStarted, void 0);
            yield* Deferred.await(releaseSetup);
            return <p id="slow">slow</p>;
          }),
        ),
      );
      const { root, location, router, page } = yield* start("http://app.test/", [home, book, slow]);

      const slowMove = yield* Effect.forkScoped(router.push("/slow"));
      yield* Deferred.await(setupStarted);
      const bookMove = yield* Effect.forkScoped(router.push("/books/2"));
      yield* location.pop("/");
      yield* Deferred.succeed(releaseSetup, void 0);
      yield* Fiber.join(slowMove);
      yield* Fiber.join(bookMove);
      yield* page.waitFor({
        label: "latest queued route",
        until: (actualRoot) => textAt(actualRoot, "#book") === "2",
      });

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
      yield* router.push("/books/4");
      yield* router.push("/");
      expect(homeMounts).toBe(seen + 2);
    }),
  );
});
