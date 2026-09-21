import { Route } from "@effect-frame/router";
import { View } from "@effect-frame/view";
import { Effect, Option, Result, Schema, SchemaGetter } from "effect";
import { describe, expect, it } from "effect-bun-test";

/**
 * A route is a codec. These tests never mount anything: they drive the
 * template, the params Schema, and the search Schema through both
 * directions and check that what prints parses back.
 */

const Nothing = Schema.Struct({});

const Blank = View.make((_props: Route.RouteProps<unknown, unknown>) => Effect.succeed(<span />));

/** `?q=a&q=b` → `{ q: "a" }`, and `{ q: "" }` prints no query at all. */
const Query = Route.SearchRecord.pipe(
  Schema.decodeTo(Schema.Struct({ q: Schema.String }), {
    decode: SchemaGetter.transform((record) => ({
      q: Option.getOrElse(
        Option.flatMap(Option.fromNullishOr(record["q"]), (values) =>
          Option.fromNullishOr(values[0]),
        ),
        () => "",
      ),
    })),
    encode: SchemaGetter.transform((search): Route.SearchRecord => {
      if (search.q === "") {
        return {};
      }
      return { q: [search.q] };
    }),
  }),
);

const book = Route.spa("book", {
  path: "/books/:id",
  params: Schema.Struct({ id: Schema.String }),
  search: Query,
  view: Blank,
});

const files = Route.spa("files", {
  path: "/files/:path*",
  params: Schema.Struct({ path: Schema.Array(Schema.String) }),
  search: Nothing,
  view: Blank,
});

const matches = (route: Route.AnyRoute<never>, href: string): boolean =>
  Option.isSome(route.enter(new URL(href, "http://app.test")));

describe("template", () => {
  it.live("parses literals, segments, and a tail", () =>
    Effect.sync(() => {
      expect(Route.parseTemplate("/books/:id/pages/:rest*")).toEqual(
        Result.succeed([
          { _tag: "Literal", text: "books" },
          { _tag: "Segment", name: "id" },
          { _tag: "Literal", text: "pages" },
          { _tag: "Tail", name: "rest" },
        ]),
      );
    }),
  );

  it.live("rejects what cannot print", () =>
    Effect.sync(() => {
      const reasons = ["/:id(\\d+)", "/*", "/:rest*/after", "/:id?"].map((template) =>
        Result.match(Route.parseTemplate(template), {
          onFailure: (rejected) => rejected.reason,
          onSuccess: () => "accepted",
        }),
      );
      expect(reasons).toEqual([
        "a regexp group cannot print; refine the param's Schema instead",
        "an unnamed wildcard has no name to print from",
        "nothing may follow a tail",
        "an optional segment is not supported yet; use a search param",
      ]);
    }),
  );
});

describe("route", () => {
  it.live("prints an href that parses back to the same values", () =>
    Effect.sync(() => {
      const href = book.href({ id: "a b" }, { q: "x&y" });
      expect(href).toBe("/books/a%20b?q=x%26y");
      expect(matches(book, href)).toBe(true);
    }),
  );

  it.live("matches the path and never the query", () =>
    Effect.sync(() => {
      expect(matches(book, "/books/1")).toBe(true);
      expect(matches(book, "/books/1?q=a&q=b&other=1")).toBe(true);
      expect(matches(book, "/books")).toBe(false);
      expect(matches(book, "/books/1/extra")).toBe(false);
      expect(matches(book, "/authors/1")).toBe(false);
    }),
  );

  it.live("an empty search prints no query string", () =>
    Effect.sync(() => {
      expect(book.href({ id: "1" }, { q: "" })).toBe("/books/1");
    }),
  );

  it.live("a tail takes the rest of the path as a list", () =>
    Effect.sync(() => {
      expect(files.href({ path: ["a", "b c"] }, {})).toBe("/files/a/b%20c");
      expect(matches(files, "/files")).toBe(true);
      expect(matches(files, "/files/a/b/c")).toBe(true);
      expect(matches(files, "/other")).toBe(false);
    }),
  );

  it.live("a segment the browser cannot decode does not match", () =>
    Effect.sync(() => {
      expect(matches(book, "/books/%E0%A4%A")).toBe(false);
    }),
  );
});
