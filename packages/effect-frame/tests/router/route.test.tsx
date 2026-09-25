import { Route } from "effect-frame/router";
import { Effect, Option, Predicate, Result, Schema, SchemaGetter } from "effect";
import { Arbitrary } from "effect/unstable/arbitrary";
import { describe, expect, it } from "effect-bun-test";
import { address } from "../../src/router/codec.js";

/**
 * A route is a codec. These tests never mount anything: they drive the
 * template, the params Schema, and the search Schema through both
 * directions and check that what prints parses back.
 */

const Nothing = Schema.Struct({});

const Blank = <Params, Search>(_props: Route.RouteProps<Params, Search>) =>
  Effect.succeed(<span />);

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

const bookSegment = Route.segment("book", {
  path: "/books/:id",
  params: Schema.Struct({ id: Schema.String }),
  search: Query,
});
const book = Route.client("book", Route.leaf(bookSegment, Blank));

const filesSegment = Route.segment("files", {
  path: "/files/:path*",
  params: Schema.Struct({ path: Schema.Array(Schema.String) }),
  search: Nothing,
});
const files = Route.client("files", Route.leaf(filesSegment, Blank));

const Defaults = Route.search(
  Schema.Struct({
    page: Schema.FiniteFromString.pipe(Route.withDefault(1)),
    panes: Schema.Array(Schema.String).pipe(Route.withDefault(["all"])),
  }).pipe(Schema.encodeKeys({ page: "p" })),
);

const EmptyDefault = Route.search(
  Schema.Struct({ panes: Schema.Array(Schema.String).pipe(Route.withDefault([])) }),
);

const LiteralSearch = Route.search(
  Schema.Struct({
    scope: Schema.Literals(["all", "books"]),
    scopes: Schema.Array(Schema.Literals(["all", "books"])),
  }),
);

// @ts-expect-error a default must be accepted by the schema it decorates
const wrongArrayDefault = () => Schema.Array(Schema.String).pipe(Route.withDefault(1));
void wrongArrayDefault;

const validUnionDefault = (value: "all" | "books") =>
  Schema.Literals(["all", "books"]).pipe(Route.withDefault(value));
void validUnionDefault;

const wrongUnionDefault = (value: string | number) =>
  // @ts-expect-error a default union cannot include a value outside the schema
  Schema.String.pipe(Route.withDefault(value));
void wrongUnionDefault;

const wrongSearchFields = () => {
  // @ts-expect-error numeric array fields are outside Route.search's URL vocabulary
  Route.search(Schema.Struct({ values: Schema.Array(Schema.Finite) }));
  // @ts-expect-error numeric tuple fields are outside Route.search's URL vocabulary
  Route.search(Schema.Struct({ values: Schema.Tuple([Schema.Finite]) }));
};
void wrongSearchFields;

const capturedSearch: Array<unknown> = [];
const DefaultsView = <Params, Search>(props: Route.RouteProps<Params, Search>) =>
  Effect.gen(function* () {
    capturedSearch.push(yield* props.search.get);
    return <span />;
  });

const defaultsSegment = Route.segment("defaults", {
  path: "/defaults/:id",
  params: Schema.Struct({ id: Schema.String }),
  search: Defaults,
});
const defaults = Route.client("defaults", Route.leaf(defaultsSegment, DefaultsView));

const emptyDefaultsSegment = Route.segment("empty-defaults", {
  path: "/empty-defaults",
  params: Nothing,
  search: EmptyDefault,
});

const literalsSegment = Route.segment("literals", {
  path: "/literals",
  params: Nothing,
  search: LiteralSearch,
});

const tenantSegment = Route.segment("tenant", {
  path: "/tenant/:id",
  params: Schema.Struct({ id: Schema.String }),
  search: Route.search(
    Schema.Struct({
      tenant: Schema.optionalKey(Schema.String),
      section: Schema.String,
      page: Schema.FiniteFromString.pipe(Route.withDefault(1)),
    }),
  ),
  retain: ["tenant", "page"],
});

const remappedTenantSegment = Route.segment("remapped-tenant", {
  path: "/remapped-tenant/:id",
  params: Schema.Struct({ id: Schema.String }),
  search: Route.search(
    Schema.Struct({
      tenant: Schema.optionalKey(Schema.String),
      section: Schema.String,
      page: Schema.FiniteFromString.pipe(Route.withDefault(1)),
    }).pipe(Schema.encodeKeys({ tenant: "t", page: "p" })),
  ),
  retain: ["tenant"],
});

