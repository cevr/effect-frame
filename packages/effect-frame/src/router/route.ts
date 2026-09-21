import type { Source } from "effect-frame/actor";
import { select } from "effect-frame/actor/client";
import type { Node, View } from "effect-frame/view";
import type { Scope } from "effect";
import { Effect, Option, Predicate, Result, Schema, SchemaGetter, SubscriptionRef } from "effect";

/**
 * A route is a bidirectional codec for a URL plus the view that URL shows
 * (#18). Both halves are data: the template is parsed once into parts that
 * print as well as match, and the params and search carry Schemas that
 * decode and encode. Nothing in a route runs; the router runs it.
 *
 * The URLPattern grammar is the notation and the URLPattern object is not
 * used: the object only parses, and a router needs to print.
 */

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

/** One piece of a path template. */
export type Part =
  | { readonly _tag: "Literal"; readonly text: string }
  | { readonly _tag: "Segment"; readonly name: string }
  | { readonly _tag: "Tail"; readonly name: string };

/** A template the grammar accepts but the router cannot print. */
export class TemplateRejected extends Schema.TaggedError<TemplateRejected>()("TemplateRejected", {
  template: Schema.String,
  reason: Schema.String,
}) {}

const reject = (template: string, reason: string) =>
  Result.fail(TemplateRejected.make({ template, reason }));

const partOf = (template: string, raw: string): Result.Result<Part, TemplateRejected> => {
  if (raw === "*") {
    return reject(template, "an unnamed wildcard has no name to print from");
  }
  if (raw.includes("(")) {
    return reject(template, "a regexp group cannot print; refine the param's Schema instead");
  }
  if (!raw.startsWith(":")) {
    return Result.succeed({ _tag: "Literal", text: raw });
  }
  if (raw.endsWith("*")) {
    return Result.succeed({ _tag: "Tail", name: raw.slice(1, -1) });
  }
  if (raw.endsWith("?")) {
    return reject(template, "an optional segment is not supported yet; use a search param");
  }
  return Result.succeed({ _tag: "Segment", name: raw.slice(1) });
};

/**
 * Parse a template into parts. Rejected, not diagnosed: a regexp group and
 * an unnamed wildcard cannot print, and nothing may follow a tail because
 * the tail would swallow it silently.
 */
export const parseTemplate = (
  template: string,
): Result.Result<ReadonlyArray<Part>, TemplateRejected> => {
  const parts: Array<Part> = [];
  for (const raw of segmentsOf(template)) {
    const last = Option.fromNullishOr(parts[parts.length - 1]);
    if (Option.exists(last, (part) => part._tag === "Tail")) {
      return reject(template, "nothing may follow a tail");
    }
    const part = partOf(template, raw);
    if (Result.isFailure(part)) {
      return Result.fail(part.failure);
    }
    parts.push(part.success);
  }
  return Result.succeed(parts);
};

const segmentsOf = (path: string): ReadonlyArray<string> =>
  path.split("/").filter((segment) => segment !== "");

const decodeSegment = Option.liftThrowable(decodeURIComponent);

/** What the path parts decode to, before the params Schema sees it. */
export const PathRecord = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Array(Schema.String)]),
);
export type PathRecord = Schema.Schema.Type<typeof PathRecord>;

/** Match a pathname against parts. Every segment is percent-decoded first. */
export const matchPath = (
  parts: ReadonlyArray<Part>,
  pathname: string,
): Option.Option<PathRecord> => {
  const segments = segmentsOf(pathname);
  const record: Record<string, string | ReadonlyArray<string>> = {};
  let index = 0;
  for (const part of parts) {
    if (part._tag === "Tail") {
      const rest = Option.all(segments.slice(index).map(decodeSegment));
      if (Option.isNone(rest)) {
        return Option.none();
      }
      record[part.name] = rest.value;
      index = segments.length;
      continue;
    }
    const segment = Option.flatMap(Option.fromNullishOr(segments[index]), decodeSegment);
    if (Option.isNone(segment)) {
      return Option.none();
    }
    index += 1;
    if (part._tag === "Literal") {
      if (segment.value !== part.text) {
        return Option.none();
      }
      continue;
    }
    record[part.name] = segment.value;
  }
  if (index !== segments.length) {
    return Option.none();
  }
  return Option.some(record);
};

