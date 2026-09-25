import type { Source } from "effect-frame/actor";
import type { Node } from "effect-frame/view";
import type { SchemaAST, Scope } from "effect";
import { Effect, Option, Predicate, Result, Schema, SchemaGetter } from "effect";
import { matchPrefix, refuseOutOfDomain, segmentFault, segmentsOf, textFault } from "./path.js";
export { UrlValueRejected } from "./path.js";
import type { RouteMatch } from "./router.js";

/**
 * A route is a bidirectional codec for a URL plus the view that URL shows
 * (#18). Both halves are data: the template is parsed once into parts that
 * print as well as match, and the params and search carry Schemas that
 * decode and encode. Nothing in a route runs; the router runs it.
 *
 * The URLPattern grammar is the notation and the URLPattern object is not
 * used: the object only parses, and a router needs to print.
 *
 * This module is internal. The public `Route` namespace is `route.ts`,
 * which lists what it exports. The segments, branches, and rendering-mode
 * constructors are in `branch.ts`.
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
  return Option.flatMap(matchPrefix(parts, segments, 0), (matched) => {
    if (matched.next !== segments.length) {
      return Option.none();
    }
    return Option.some(matched.record);
  });
};

/** A param's segments: one for a scalar, each item for a tail. */
const segmentsIn = (value: string | ReadonlyArray<string>): ReadonlyArray<string> => {
  if (Predicate.isString(value)) {
    return [value];
  }
  return value;
};

/**
 * Print parts from a record the params Schema produced. A value outside the
 * route domain is a defect, `UrlValueRejected`: see above.
 */
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
    const segments = segmentsIn(value);
    for (const segment of segments) {
      refuseOutOfDomain(part.name, segmentFault(segment));
    }
    return segments.map(encodeURIComponent);
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

/**
 * Print a record back, keeping declared or custom codec key order. A key or
 * value outside the route domain is a defect, `UrlValueRejected`.
 */