const Workspace = Route.SearchRecord.pipe(
  Schema.decodeTo(Schema.Struct({ panes: Schema.Array(Schema.String) }), {
    decode: SchemaGetter.transform((record) => ({
      panes: Option.getOrElse(Option.fromNullishOr(record["workspace"]), () => []),
    })),
    encode: SchemaGetter.transform((search): Route.SearchRecord => ({
      workspace: [...search.panes],
    })),
  }),
);

const workspaceSegment = Route.segment("workspace", {
  path: "/workspace",
  params: Nothing,
  search: Workspace,
});

const suffixOf = (index: number): string => {
  if (index === 0) {
    return "";
  }
  return String(index + 1);
};

const WorkspaceWithFilters = Route.SearchRecord.pipe(
  Schema.decodeTo(
    Schema.Struct({
      panes: Schema.Array(Schema.Struct({ q: Schema.String, filters: Schema.String })),
    }),
    {
      decode: SchemaGetter.transform((record) => ({
        panes: ["", ""].map((_, index) => {
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
      encode: SchemaGetter.transform((search): Route.SearchRecord => {
        const encoded: Record<string, Array<string>> = {};
        for (const [index, pane] of search.panes.entries()) {
          const suffix = suffixOf(index);
          encoded[`q${suffix}`] = [pane.q];
          encoded[`filters${suffix}`] = [pane.filters];
        }
        return encoded;
      }),
    },
  ),
);

const workspaceWithFiltersSegment = Route.segment("workspaceWithFilters", {
  path: "/workspace-filters",
  params: Nothing,
  search: WorkspaceWithFilters,
});

const Filters = Schema.Struct({
  filter: Schema.Struct({ sort: Schema.String }).pipe(Route.withDefault({ sort: "rank" })),
});
const encodedFilterDefault = Schema.encodeSync(Filters)({ filter: { sort: "rank" } });
const encodedFilterOther = Schema.encodeSync(Filters)({ filter: { sort: "date" } });

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
      const href = bookSegment.href({ id: "a b" }, { q: "x&y" });
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
      expect(bookSegment.href({ id: "1" }, { q: "" })).toBe("/books/1");
    }),
  );

  it.live("a tail takes the rest of the path as a list", () =>
    Effect.sync(() => {
      expect(filesSegment.href({ path: ["a", "b c"] }, {})).toBe("/files/a/b%20c");
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

  it.scoped("fills omitted defaults and omits equal scalar and array defaults", () =>
    Effect.gen(function* () {
      expect(defaultsSegment.href({ id: "1" }, { page: 1, panes: ["all"] })).toBe("/defaults/1");
      expect(defaultsSegment.href({ id: "1" }, { page: 2, panes: ["one", "two"] })).toBe(
        "/defaults/1?p=2&panes=one&panes=two",
      );
      expect(defaultsSegment.href({ id: "1" }, { page: 1, panes: [] })).toBe(
        "/defaults/1?panes=%7E",
      );
      expect(defaultsSegment.href({ id: "1" }, { page: 1, panes: [""] })).toBe(
        "/defaults/1?panes=",
      );
      expect(
        Schema.decodeUnknownOption(Defaults)(Route.readSearch(new URLSearchParams("panes=~"))),
      ).toEqual(Option.some({ page: 1, panes: [] }));
      expect(
        Schema.decodeUnknownOption(Defaults)(Route.readSearch(new URLSearchParams("panes="))),
      ).toEqual(Option.some({ page: 1, panes: [""] }));
      expect(emptyDefaultsSegment.href({}, { panes: [] })).toBe("/empty-defaults");
      expect(Schema.decodeUnknownOption(EmptyDefault)({})).toEqual(Option.some({ panes: [] }));

      const entered = yield* Option.getOrThrow(
        defaults.enter(new URL("http://app.test/defaults/1")),
      );
      yield* Effect.scoped(entered.setup);
      expect(capturedSearch).toEqual([{ page: 1, panes: ["all"] }]);
    }),
  );

  it.live("uses codec key order when updating an existing query", () =>
    Effect.sync(() => {
      expect(
        defaultsSegment.hrefAt(
          new URL("http://app.test/defaults/1?panes=old&p=2&unknown=x"),
          { id: "1" },
          { page: 3, panes: ["new"] },
        ),
      ).toBe("/defaults/1?p=3&panes=new&unknown=x");
    }),
  );

  it.live("remaps keys, preserves repeated values, and prints in schema order", () =>
    Effect.sync(() => {
      expect(defaultsSegment.href({ id: "1" }, { page: 2, panes: ["one", "two"] })).toBe(
        "/defaults/1?p=2&panes=one&panes=two",
      );
      expect(workspaceSegment.href({}, { panes: ["first", "second"] })).toBe(
        "/workspace?workspace=first&workspace=second",
      );
      expect(
        workspaceWithFiltersSegment.href(
          {},
          {
            panes: [
              { q: "first", filters: "rank" },
              { q: "second", filters: "date" },
            ],
          },
        ),
      ).toBe("/workspace-filters?q=first&filters=rank&q2=second&filters2=date");
      expect(defaultsSegment.href({ id: "1" }, { page: 1, panes: ["~", "~~", ""] })).toBe(
        "/defaults/1?panes=%7E%7E&panes=%7E%7E%7E&panes=",
      );
      expect(
        Schema.decodeUnknownOption(Defaults)(
          Route.readSearch(new URLSearchParams("panes=~~&panes=~~~&panes=")),
        ),
      ).toEqual(Option.some({ page: 1, panes: ["~", "~~", ""] }));
      expect(literalsSegment.href({}, { scope: "books", scopes: ["all", "books"] })).toBe(
        "/literals?scope=books&scopes=all&scopes=books",
      );
      expect(
        Schema.decodeUnknownOption(LiteralSearch)(
          Route.readSearch(new URLSearchParams("scope=books&scopes=all&scopes=books")),
        ),
      ).toEqual(Option.some({ scope: "books", scopes: ["all", "books"] }));
    }),
  );

  it.live("retains decoded keys across routes and lets explicit values clear defaults", () =>
    Effect.sync(() => {
      const current = new URL("http://app.test/other?tenant=acme&page=4");
      expect(tenantSegment.hrefAt(current, { id: "2" }, { section: "main", page: 1 })).toBe(
        "/tenant/2?tenant=acme&section=main",
      );
      expect(
        tenantSegment.hrefAt(
          new URL("http://app.test/tenant/1?tenant=acme&section=old&page=3"),
          { id: "2" },
          { section: "main", page: 1 },
        ),
      ).toBe("/tenant/2?tenant=acme&section=main");
      expect(
        tenantSegment.hrefAt(
          new URL("http://app.test/other?tenant=acme&page=oops"),
          { id: "2" },
          { section: "main", page: 1 },
        ),
      ).toBe("/tenant/2?tenant=acme&section=main");
      expect(
        remappedTenantSegment.hrefAt(
          new URL("http://app.test/other?t=acme&p=oops"),
          { id: "2" },
          { section: "main", page: 1 },
        ),
      ).toBe("/remapped-tenant/2?t=acme&section=main");
      expect(
        tenantSegment.hrefAt(current, { id: "2" }, { tenant: "other", section: "main", page: 1 }),
      ).toBe("/tenant/2?tenant=other&section=main");
      expect(tenantSegment.hrefAt(current, { id: "2" }, { section: "main", page: 1 })).toBe(
        "/tenant/2?tenant=acme&section=main",
      );
    }),
  );

  it.live("builds search records without prototype-key collisions", () =>
    Effect.sync(() => {
      const record = Route.readSearch(
        new URLSearchParams("__proto__=x&constructor=y&constructor=z"),
      );
      expect(Object.getPrototypeOf(record)).toBeNull();
      expect(record["__proto__"]).toEqual(["x"]);
      expect(record["constructor"]).toEqual(["y", "z"]);
    }),
  );

  it.live("refuses search fields that cannot be URL strings", () =>
    Effect.sync(() => {
      expect(() => Route.search(Schema.Struct({ enabled: Schema.Boolean }))).toThrow();
      expect(() => Route.search(Schema.Record(Schema.String, Schema.String))).toThrow();
    }),
  );

  it.live("uses Schema equivalence for allocated structured defaults", () =>
    Effect.sync(() => {
      expect(encodedFilterDefault).toEqual({});
      expect(encodedFilterOther).toEqual({ filter: { sort: "date" } });
    }),
  );
});

/**
 * #18 row "A route prints what it parses", as a property over the Schemas a
 * public route accepts: `Schema.String` params, a tail of strings, a coerced
 * number, and a search of strings, arrays, defaults, and literals.
 *
 * The route domain is what a URL carries both ways. A path segment is
 * well-formed text that is not empty and not `.` or `..`; a search key or
 * value is well-formed text. Inside it, `parse(href(params, search))` is the
 * same values. Outside it, `href` is the `UrlValueRejected` defect, never a
 * wrong URL. See `docs/design/route-data.md`.
 */
const PropertySearch = Route.search(
  Schema.Struct({
    q: Schema.String.pipe(Route.withDefault("")),
    page: Schema.FiniteFromString.pipe(Route.withDefault(1)),
    tags: Schema.Array(Schema.String).pipe(Route.withDefault([])),
    scope: Schema.Literals(["all", "books"]).pipe(Route.withDefault("all")),
  }).pipe(Schema.encodeKeys({ page: "p" })),
);

const templates = [
  { template: "/books/:id", params: Schema.Struct({ id: Schema.String }) },
  // A literal with URL syntax in it prints escaped.
  { template: "/c#s?/:id", params: Schema.Struct({ id: Schema.String }) },
  { template: "/pages/:page", params: Schema.Struct({ page: Schema.FiniteFromString }) },
  { template: "/files/:rest*", params: Schema.Struct({ rest: Schema.Array(Schema.String) }) },
  {
    // A nested segment's whole path: its parent's parts, then its own.
    template: "/app/:tenant/posts/:postId",
    params: Schema.Struct({ tenant: Schema.String, postId: Schema.String }),
  },
];

type UrlValueRejected = Route.UrlValueRejected;
const isRejected = Schema.is(Route.UrlValueRejected);

const loneSurrogate = /\p{Cs}/u;
const segmentInDomain = (value: string) =>
  value !== "" && value !== "." && value !== ".." && !loneSurrogate.test(value);

/** Whether every encoded path segment and search text is in the route domain. */
const inDomain = (path: Route.PathRecord, query: Route.SearchRecord): boolean =>
  Object.values(path).every((value) => {
    if (Predicate.isString(value)) {
      return segmentInDomain(value);
    }
    return value.every(segmentInDomain);
  }) &&
  Object.entries(query).every(
    ([key, values]) =>
      !loneSurrogate.test(key) && values.every((value) => !loneSurrogate.test(value)),
  );

/** The href, or the defect it died with. */
const printed = (print: () => string): Effect.Effect<string | UrlValueRejected> =>
  Effect.sync(print).pipe(
    Effect.catchDefect((defect) => {
      if (isRejected(defect)) {
        return Effect.succeed(defect);
      }
      return Effect.die(defect);
    }),
  );

describe("a route prints what it parses (#18)", () => {
  for (const sample of templates) {
    const decodeParams = Schema.decodeUnknownOption(sample.params);
    const encodeParams = Schema.encodeSync(sample.params);
    it.effect(
      `parse(href(params, search)) is the same values, or href refuses: ${sample.template}`,
      () =>
        Effect.gen(function* () {
          const parts = Result.getOrThrow(Route.parseTemplate(sample.template));
          const printer = address(parts, {
            decodeParams,
            encodeParams,
            search: PropertySearch,
            searchKeys: Option.none(),
            retain: Option.none(),
          });
          const values = Schema.Struct({ params: sample.params, search: PropertySearch });
          const same = Schema.toEquivalence(Schema.toType(values));
          const encode = Schema.encodeEffect(values);
          const result = yield* Arbitrary.checkEffect(
            Arbitrary.schema(Schema.toType(values)),
            (drawn) =>
              Effect.map(
                Effect.all([
                  printed(() => printer.href(drawn.params, drawn.search)),
                  Effect.orDie(encode(drawn)),
                ]),
                ([href, encoded]) => {
                  if (!inDomain(encoded.params, encoded.search)) {
                    return isRejected(href);
                  }
                  return (
                    Predicate.isString(href) &&
                    Option.exists(printer.parse(new URL(href, "http://app.test")), (parsed) =>
                      same(parsed, drawn),
                    )
                  );
                },
              ),
            { runs: 300, seed: 18 },
          );
          expect(Arbitrary.formatCheckFailure(result)).toBeUndefined();
        }),
    );
  }

  it.effect("href refuses each value a URL cannot carry both ways, and names the param", () =>
    Effect.gen(function* () {
      const refusal = (print: () => string) =>
        Effect.map(printed(print), (outcome) => {
          if (isRejected(outcome)) {
            return { name: outcome.name, reason: outcome.reason };
          }
          return { href: outcome };
        });
      expect(yield* refusal(() => bookSegment.href({ id: "" }, { q: "" }))).toEqual({
        name: "id",
        reason: "empty segment",
      });
      expect(yield* refusal(() => bookSegment.href({ id: "." }, { q: "" }))).toEqual({
        name: "id",
        reason: "dot segment",
      });
      expect(yield* refusal(() => bookSegment.href({ id: ".." }, { q: "" }))).toEqual({
        name: "id",
        reason: "dot segment",
      });
      expect(yield* refusal(() => bookSegment.href({ id: "a\uD800" }, { q: "" }))).toEqual({
        name: "id",
        reason: "lone surrogate",
      });
      expect(yield* refusal(() => filesSegment.href({ path: ["a", "", "b"] }, {}))).toEqual({
        name: "path",
        reason: "empty segment",
      });
      expect(yield* refusal(() => bookSegment.href({ id: "1" }, { q: "\uDC00" }))).toEqual({
        name: "q",
        reason: "lone surrogate",
      });
      // Inside the domain, the same shapes print and parse back.
      expect(yield* refusal(() => bookSegment.href({ id: ".a" }, { q: "" }))).toEqual({
        href: "/books/.a",
      });
      expect(yield* refusal(() => filesSegment.href({ path: [] }, {}))).toEqual({ href: "/files" });
      expect(yield* refusal(() => bookSegment.href({ id: "\uD83D\uDE00" }, { q: "" }))).toEqual({
        href: "/books/%F0%9F%98%80",
      });
    }),
  );

  it.live("parse refuses what href refuses: an encoded dot, an empty tail item, a bad escape", () =>
    Effect.sync(() => {
      const bookParts = Result.getOrThrow(Route.parseTemplate("/books/:id"));
      const tailParts = Result.getOrThrow(Route.parseTemplate("/files/:path*"));
      // A raw pathname, as a server adapter may pass it: no URL parser ran.
      expect(Route.matchPath(bookParts, "/books/%2E")).toEqual(Option.none());
      expect(Route.matchPath(bookParts, "/books/%2E%2E")).toEqual(Option.none());
      expect(Route.matchPath(bookParts, "/books/%ED%A0%80")).toEqual(Option.none());
      expect(Route.matchPath(tailParts, "/files/a/%2E/b")).toEqual(Option.none());
      expect(Route.matchPath(bookParts, "/books/.a")).toEqual(Option.some({ id: ".a" }));
      // An empty segment is no segment, both ways: href refuses to print one,
      // and parse reads `a//b` as the two segments it holds.
      expect(Route.matchPath(tailParts, "/files/a//b")).toEqual(Option.some({ path: ["a", "b"] }));
    }),
  );

  it.live("a search reorder and an absent optional key still match, with the same values", () =>
    Effect.sync(() => {
      const listingSegment = Route.segment("listing", {
        path: "/list",
        params: Nothing,
        search: Route.search(
          Schema.Struct({ a: Schema.String, b: Schema.String.pipe(Route.withDefault("none")) }),
        ),
      });
      const listing = Route.client("listing", Route.leaf(listingSegment, Blank));
      const at = (query: string) => new URL(`/list${query}`, "http://app.test");
      expect(
        ["?a=1&b=2", "?b=2&a=1", "?a=1"].map((query) => matches(listing, `/list${query}`)),
      ).toEqual([true, true, true]);
      expect(listingSegment.searchAt(at("?a=1&b=2"))).toEqual({ a: "1", b: "2" });
      expect(listingSegment.searchAt(at("?b=2&a=1"))).toEqual({ a: "1", b: "2" });
      expect(listingSegment.searchAt(at("?a=1"))).toEqual({ a: "1", b: "none" });
    }),
  );
});