/** Print parts from a record. Total for a record the params Schema produced. */
export const printPath = (parts: ReadonlyArray<Part>, record: PathRecord): string => {
  const printed = parts.flatMap((part): ReadonlyArray<string> => {
    if (part._tag === "Literal") {
      return [encodeURIComponent(part.text)];
    }
    const value = Option.getOrThrowWith(Option.fromNullishOr(record[part.name]), () =>
      TemplateRejected.make({
        template: part.name,
        reason: "the params Schema produced no value for this part",
      }),
    );
    if (Array.isArray(value)) {
      return value.map(encodeURIComponent);
    }
    return [encodeURIComponent(String(value))];
  });
  return `/${printed.join("/")}`;
};

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * The query string as a keyed multimap. Search params never take part in
 * matching: two URLs that differ only in their query match the same route
 * with different search values, so a filter change is a stayed transition.
 */
export const SearchRecord = Schema.Record(Schema.String, Schema.Array(Schema.String));
export type SearchRecord = Schema.Schema.Type<typeof SearchRecord>;

export class SearchSchemaRejected extends Schema.TaggedError<SearchSchemaRejected>()(
  "SearchSchemaRejected",
  { reason: Schema.String },
) {}

export const readSearch = (params: URLSearchParams): SearchRecord => {
  const record: Record<string, Array<string>> = Object.create(null);
  for (const [key, value] of params) {
    const target = Option.getOrElse(Option.fromNullishOr(record[key]), () => {
      const created: Array<string> = [];
      record[key] = created;
      return created;
    });
    target.push(value);
  }
  return record;
};

/** Print a record back, keeping declared or custom codec key order. */
export const printSearch = (record: SearchRecord, order: ReadonlyArray<string> = []): string => {
  const params = new URLSearchParams();
  const keys = [...order, ...Object.keys(record).filter((key) => !order.includes(key))];
  for (const key of keys) {
    const values = Option.getOrElse(Option.fromNullishOr(record[key]), () => []);
    for (const value of values) {
      params.append(key, value);
    }
  }
  const printed = params.toString();
  if (printed === "") {
    return "";
  }
  return `?${printed}`;
};

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

/** A params Schema: decodes the matched path record, encodes back to it. */
export type ParamsCodec = Schema.Codec<unknown, PathRecord>;
/** A search Schema: decodes the query multimap, encodes back to it. */
export type SearchCodec = Schema.Codec<unknown, SearchRecord>;

/** A URL-level updater that is evaluated after earlier queued mutations. */
export type UrlUpdater = (current: URL) => string;

/** The router operations a mounted route gives to its own view. */
export interface RouteNavigation {
  readonly navigate: (href: string | UrlUpdater) => Effect.Effect<void>;
  readonly replace: (href: string | UrlUpdater) => Effect.Effect<void>;
}

/** A functional update over one route's decoded search value. */
export type SearchUpdater<Search> = (previous: Search) => Search;

/**
 * Give a search field a decoding default and omit that value when encoding.
 *
 * Effect RC.115 exposes `withDecodingDefaultTypeKey`, but its `omit` strategy
 * omits every encoded value. URL state needs the default value omitted only,
 * so this small field combinator keeps the actual Schema codec as the single
 * source of both parsing and printing.
 */