export const printSearch = (record: SearchRecord, order: ReadonlyArray<string> = []): string => {
  const params = new URLSearchParams();
  const keys = [...order, ...Object.keys(record).filter((key) => !order.includes(key))];
  for (const key of keys) {
    const values = Option.getOrElse(Option.fromNullishOr(record[key]), () => []);
    refuseOutOfDomain(key, textFault(key));
    for (const value of values) {
      refuseOutOfDomain(key, textFault(value));
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

/** Internal identity carried by actions from one mounted route instance. */
export interface RouteInstance {
  readonly _tag: "RouteInstance";
}

/** The router operations a mounted route gives to its own view. */
export interface RouteNavigation {
  readonly navigate: (href: string | UrlUpdater, owner?: RouteInstance) => Effect.Effect<void>;
  readonly replace: (href: string | UrlUpdater, owner?: RouteInstance) => Effect.Effect<void>;
}

/** A functional update over one route's decoded search value. */
export type SearchUpdater<Search> = (previous: Search) => Search;

/**
 * Give a search field a decoding default and omit that value when encoding.
 *
 * Effect's `withDecodingDefaultTypeKey` with the `omit` strategy omits
 * every encoded value. URL state needs the default value omitted only,
 * so this small field combinator keeps the actual Schema codec as the single
 * source of both parsing and printing.
 */
export const withDefault =
  <const Default>(defaultValue: Default) =>
  <S extends Schema.ConstraintCodec<unknown, unknown, never, never>>(
    schema: S & ([Default] extends [S["Type"]] ? unknown : never),
  ) => {
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
  readonly decodedName: string;
  readonly name: string;
  readonly array: boolean;
}

const searchKeyOrders = new WeakMap<object, ReadonlyArray<string>>();
const searchFieldDefinitions = new WeakMap<object, ReadonlyArray<SearchField>>();
/** Encoded search keys owned by one route or URL-state codec. */
export interface SearchKeyInfo {
  readonly known: boolean;
  readonly keys: ReadonlyArray<string>;
}

const searchKeyDefinitions = new WeakMap<object, SearchKeyInfo>();
type SearchEncodedValue = string | ReadonlyArray<string> | number | boolean;
type SearchEncodedObject = Partial<Record<string, SearchEncodedValue>>;

/**
 * A repeated URL key has no representation for an empty array. A single
 * marker fills that gap, and values beginning with the marker are escaped so
 * the marker cannot collide with a user value. Scalar fields and custom
 * SearchRecord codecs do not use this representation.
 */
const emptyArrayMarker = "~";

const encodeArrayValue = (value: string): string => {
  if (value.startsWith(emptyArrayMarker)) {
    return `${emptyArrayMarker}${value}`;
  }
  return value;
};

const decodeArrayValues = (values: ReadonlyArray<string>): ReadonlyArray<string> => {
  if (values.length === 1 && values[0] === emptyArrayMarker) {
    return [];
  }
  return values.map((value) => {
    if (value.startsWith(`${emptyArrayMarker}${emptyArrayMarker}`)) {
      return value.slice(emptyArrayMarker.length);
    }
    return value;
  });
};

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
  searchFieldDefinitions.set(result, fields);
  searchKeyDefinitions.set(result, {
    known: true,
    keys: fields.map((field) => field.name),
  });
  return result;
};

const isStringEncodedAst = (ast: SchemaAST.AST): boolean => {
  if (ast._tag === "String") {
    return true;
  }
  if (ast._tag === "Literal") {
    return Predicate.isString(ast.literal);
  }
  return ast._tag === "Union" && ast.types.length > 0 && ast.types.every(isStringEncodedAst);
};

const searchFields = (schema: Schema.Constraint): ReadonlyArray<SearchField> => {
  const decoded = schema.ast;
  const encoded = Schema.toEncoded(schema).ast;
  if (decoded._tag !== "Objects" || encoded._tag !== "Objects") {
    return Option.getOrThrowWith(Option.none(), () =>
      SearchSchemaRejected.make({ reason: "Route.search requires an object Schema" }),
    );
  }
  if (decoded.indexSignatures.length > 0 || encoded.indexSignatures.length > 0) {
    return Option.getOrThrowWith(Option.none(), () =>
      SearchSchemaRejected.make({ reason: "Route.search requires a fixed Struct Schema" }),
    );
  }
  const fields: Array<SearchField> = [];
  for (const [index, decodedProperty] of decoded.propertySignatures.entries()) {
    const encodedProperty = Option.fromNullishOr(encoded.propertySignatures[index]);
    if (Option.isNone(encodedProperty)) {
      return Option.getOrThrowWith(Option.none(), () =>
        SearchSchemaRejected.make({ reason: "Route.search could not align Schema fields" }),
      );
    }
    const field = encodedProperty.value;
    if (isStringEncodedAst(field.type)) {
      fields.push({
        decodedName: String(decodedProperty.name),
        name: String(field.name),
        array: false,
      });
      continue;
    }
    if (field.type._tag === "Arrays") {
      const elements = [...field.type.elements, ...field.type.rest];
      if (elements.every(isStringEncodedAst)) {
        fields.push({
          decodedName: String(decodedProperty.name),
          name: String(field.name),
          array: true,
        });
        continue;
      }
    }
    return Option.getOrThrowWith(Option.none(), () =>
      SearchSchemaRejected.make({
        reason: "Route.search fields must encode as strings or string arrays",
      }),
    );
  }
  return fields;
};

const searchFieldNames = (
  fields: ReadonlyArray<SearchField>,
  decodedNames: ReadonlyArray<string>,
): ReadonlySet<string> => {
  const names = new Set(decodedNames);
  return new Set(fields.filter((field) => names.has(field.decodedName)).map((field) => field.name));
};

const retainedSearchRecord = (
  current: SearchRecord,
  caller: SearchRecord,
  fields: Option.Option<ReadonlyArray<SearchField>>,
  callerKeys: ReadonlySet<string>,
  retained: ReadonlyArray<string>,
): SearchRecord => {
  const record: Record<string, ReadonlyArray<string>> = Object.create(null);
  Option.match(fields, {
    onNone: () => {
      for (const [key, values] of Object.entries(current)) {
        record[key] = values;
      }
    },
    onSome: (available) => {
      const retainedNames = searchFieldNames(available, retained);
      for (const key of retainedNames) {
        Option.match(Option.fromNullishOr(available.find((candidate) => candidate.name === key)), {
          onNone: () => {},
          onSome: (field) => {
            if (!callerKeys.has(field.decodedName) && Object.hasOwn(current, key)) {
              Option.match(Option.fromNullishOr(current[key]), {
                onNone: () => {},
                onSome: (values) => {
                  record[key] = values;
                },
              });
            }
          },
        });
      }
    },
  });
  for (const [key, values] of Object.entries(caller)) {
    record[key] = values;
  }
  return record;
};

const callerKeys = <Value>(value: Value): ReadonlySet<string> => {
  if (Predicate.isObject(value)) {
    return new Set(Object.keys(value));
  }
  return new Set();
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
          decoded[field.name] = decodeArrayValues(values);
          return;
        }
        Option.match(Option.fromNullishOr(values[0]), {
          onNone: () => {},
          onSome: (fieldValue) => {
            decoded[field.name] = fieldValue;
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
    Option.match(Option.fromNullishOr(Reflect.get(value, field.name)), {
      onNone: () => {},
      onSome: (fieldValue) => {
        if (field.array && Array.isArray(fieldValue)) {
          if (fieldValue.length === 0) {
            encoded[field.name] = [emptyArrayMarker];
          } else {
            encoded[field.name] = fieldValue.map((element) => encodeArrayValue(String(element)));
          }
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

/**
 * A mounted route as the router drives it. `setup` is the view's setup with
 * this URL's values already bound; `update` publishes a later URL into them
 * and answers whether it still matched. The decoded types stay inside the
 * route that made them, so the router needs no cast to hold routes of
 * different shapes in one list.
 */
export interface Entered<R> {
  /** Identity for actions created by this mounted route instance. */
  readonly instance?: RouteInstance;
  readonly setup: Effect.Effect<Node, never, R | Scope.Scope>;
  readonly update: (url: URL) => Effect.Effect<boolean>;
}

/** A route with its shapes erased: what a router holds. */
export interface AnyRoute<R> {
  readonly name: string;
  /** Encoded search ownership. Unknown means an opaque codec needs a declaration. */
  readonly searchKeys: SearchKeyInfo;
  readonly enter: (
    url: URL,
    navigation?: RouteNavigation,
  ) => Option.Option<Effect.Effect<Entered<R>, never, Scope.Scope>>;
}

/**
 * A typed link destination: a segment. It prints against the current URL,
 * reads the current search for a functional update, and says whether the
 * document is on it.
 */
export interface Linkable<Params, Search> {
  /** Prints after carrying retained keys from the current URL. */
  readonly hrefAt: (current: URL, params: Params, search: Search) => string;
  /** The current URL's decoded search, or the codec's empty value. */
  readonly searchAt: (current: URL) => Search;
  /**
   * Where the current match is relative to this destination: on it
   * (`"page"`), below it (`"ancestor"`), or elsewhere.
   */
  readonly currentAt: (current: RouteMatch) => Current;
}

/**
 * A link's relation to the current match. `Link` draws `"page"` as
 * `aria-current="page"` and `"ancestor"` as `aria-current="true"`.
 */
export type Current = "page" | "ancestor" | "none";

/** The decoded values one URL gives one address. */
export interface Decoded<Params, Search> {
  readonly params: Params;
  readonly search: Search;
}

/**
 * What an address is made of: its codecs, and its declared search keys and
 * retained keys, each present or absent.
 */
export interface AddressSpec<Params extends ParamsCodec, Search extends SearchCodec> {
  readonly params: Params;
  readonly search: Search;
  readonly searchKeys: Option.Option<ReadonlyArray<string>>;
  readonly retain: Option.Option<ReadonlyArray<string>>;
}

/**
 * One printable, parseable address: a segment's whole path, with the params
 * and search codecs that decode and encode it.
 */
export interface Address<Params, Search> {
  /** Encoded search ownership. Unknown means an opaque codec needs a declaration. */
  readonly searchKeys: SearchKeyInfo;
  /** Decode a URL whose whole path is this address. */
  readonly parse: (url: URL) => Option.Option<Decoded<Params, Search>>;
  /** Decode a URL whose path starts with this address. */
  readonly parsePrefix: (url: URL) => Option.Option<Decoded<Params, Search>>;
  /** Prints. Total: a value of the Schema's own type always encodes. */
  readonly href: (params: Params, search: Search) => string;
  /** Prints after carrying retained keys from the current URL. */
  readonly hrefAt: (current: URL, params: Params, search: Search) => string;
  /** Prints a search update of the current URL: other keys and the hash stay. */
  readonly hrefFrom: (current: URL, params: Params, search: Search) => string;
  /** Replaces only this address's search keys; the current path and hash stay. */
  readonly searchFrom: (current: URL, search: Search) => string;
  /** The current URL's decoded search, or the codec's empty value. */
  readonly searchAt: (current: URL) => Search;
}

/** Build the address of `parts`, which are the whole path from the root. */
export const address = <Params extends ParamsCodec, Search extends SearchCodec>(
  parts: ReadonlyArray<Part>,
  spec: AddressSpec<Params, Search>,
): Address<Params["Type"], Search["Type"]> => {
  const decodeParams = Schema.decodeUnknownOption(spec.params);
  const decodeSearch = Schema.decodeUnknownOption(spec.search);
  const encodeParams = Schema.encodeSync(spec.params);
  const encodeSearch = Schema.encodeSync(spec.search);
  const searchKeys = declaredSearchKeys(spec.search, spec.searchKeys);
  const searchOrder = encodedKeys(spec.search);

  const encodeOwnedSearch = (searchValue: Search["Type"]): SearchRecord => {
    const encoded = encodeSearch(searchValue);
    if (searchKeys.known) {
      const owned = new Set(searchKeys.keys);
      for (const key of Object.keys(encoded)) {
        if (!owned.has(key)) {
          return Option.getOrThrowWith(Option.none(), () =>
            SearchSchemaRejected.make({
              reason: `search codec encoded undeclared URL key ${key}`,
            }),
          );
        }
      }
    }
    return encoded;
  };

  const decodeRecord = (
    record: PathRecord,
    url: URL,
  ): Option.Option<Decoded<Params["Type"], Search["Type"]>> =>
    Option.flatMap(decodeParams(record), (params) =>
      Option.map(decodeSearch(readSearch(url.searchParams)), (decodedSearch) => ({
        params,
        search: decodedSearch,
      })),
    );

  const parse = (url: URL): Option.Option<Decoded<Params["Type"], Search["Type"]>> =>
    Option.flatMap(matchPath(parts, url.pathname), (record) => decodeRecord(record, url));

  const parsePrefix = (url: URL): Option.Option<Decoded<Params["Type"], Search["Type"]>> =>
    Option.flatMap(matchPrefix(parts, segmentsOf(url.pathname), 0), (matched) =>
      decodeRecord(matched.record, url),
    );

  const href = (params: Params["Type"], searchValue: Search["Type"]): string =>
    `${printPath(parts, encodeParams(params))}${printSearch(encodeOwnedSearch(searchValue), searchOrder)}`;

  /** The search of `current` with this address's keys replaced by `encoded`. */
  const replacedSearch = (current: URL, encoded: SearchRecord): string => {
    if (searchKeys.known) {
      return printSearch(
        mergeSearchRecord(readSearch(current.searchParams), encoded, searchKeys.keys),
      );
    }
    return printSearch(encoded, searchOrder);
  };

  const hrefFrom = (current: URL, params: Params["Type"], searchValue: Search["Type"]): string => {
    const next = new URL(`${printPath(parts, encodeParams(params))}`, current);
    next.search = replacedSearch(current, encodeOwnedSearch(searchValue));
    next.hash = current.hash;
    return next.href;
  };

  const searchFrom = (current: URL, searchValue: Search["Type"]): string => {
    const next = new URL(current.href);
    next.search = replacedSearch(current, encodeOwnedSearch(searchValue));
    return next.href;
  };

  const hrefAt = (current: URL, params: Params["Type"], searchValue: Search["Type"]): string => {
    const nextSearch = Option.match(spec.retain, {
      onNone: () => searchValue,
      onSome: (keys) => {
        if (keys.length === 0) {
          return searchValue;
        }
        const callerRecord = encodeOwnedSearch(searchValue);
        const currentRecord = readSearch(current.searchParams);
        const retainedRecord = retainedSearchRecord(
          currentRecord,
          callerRecord,
          Option.fromNullishOr(searchFieldDefinitions.get(spec.search)),
          callerKeys(searchValue),
          keys,
        );
        const previous = Option.getOrElse(decodeSearch(retainedRecord), () => searchValue);
        return retainSearch(previous, searchValue, keys);
      },
    });
    if (Option.isSome(parse(current)) && searchKeys.known) {
      return `${printPath(parts, encodeParams(params))}${printSearch(
        mergeSearchRecord(
          readSearch(current.searchParams),
          encodeOwnedSearch(nextSearch),
          searchKeys.keys,
        ),
      )}`;
    }
    return href(params, nextSearch);
  };

  const searchAt = (current: URL): Search["Type"] =>
    Option.getOrElse(decodeSearch(readSearch(current.searchParams)), () =>
      Option.getOrThrow(decodeSearch({})),
    );

  return { searchKeys, parse, parsePrefix, href, hrefAt, hrefFrom, searchFrom, searchAt };
};

const declaredSearchKeys = (
  schema: SearchCodec,
  declared: Option.Option<ReadonlyArray<string>>,
): SearchKeyInfo => {
  const inferred = inferredSearchKeys(schema);
  if (Option.isSome(declared)) {
    if (Option.isSome(inferred) && !sameKeySet(inferred.value, declared.value)) {
      return Option.getOrThrowWith(Option.none(), () =>
        SearchSchemaRejected.make({
          reason: "explicit searchKeys must match the codec's inferred encoded keys",
        }),
      );
    }
    return makeSearchKeyInfo(declared.value);
  }
  if (Option.isSome(inferred)) {
    return makeSearchKeyInfo(inferred.value);
  }
  return { known: false, keys: [] };
};

const inferredSearchKeys = (schema: SearchCodec): Option.Option<ReadonlyArray<string>> => {
  const registered = Option.fromNullishOr(searchKeyDefinitions.get(schema));
  if (Option.isSome(registered)) {
    return Option.some(registered.value.keys);
  }
  const ast = Schema.toEncoded(schema).ast;
  if (ast._tag !== "Objects" || ast.indexSignatures.length > 0) {
    return Option.none();
  }
  return Option.some(ast.propertySignatures.map((property) => String(property.name)));
};

const encodedKeys = (schema: SearchCodec): ReadonlyArray<string> => {
  const registered = Option.fromNullishOr(searchKeyOrders.get(schema));
  if (Option.isSome(registered)) {
    return registered.value;
  }
  const ast = Schema.toEncoded(schema).ast;
  if (ast._tag !== "Objects" || ast.indexSignatures.length > 0) {
    return [];
  }
  return ast.propertySignatures.map((property) => String(property.name));
};

const sameKeySet = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean => {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((key) => rightSet.has(key));
};

/** Merge owned encoded keys in codec order while retaining unrelated URL keys. */
export const mergeSearchRecord = (
  current: SearchRecord,
  encoded: SearchRecord,
  owned: ReadonlyArray<string>,
): SearchRecord => {
  const ownedSet = new Set(owned);
  const merged: Record<string, ReadonlyArray<string>> = Object.create(null);
  let encodedWritten = false;
  const writeEncoded = () => {
    if (encodedWritten) {
      return;
    }
    encodedWritten = true;
    for (const [key, values] of Object.entries(encoded)) {
      merged[key] = Option.getOrThrow(Option.fromNullishOr(values));
    }
  };
  for (const [key, values] of Object.entries(current)) {
    if (ownedSet.has(key)) {
      writeEncoded();
      continue;
    }
    merged[key] = values;
  }
  writeEncoded();
  return merged;
};

/** Return the encoded key metadata registered for a search codec. */
export const searchKeysOf = (schema: SearchCodec): SearchKeyInfo =>
  declaredSearchKeys(schema, Option.none());

const makeSearchKeyInfo = (keys: ReadonlyArray<string>): SearchKeyInfo => {
  const unique = new Set(keys);
  if (unique.size !== keys.length) {
    return Option.getOrThrowWith(Option.none(), () =>
      SearchSchemaRejected.make({ reason: "search key declarations must be unique" }),
    );
  }
  return { known: true, keys: [...keys] };
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
