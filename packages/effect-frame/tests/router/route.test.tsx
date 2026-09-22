import { Route } from "effect-frame/router";
import { Effect, Option, Result, Schema, SchemaGetter } from "effect";
import { describe, expect, it } from "effect-bun-test";

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

const book = Route.client("book", {
  path: "/books/:id",
  params: Schema.Struct({ id: Schema.String }),
  search: Query,
  view: Blank,
});

const files = Route.client("files", {
  path: "/files/:path*",
  params: Schema.Struct({ path: Schema.Array(Schema.String) }),
  search: Nothing,
  view: Blank,
});

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

const defaults = Route.client("defaults", {
  path: "/defaults/:id",
  params: Schema.Struct({ id: Schema.String }),
  search: Defaults,
  view: DefaultsView,
});

const emptyDefaults = Route.client("empty-defaults", {
  path: "/empty-defaults",
  params: Nothing,
  search: EmptyDefault,
  view: Blank,
});

const literals = Route.client("literals", {
  path: "/literals",
  params: Nothing,
  search: LiteralSearch,
  view: Blank,
});

const tenant = Route.client("tenant", {
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
  view: Blank,
});

const remappedTenant = Route.client("remapped-tenant", {
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
  view: Blank,
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

const workspace = Route.client("workspace", {
  path: "/workspace",
  params: Nothing,
  search: Workspace,
  view: Blank,
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

const workspaceWithFilters = Route.client("workspaceWithFilters", {
  path: "/workspace-filters",
  params: Nothing,
  search: WorkspaceWithFilters,
  view: Blank,
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

  it.live("fills omitted defaults and omits equal scalar and array defaults", () =>
    Effect.gen(function* () {
      expect(defaults.href({ id: "1" }, { page: 1, panes: ["all"] })).toBe("/defaults/1");
      expect(defaults.href({ id: "1" }, { page: 2, panes: ["one", "two"] })).toBe(
        "/defaults/1?p=2&panes=one&panes=two",
      );
      expect(defaults.href({ id: "1" }, { page: 1, panes: [] })).toBe("/defaults/1?panes=%7E");
      expect(defaults.href({ id: "1" }, { page: 1, panes: [""] })).toBe("/defaults/1?panes=");
      expect(
        Schema.decodeUnknownOption(Defaults)(Route.readSearch(new URLSearchParams("panes=~"))),
      ).toEqual(Option.some({ page: 1, panes: [] }));
      expect(
        Schema.decodeUnknownOption(Defaults)(Route.readSearch(new URLSearchParams("panes="))),
      ).toEqual(Option.some({ page: 1, panes: [""] }));
      expect(emptyDefaults.href({}, { panes: [] })).toBe("/empty-defaults");
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
        defaults.hrefAt(
          new URL("http://app.test/defaults/1?panes=old&p=2&unknown=x"),
          { id: "1" },
          { page: 3, panes: ["new"] },
        ),
      ).toBe("/defaults/1?p=3&panes=new&unknown=x");
    }),
  );

  it.live("remaps keys, preserves repeated values, and prints in schema order", () =>
    Effect.sync(() => {
      expect(defaults.href({ id: "1" }, { page: 2, panes: ["one", "two"] })).toBe(
        "/defaults/1?p=2&panes=one&panes=two",
      );
      expect(workspace.href({}, { panes: ["first", "second"] })).toBe(
        "/workspace?workspace=first&workspace=second",
      );
      expect(
        workspaceWithFilters.href(
          {},
          {
            panes: [
              { q: "first", filters: "rank" },
              { q: "second", filters: "date" },
            ],
          },
        ),
      ).toBe("/workspace-filters?q=first&filters=rank&q2=second&filters2=date");
      expect(defaults.href({ id: "1" }, { page: 1, panes: ["~", "~~", ""] })).toBe(
        "/defaults/1?panes=%7E%7E&panes=%7E%7E%7E&panes=",
      );
      expect(
        Schema.decodeUnknownOption(Defaults)(
          Route.readSearch(new URLSearchParams("panes=~~&panes=~~~&panes=")),
        ),
      ).toEqual(Option.some({ page: 1, panes: ["~", "~~", ""] }));
      expect(literals.href({}, { scope: "books", scopes: ["all", "books"] })).toBe(
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
      expect(tenant.hrefAt(current, { id: "2" }, { section: "main", page: 1 })).toBe(
        "/tenant/2?tenant=acme&section=main",
      );
      expect(
        tenant.hrefAt(
          new URL("http://app.test/tenant/1?tenant=acme&section=old&page=3"),
          { id: "2" },
          { section: "main", page: 1 },
        ),
      ).toBe("/tenant/2?tenant=acme&section=main");
      expect(
        tenant.hrefAt(
          new URL("http://app.test/other?tenant=acme&page=oops"),
          { id: "2" },
          { section: "main", page: 1 },
        ),
      ).toBe("/tenant/2?tenant=acme&section=main");
      expect(
        remappedTenant.hrefAt(
          new URL("http://app.test/other?t=acme&p=oops"),
          { id: "2" },
          { section: "main", page: 1 },
        ),
      ).toBe("/remapped-tenant/2?t=acme&section=main");
      expect(
        tenant.hrefAt(current, { id: "2" }, { tenant: "other", section: "main", page: 1 }),
      ).toBe("/tenant/2?tenant=other&section=main");
      expect(tenant.hrefAt(current, { id: "2" }, { section: "main", page: 1 })).toBe(
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