export const withDefault =
  <A>(defaultValue: A) =>
  <S extends Schema.ConstraintCodec<A | Readonly<A>, unknown, never, never>>(schema: S) => {
    const encodedDefault = Schema.encodeUnknownSync(schema)(defaultValue);
    const equivalent = Schema.toEquivalence(Schema.toEncoded(schema));
    return Schema.optionalKey(Schema.toEncoded(schema)).pipe(
      Schema.decodeTo(schema, {
        decode: SchemaGetter.onNone(() => Effect.succeed(Option.some(encodedDefault))),
        encode: SchemaGetter.transformOptional((value) =>
          Option.flatMap(value, (encoded) => {
            if (equivalent(encoded, encodedDefault)) {
              return Option.none();
            }
            return Option.some(encoded);
          }),
        ),
      }),
    );
  };

interface SearchField {
  readonly name: string;
  readonly array: boolean;
}

const searchKeyOrders = new WeakMap<object, ReadonlyArray<string>>();
type SearchEncodedValue = string | ReadonlyArray<string> | number | boolean;
type SearchEncodedObject = Partial<Record<string, SearchEncodedValue>>;

/** Lift a struct codec into the URL's repeated-key search record. */
export const search = <S extends Schema.ConstraintCodec<object, SearchEncodedObject, never, never>>(
  schema: S,
): Schema.Codec<S["Type"], SearchRecord> => {
  const fields = searchFields(schema);
  const result = SearchRecord.pipe(
    Schema.decodeTo(schema, {
      decode: SchemaGetter.transform((record) => decodeFields(fields, record)),
      encode: SchemaGetter.transform((value) => encodeFields(fields, value)),
    }),
  );
  searchKeyOrders.set(
    result,
    fields.map((field) => field.name),
  );
  return result;
};

const searchFields = (schema: Schema.Constraint): ReadonlyArray<SearchField> => {
  const decoded = schema.ast;
  const encoded = Schema.toEncoded(schema).ast;
  if (decoded._tag !== "Objects" || encoded._tag !== "Objects") {
    return Option.getOrThrowWith(Option.none(), () =>
      SearchSchemaRejected.make({ reason: "Route.search requires an object Schema" }),
    );
  }
  const fields: Array<SearchField> = [];
  for (const [index] of decoded.propertySignatures.entries()) {
    const encodedProperty = Option.fromNullishOr(encoded.propertySignatures[index]);
    if (Option.isNone(encodedProperty)) {
      return Option.getOrThrowWith(Option.none(), () =>
        SearchSchemaRejected.make({ reason: "Route.search could not align Schema fields" }),
      );
    }
    const field = encodedProperty.value;
    if (field.type._tag === "String") {
      fields.push({ name: String(field.name), array: false });
      continue;
    }
    if (
      field.type._tag === "Arrays" &&
      field.type.rest.every((element) => element._tag === "String")
    ) {
      fields.push({ name: String(field.name), array: true });
      continue;
    }
    return Option.getOrThrowWith(Option.none(), () =>
      SearchSchemaRejected.make({
        reason: "Route.search fields must encode as strings or string arrays",
      }),
    );
  }
  return fields;
};

const decodeFields = (
  fields: ReadonlyArray<SearchField>,
  record: SearchRecord,
): SearchEncodedObject => {
  const decoded: SearchEncodedObject = Object.create(null);
  for (const field of fields) {
    Option.match(Option.fromNullishOr(record[field.name]), {
      onNone: () => {},
      onSome: (values) => {
        if (field.array) {
          decoded[field.name] = values;
          return;
        }
        Option.match(Option.fromNullishOr(values[0]), {
          onNone: () => {},
          onSome: (value) => {
            decoded[field.name] = value;
          },
        });
      },
    });
  }
  return decoded;
};

const encodeFields = (
  fields: ReadonlyArray<SearchField>,
  value: SearchEncodedObject,
): SearchRecord => {
  const encoded: Record<string, Array<string>> = Object.create(null);
  for (const field of fields) {
    Option.match(Option.fromNullishOr(value[field.name]), {
      onNone: () => {},
      onSome: (fieldValue) => {
        if (field.array && Array.isArray(fieldValue)) {
          encoded[field.name] = fieldValue.map(String);
          return;
        }
        encoded[field.name] = [String(fieldValue)];
      },
    });
  }
  return encoded;
};

