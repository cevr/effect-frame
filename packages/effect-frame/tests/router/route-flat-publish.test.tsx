import { registerDom } from "./dom-setup.js";

registerDom();

import type { Source } from "effect-frame/actor";
import * as Frame from "effect-frame/frame";
import { Location, Route, mount } from "effect-frame/router";
import type { LocationService } from "effect-frame/router";
import { Dom, View, ViewTest } from "effect-frame/view";
import { Effect, Ref, Schema, Stream } from "effect";
import { describe, expect, it } from "effect-bun-test";

/**
 * The publish rule of a flat route's `params` and `search` (see
 * `docs/design/route-public.md`, "Migration for flat routes"). A flat
 * route is a one-leaf tree, so a stayed navigation publishes both Sources
 * only when the raw path record or the encoded search of the route changes.
 */

const BookParams = Schema.Struct({ id: Schema.String });
const BookSearch = Route.search(Schema.Struct({ q: Schema.String.pipe(Route.withDefault("")) }));

const makeBook = (published: Ref.Ref<ReadonlyArray<string>>) =>
  Route.client("book", {
    path: "/books/:id",
    params: BookParams,
    search: BookSearch,
    view: (props) =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          Stream.runForEach(props.params.changes, (params) =>
            Ref.update(published, (all) => [...all, `params ${params.id}`]),
          ),
        );
        yield* Effect.forkScoped(
          Stream.runForEach(props.search.changes, (search) =>
            Ref.update(published, (all) => [...all, `search ${search.q}`]),
          ),
        );
        return <h1 id="book">{View.bind(props.params, (params) => params.id)}</h1>;
      }),
  });

const NotFound = (props: { readonly url: Source<URL> }) =>
  Effect.succeed(<p id="missing">{View.bind(props.url, (url) => url.pathname)}</p>);

const fakeLocation = (initial: string) =>
  Effect.gen(function* () {
    const current = yield* Ref.make(new URL(initial));
    const service: LocationService = {
      current: Ref.get(current),
      push: (url) => Ref.set(current, url),
      replace: (url) => Ref.set(current, url),
      pops: Stream.never,
    };
    return service;
  });

/** Lets every forked consumer read what the commit published. */
const settle = Effect.forEach(Array.from({ length: 40 }), () => Effect.yieldNow, {
  discard: true,
});

describe("flat route publish rule", () => {
  it.scoped.layer(Frame.layer({ name: "flat-publish" }))(
    "publishes params and search together, only when the raw path or the encoded search changes",
    () =>
      Effect.gen(function* () {
        const published = yield* Ref.make<ReadonlyArray<string>>([]);
        /** What was published since the last read, in a stable order. */
        const drain = Effect.map(Ref.getAndSet(published, []), (all) => all.toSorted());
        const root = document.createElement("main");
        document.body.append(root);
        const location = yield* fakeLocation("http://app.test/books/5?q=a");
        const page = yield* ViewTest.make({
          host: Dom.host,
          root,
          setup: (host, mountRoot) =>
            mount({
              routes: [makeBook(published)],
              notFound: NotFound,
              host,
              root: mountRoot,
            }).pipe(Effect.provideService(Location, location)),
        });
        const after = (href: string) =>
          Effect.gen(function* () {
            yield* page.setup.navigate(href);
            yield* settle;
            return yield* drain;
          });
        yield* settle;
        expect(yield* drain).toEqual(["params 5", "search a"]);

        // The hash, an unrelated key, and a reordered query publish nothing.
        expect(yield* after("/books/5?q=a#h")).toEqual([]);
        expect(yield* after("/books/5?q=a&x=1")).toEqual([]);
        expect(yield* after("/books/5?x=1&q=a")).toEqual([]);
        // A search change publishes both Sources, params unchanged.
        expect(yield* after("/books/5?q=b")).toEqual(["params 5", "search b"]);
        // The raw path record is compared, so "05" differs from "5".
        expect(yield* after("/books/05?q=b")).toEqual(["params 05", "search b"]);
        expect(yield* after("/books/6?q=b")).toEqual(["params 6", "search b"]);
        // The same URL is not a move.
        expect(yield* after("/books/6?q=b")).toEqual([]);
        // A missing key decodes to its default, which encodes differently.
        expect(yield* after("/books/6")).toEqual(["params 6", "search "]);
        // An empty value and a missing key decode and encode the same.
        expect(yield* after("/books/6?q=")).toEqual([]);
      }),
  );
});