/**
 * What a route's view receives. Sources, not values: a stayed segment's
 * params can change without its view re-running, so the router publishes
 * the new values into these.
 */
export interface RouteProps<Params, Search> {
  readonly params: Source<Params>;
  readonly search: Source<Search>;
  /** Print this route with its own parameter and search codecs. */
  readonly href: (params: Params, search: Search) => string;
  /** Push a functional search update against the latest canonical URL. */
  readonly updateSearch: (update: SearchUpdater<Search>) => Effect.Effect<void>;
  /** Replace the current history entry with a functional search update. */
  readonly replaceSearch: (update: SearchUpdater<Search>) => Effect.Effect<void>;
}

export interface RouteDefinition<Params extends ParamsCodec, Search extends SearchCodec, R> {
  /** The URLPattern pathname grammar, restricted to what prints. */
  readonly path: string;
  readonly params: Params;
  readonly search: Search;
  /** Search keys to carry when this route is entered without a caller value. */
  readonly retain?: ReadonlyArray<Extract<keyof Search["Type"], string>>;
  readonly view: View.View<RouteProps<Params["Type"], Search["Type"]>, never, R>;
}

/**
 * A mounted route as the router drives it. `setup` is the view's setup with
 * this URL's values already bound; `update` publishes a later URL into them
 * and answers whether it still matched. The decoded types stay inside the
 * route that made them, so the router needs no cast to hold routes of
 * different shapes in one list.
 */
export interface Entered<R> {
  readonly setup: Effect.Effect<Node, never, R | Scope.Scope>;
  readonly update: (url: URL) => Effect.Effect<boolean>;
}

/** A route with its shapes erased: what a router holds. */
export interface AnyRoute<R> {
  readonly name: string;
  readonly enter: (
    url: URL,
    navigation?: RouteNavigation,
  ) => Option.Option<Effect.Effect<Entered<R>>>;
}

export interface Route<
  Name extends string,
  Params extends ParamsCodec,
  Search extends SearchCodec,
  R,
> extends AnyRoute<R> {
  readonly name: Name;
  readonly params: Params;
  readonly search: Search;
  /** Prints. Total: a value of the Schema's own type always encodes. */
  readonly href: (params: Params["Type"], search: Search["Type"]) => string;
  /** Prints after carrying retained keys from the current URL. */
  readonly hrefAt: (current: URL, params: Params["Type"], search: Search["Type"]) => string;
}

interface Decoded<Params, Search> {
  readonly params: Params;
  readonly search: Search;
}

/**
 * Rendering mode is a constructor, not a field. `client` is the one built so
 * far: the route renders on the client only. The others are #18 §6.
 */
export const client = <
  const Name extends string,
  Params extends ParamsCodec,
  Search extends SearchCodec,
  R,
>(
  name: Name,
  definition: RouteDefinition<Params, Search, R>,
): Route<Name, Params, Search, R> => {
  const parts = Result.getOrThrowWith(parseTemplate(definition.path), (rejected) => rejected);
  const decodeParams = Schema.decodeUnknownOption(definition.params);
  const decodeSearch = Schema.decodeUnknownOption(definition.search);
  const encodeParams = Schema.encodeSync(definition.params);
  const encodeSearch = Schema.encodeSync(definition.search);
  const searchOrder = encodedKeys(definition.search);

  const parse = (url: URL): Option.Option<Decoded<Params["Type"], Search["Type"]>> =>
    Option.flatMap(matchPath(parts, url.pathname), (record) =>
      Option.flatMap(decodeParams(record), (params) =>
        Option.map(decodeSearch(readSearch(url.searchParams)), (decodedSearch) => ({
          params,
          search: decodedSearch,
        })),
      ),
    );

  const href = (params: Params["Type"], searchValue: Search["Type"]): string =>
    `${printPath(parts, encodeParams(params))}${printSearch(encodeSearch(searchValue), searchOrder)}`;

  const hrefAt = (current: URL, params: Params["Type"], searchValue: Search["Type"]): string => {
    const retainedKeys = Option.fromNullishOr(definition.retain);
    if (Option.isNone(retainedKeys) || retainedKeys.value.length === 0) {
      return href(params, searchValue);
    }
    const callerRecord = encodeSearch(searchValue);
    const currentRecord = readSearch(current.searchParams);
    const previous = Option.getOrElse(
      decodeSearch(mergeSearch(currentRecord, callerRecord)),
      () => searchValue,
    );
    return href(params, retainSearch(previous, searchValue, retainedKeys.value));
  };

  const unavailable: RouteNavigation = {
    navigate: () => Effect.die("route navigation is unavailable before router mount"),
    replace: () => Effect.die("route navigation is unavailable before router mount"),
  };

  const enter = (url: URL, routeNavigation: RouteNavigation = unavailable) =>
    Option.map(parse(url), (decoded) =>
      Effect.map(SubscriptionRef.make(decoded), (current): Entered<R> => {
        const source: Source<Decoded<Params["Type"], Search["Type"]>> = {
          get: SubscriptionRef.get(current),
          changes: SubscriptionRef.changes(current),
        };
        return {
          setup: definition.view({
            params: select(source, (value) => value.params),
            search: select(source, (value) => value.search),
            href,
            updateSearch: (update) =>
              routeNavigation.navigate((latest) =>
                Option.match(parse(latest), {
                  onNone: () => latest.href,
                  onSome: (currentValue) => {
                    const nextSearch = update(currentValue.search);
                    return `${href(currentValue.params, nextSearch)}${latest.hash}`;
                  },
                }),
              ),
            replaceSearch: (update) =>
              routeNavigation.replace((latest) =>
                Option.match(parse(latest), {
                  onNone: () => latest.href,
                  onSome: (currentValue) => {
                    const nextSearch = update(currentValue.search);
                    return `${href(currentValue.params, nextSearch)}${latest.hash}`;
                  },
                }),
              ),
          }),
          update: (next) =>
            Option.match(parse(next), {
              onNone: () => Effect.succeed(false),
              onSome: (value) => Effect.as(SubscriptionRef.set(current, value), true),
            }),
        };
      }),
    );

  return {
    name,
    params: definition.params,
    search: definition.search,
    href,
    hrefAt,
    enter,
  };
};

const encodedKeys = (schema: SearchCodec): ReadonlyArray<string> => {
  const registered = Option.fromNullishOr(searchKeyOrders.get(schema));
  if (Option.isSome(registered)) {
    return registered.value;
  }
  const ast = Schema.toEncoded(schema).ast;
  if (ast._tag !== "Objects") {
    return [];
  }
  return ast.propertySignatures.map((property) => String(property.name));
};

const retainSearch = <Search>(
  previous: Search,
  next: Search,
  keys: ReadonlyArray<string>,
): Search => {
  if (!Predicate.isObject(previous) || !Predicate.isObject(next)) {
    return next;
  }
  const retained = Object.assign(Object.create(null), next);
  for (const key of keys) {
    if (!Object.hasOwn(retained, key) && Object.hasOwn(previous, key)) {
      Reflect.set(retained, key, Reflect.get(previous, key));
    }
  }
  return retained;
};

const mergeSearch = (current: SearchRecord, caller: SearchRecord): SearchRecord => {
  const merged: Record<string, ReadonlyArray<string>> = Object.create(null);
  for (const [key, values] of Object.entries(current)) {
    merged[key] = values;
  }
  for (const [key, values] of Object.entries(caller)) {
    merged[key] = values;
  }
  return merged;
};
