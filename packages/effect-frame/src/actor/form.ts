import {
  Context,
  Effect,
  Option,
  Predicate,
  Schema,
  SchemaIssue,
  SchemaTransformation,
} from "effect";
import type { AnyContract, KeyOf } from "./contract.js";
import type { GeneratedTypeId } from "./generated.js";
import { CommandId } from "./vocabulary.js";

export { freshCommandId } from "./command-id.js";

/**
 * Plain-form posts (#21). A form body is one more encoding of a message: a
 * flat map of strings. This module holds the parts both halves share: the
 * framework field names, the structural step from a flat map to a nested
 * tree, the codec over a message schema, and the issues a refused post
 * carries back into the page. It is browser safe.
 *
 * Decoding is two steps, and the split is the design:
 *
 *   1. `tree` is structural only. It reads dotted and indexed names and
 *      builds nesting. Every leaf stays a string.
 *   2. The message schema decodes the tree. Every type conversion lives
 *      there, never in a field name.
 */

/** A flat map from a form body: every value a string, a name may repeat. */
export type FormFields = ReadonlyMap<string, ReadonlyArray<string>>;

/** The nested shape before the message schema sees it. Still strings. */
export type FormTree = string | ReadonlyArray<FormTree> | { readonly [key: string]: FormTree };

/**
 * The framework's fields. One `$` prefix, fixed names. A field whose name
 * starts with `$` is the framework's, and the message decoder never sees it.
 */
export const frameworkFields = {
  command: "$command",
  contract: "$contract",
  version: "$version",
  key: "$key",
  returnTo: "$return",
  /**
   * Which form on the page posted. Two forms on one actor key refuse
   * separately: a refusal redraws only the form that it names.
   */
  form: "$form",
} satisfies Record<string, string>;

/** A body the structural step refuses. A rendered form cannot produce one. */
export class FormMalformed extends Schema.TaggedError<FormMalformed>()("FormMalformed", {
  reason: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// Flat fields
// ---------------------------------------------------------------------------

const isString = Schema.is(Schema.String);

/** Collect entries in order. Only string values: a file is not a field. */
export const fromEntries = (entries: Iterable<readonly [string, unknown]>): FormFields => {
  const out = new Map<string, Array<string>>();
  for (const [name, value] of entries) {
    if (!isString(value)) {
      continue;
    }
    const values = Option.getOrElse(Option.fromNullishOr(out.get(name)), (): Array<string> => []);
    values.push(value);
    out.set(name, values);
  }
  return out;
};

/** Every entry of a field map, in order, one per value. */
export const toEntries = (fields: FormFields): Array<[string, string]> =>
  Array.from(fields).flatMap(([name, values]) =>
    values.map((value): [string, string] => [name, value]),
  );

/** The `application/x-www-form-urlencoded` body a browser would send. */
export const toBody = (fields: FormFields): string =>
  new URLSearchParams(toEntries(fields)).toString();

/** Parse an `application/x-www-form-urlencoded` body. */
export const fromBody = (body: string): FormFields => fromEntries(new URLSearchParams(body));

/** Last write wins, so a submit button's value overrides a hidden one. */
export const last = (fields: FormFields, name: string): Option.Option<string> =>
  Option.flatMap(Option.fromNullishOr(fields.get(name)), (values) =>
    Option.fromNullishOr(values.at(-1)),
  );

const isFramework = (name: string): boolean => name.startsWith("$");

const stepPattern = /[A-Za-z_$][\w$]*|\[\d+\]/g;

const segmentsOf = (name: string): ReadonlyArray<string> =>
  Array.from(name.matchAll(stepPattern), (match) => match[0]);

const isRedacted = (name: string): boolean =>
  segmentsOf(name).some((segment) => segment.startsWith("_"));

/** Every author field: `$`-prefixed names removed in one pass, no allowlist. */
export const strip = (fields: FormFields): FormFields =>
  new Map(Array.from(fields).filter(([name]) => !isFramework(name)));

/**
 * The values a refused post may redraw: no framework field, and no field
 * with any segment that starts with `_`. A password never round-trips.
 */
export const submitted = (fields: FormFields): FormFields =>
  new Map(Array.from(fields).filter(([name]) => !isFramework(name) && !isRedacted(name)));

/** Replace the values of the named fields. */
export const withValues = (
  fields: FormFields,
  values: ReadonlyArray<readonly [name: string, value: string]>,
): FormFields => {
  const out = new Map(fields);
  for (const [name, value] of values) {
    out.set(name, [value]);
  }
  return out;
};

/** Drop the named fields. */
export const without = (fields: FormFields, names: ReadonlyArray<string>): FormFields =>
  new Map(Array.from(fields).filter(([name]) => !names.includes(name)));

// ---------------------------------------------------------------------------
// The structural step
// ---------------------------------------------------------------------------

/**
 *   name    := segment ( "." segment | "[" digits "]" )* "[]"?
 *   segment := [A-Za-z_$][A-Za-z0-9_$]*
 */
const namePattern = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*(?:\[\])?$/;
const refusedSegments = new Set(["__proto__", "constructor", "prototype"]);

interface Leaf {
  readonly _tag: "Leaf";
  readonly value: string;
}

interface Branch {
  readonly _tag: "Branch";
  /** An indexed branch becomes a list; a named one becomes a record. */
  readonly list: boolean;
  /**
   * How a list is filled: by `[n]` or by `[]`. One list takes one of the
   * two, because an appended value has no index to agree with a written one.
   */
  indexing: "unset" | "explicit" | "append";
  readonly children: Map<string, Draft>;
}

type Draft = Leaf | Branch;

const branch = (list: boolean): Branch => ({
  _tag: "Branch",
  list,
  indexing: "unset",
  children: new Map(),
});

/** The deepest name the structural step reads. A message is not deeper. */
export const maxDepth = 32;
/** The most fields one body may carry. */
export const maxFields = 1000;

/** Record how a list is filled. None when it was filled the other way. */
const indexWith = (list: Branch, indexing: "explicit" | "append"): Option.Option<Branch> => {
  if (list.indexing !== "unset" && list.indexing !== indexing) {
    return Option.none();
  }
  list.indexing = indexing;
  return Option.some(list);
};

const isIndex = (segment: string): boolean => segment.startsWith("[");

const keyOf = (segment: string): string => {
  if (isIndex(segment)) {
    return segment.slice(1, -1);
  }
  return segment;
};

/** The child branch at `segment`, created on first use. None on a shape conflict. */
const childBranch = (parent: Branch, segment: string, list: boolean): Option.Option<Branch> => {
  const key = keyOf(segment);
  const existing = Option.fromNullishOr(parent.children.get(key));
  if (Option.isNone(existing)) {
    const created = branch(list);
    parent.children.set(key, created);
    return Option.some(created);
  }
  const found = existing.value;
  if (found._tag === "Branch" && found.list === list) {
    return Option.some(found);
  }
  return Option.none();
};

/** Place one value. Returns the reason on refusal. */
const place = (root: Branch, name: string, value: string): Option.Option<string> => {
  if (!namePattern.test(name)) {
    return Option.some(`field name "${name}" is outside the form grammar`);
  }
  const append = name.endsWith("[]");
  const segments = segmentsOf(name.replace(/\[\]$/, ""));
  if (segments.some((segment) => refusedSegments.has(segment))) {
    return Option.some(`field name "${name}" uses a refused segment`);
  }
  if (segments.length > maxDepth) {
    return Option.some(`field name "${name.slice(0, 64)}…" is deeper than ${String(maxDepth)}`);
  }
  if (value === "" && !append) {
    return Option.none();
  }
  const mixed = Option.some(`field name "${name}" mixes [n] and [] in one list`);
  let parent = root;
  for (const [index, segment] of segments.entries()) {
    if (isIndex(segment) && Option.isNone(indexWith(parent, "explicit"))) {
      return mixed;
    }
    const next = Option.fromNullishOr(segments[index + 1]);
    const isLast = Option.isNone(next);
    if (isLast && !append) {
      const existing = Option.fromNullishOr(parent.children.get(keyOf(segment)));
      if (Option.exists(existing, Predicate.isTagged("Branch"))) {
        return Option.some(`field name "${name}" is both a value and a group`);
      }
      parent.children.set(keyOf(segment), { _tag: "Leaf", value });
      return Option.none();
    }
    const list = Option.match(next, { onNone: () => true, onSome: isIndex });
    const child = childBranch(parent, segment, list);
    if (Option.isNone(child)) {
      return Option.some(`field name "${name}" disagrees with another field's shape`);
    }
    parent = child.value;
  }
  if (Option.isNone(indexWith(parent, "append"))) {
    return mixed;
  }
  parent.children.set(String(parent.children.size), { _tag: "Leaf", value });
  return Option.none();
};

const byIndex = ([left]: readonly [string, Draft], [right]: readonly [string, Draft]): number =>
  Number(left) - Number(right);

const settle = (draft: Draft): FormTree => {
  if (draft._tag === "Leaf") {
    return draft.value;
  }
  const entries = Array.from(draft.children);
  if (draft.list) {
    return entries.sort(byIndex).map(([, child]) => settle(child));
  }
  return Object.fromEntries(entries.map(([key, child]) => [key, settle(child)]));
};

/**
 * `FormFields -> FormTree`, structural only. Dotted names nest, `[n]` and
 * `[]` build lists, `__proto__`, `constructor` and `prototype` are refused,
 * and an empty value is absent unless its name ends in `[]`. A name that
 * repeats without `[]` keeps its last value.
 */
export const tree = (
  fields: FormFields,
): Effect.Effect<{ readonly [key: string]: FormTree }, FormMalformed> =>
  Effect.suspend(() => {
    const root = branch(false);
    const entries = toEntries(fields);
    if (entries.length > maxFields) {
      return Effect.fail(
        FormMalformed.make({ reason: `the body has more than ${String(maxFields)} fields` }),
      );
    }
    for (const [name, value] of entries) {
      const refused = place(root, name, value);
      if (Option.isSome(refused)) {
        return Effect.fail(FormMalformed.make({ reason: refused.value }));
      }
    }
    return Effect.succeed(
      Object.fromEntries(Array.from(root.children, ([key, child]) => [key, settle(child)])),
    );
  });

/** A nested string tree, as a schema. */
export const Tree: Schema.Codec<FormTree> = Schema.suspend(() =>
  Schema.Union([Schema.String, Schema.Array(Tree), Schema.Record(Schema.String, Tree)]),
);

const flattenInto = (out: Array<[string, string]>, prefix: string, value: FormTree): void => {
  if (isString(value)) {
    out.push([prefix, value]);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item: FormTree, index) => flattenInto(out, `${prefix}[${String(index)}]`, item));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (prefix === "") {
      flattenInto(out, key, item);
    } else {
      flattenInto(out, `${prefix}.${key}`, item);
    }
  }
};

/** `FormTree -> FormFields`: the inverse of `tree`. */
export const flatten = (value: FormTree): FormFields => {
  const out: Array<[string, string]> = [];
  flattenInto(out, "", value);
  return fromEntries(out);
};

// ---------------------------------------------------------------------------
// The codec
// ---------------------------------------------------------------------------

/** What a form body can carry: strings, nested. */
type Encodable = string | ReadonlyArray<Encodable> | { readonly [key: string]: Encodable };

type FieldRefusal<F> = F extends {
  readonly Encoded: infer E;
  readonly Type: infer T;
  readonly "~encoded.optionality": infer O;
}
  ? [E] extends [Encodable]
    ? [T] extends [boolean]
      ? [O] extends ["optional"]
        ? never
        : "a form-bound boolean needs a decoding default: an unchecked box sends nothing"
      : never
    : "a form field must encode to strings"
  : never;

type MemberRefusal<M> = M extends { readonly fields: infer Fields }
  ? { [K in keyof Fields]: FieldRefusal<Fields[K]> }[keyof Fields]
  : "a form message is a TaggedStruct or a union of them";

/** Why a message schema has no form encoding. `never` when it has one. */
export type Refusal<S> = S extends { readonly members: ReadonlyArray<infer M> }
  ? M extends unknown
    ? MemberRefusal<M>
    : never
  : MemberRefusal<S>;

/** `unknown` for a message with a form encoding; a named refusal otherwise. */
export type Codable<S> = [Refusal<S>] extends [never]
  ? unknown
  : { readonly "form codec refused": Refusal<S> };

/** A flat field map, as a schema. */
export const Fields = Schema.ReadonlyMap(Schema.String, Schema.Array(Schema.String));

/** `FormFields <-> FormTree`, the structural step as a schema. */
export const Structure = Fields.pipe(
  Schema.decodeTo(
    Tree,
    SchemaTransformation.transformEffect({
      decode: (fields: FormFields) =>
        Effect.mapError(
          tree(fields),
          (refused) => new SchemaIssue.InvalidValue({ message: refused.reason }, fields),
        ),
      encode: (value: FormTree) => Effect.succeed(flatten(value)),
    }),
  ),
);

/**
 * The form codec of a message schema: the same schema the JSON wire uses,
 * read from a flat field map instead of a JSON string. Both decode to one
 * type. It does not exist for a message with a field that cannot encode to
 * strings, or with a boolean that has no decoding default.
 */
export const codec = <S extends Schema.Top>(schema: S & Codable<S>) =>
  Structure.pipe(Schema.decodeTo(schema, SchemaTransformation.passthrough({ strict: false })));

/**
 * A checkbox. An unchecked box sends no field at all, so absence is the
 * encoding of `false`; a checked one sends its value, `on` by default. The
 * JSON wire uses the same encoding: `true` is `"on"`, `false` is absent.
 */
export const Checkbox = Schema.optionalKey(Schema.String).pipe(
  Schema.decodeTo(
    Schema.Boolean,
    SchemaTransformation.transformOptional({
      decode: (value: Option.Option<string>) => Option.some(Option.isSome(value)),
      encode: (checked: Option.Option<boolean>) =>
        Option.as(
          Option.filter(checked, (on) => on),
          "on",
        ),
    }),
  ),
);

// ---------------------------------------------------------------------------
// Which fields a form carries
// ---------------------------------------------------------------------------

/**
 * The fields of one message member a form must carry, given the fields its
 * inputs type: every field that is not `_tag`, not typed, not generated,
 * and not optional. `never` when the form covers the message.
 */
export type Uncovered<M, Typed extends string> = M extends { readonly fields: infer Fields }
  ? {
      [K in keyof Fields]: K extends "_tag" | Typed
        ? never
        : Fields[K] extends { readonly [GeneratedTypeId]: unknown }
          ? never
          : Fields[K] extends { readonly "~encoded.optionality": "optional" }
            ? never
            : K;
    }[keyof Fields]
  : never;

/** `unknown` when the form covers the member; a named refusal otherwise. */
export type Covered<M, Typed extends string> = [Uncovered<M, Typed>] extends [never]
  ? unknown
  : { readonly "field no form input carries and no mark generates": Uncovered<M, Typed> };

// ---------------------------------------------------------------------------
// Issues and the render context
// ---------------------------------------------------------------------------

/** One field's reason for refusing a posted value. */
export interface FormIssue {
  /** Dotted path into the message, spelled as the field name spells it. */
  readonly field: string;
  readonly message: string;
}

/**
 * What a refused post hands the page it re-renders. `commandId` is the id
 * the re-rendered form carries: fresh when the command certainly did not
 * reach the mailbox, the same when it may have.
 */
export interface FormIssues {
  readonly contract: string;
  /** The key as the form posted it, form-encoded. */
  readonly key: string;
  /** The `$form` the refused post carried: which form on the page it was. */
  readonly form: string;
  readonly commandId: CommandId;
  readonly issues: ReadonlyArray<FormIssue>;
  /** Every non-redacted posted value, for repopulation. Strings only. */
  readonly submitted: FormFields;
}

/**
 * A server view reads it to redraw a refused post. It is absent on an
 * ordinary render, so one view serves both and has no branch at its root.
 */
export class FormContext extends Context.Service<FormContext, FormIssues>()(
  "effect-frame/src/actor/form/FormContext",
) {}

/**
 * `FormIssues` as JSON, for the page. A hydrating client must draw what the
 * server drew, so a refused page carries its issues to the client the way
 * it carries a snapshot (#21 §5).
 */
export const IssuesJson = Schema.fromJsonString(
  Schema.Struct({
    contract: Schema.String,
    key: Schema.String,
    form: Schema.String,
    commandId: CommandId,
    issues: Schema.Array(Schema.Struct({ field: Schema.String, message: Schema.String })),
    submitted: Schema.Array(Schema.Tuple([Schema.String, Schema.Array(Schema.String)])),
  }),
);

/** The id under which a page embeds its `FormIssues`. */
export const issuesScriptId = "effect-frame-form-issues";

/** `FormIssues` as the JSON a page embeds. */
export const encodeIssues = (issues: FormIssues): Effect.Effect<string> =>
  Effect.orDie(
    Schema.encodeEffect(IssuesJson)({ ...issues, submitted: Array.from(issues.submitted) }),
  );

/** The JSON a page embedded, back to `FormIssues`. */
export const decodeIssues = (json: string): Effect.Effect<FormIssues, Schema.SchemaError> =>
  Effect.map(Schema.decodeEffect(IssuesJson)(json), (decoded): FormIssues => ({
    ...decoded,
    submitted: new Map(decoded.submitted),
  }));

/**
 * Provide the issues a page carried, when it carried any. A client mounts
 * through this, so its first render draws the refused form the server drew.
 */
export const provideIssues =
  (issues: Option.Option<FormIssues>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Option.match(issues, {
      onNone: () => effect,
      onSome: (found) => Effect.provideService(effect, FormContext, found),
    });

const formatter = SchemaIssue.makeFormatterStandardSchemaV1();

/** Standard Schema allows a segment wrapped as `{ key }`. */
const keyOfSegment = (segment: PropertyKey | { readonly key: PropertyKey }): PropertyKey => {
  if (Predicate.isObject(segment)) {
    return segment.key;
  }
  return segment;
};

const pathOf = (path: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>): string =>
  path.map(keyOfSegment).reduce<string>((out, segment) => {
    if (Predicate.isNumber(segment)) {
      return `${out}[${String(segment)}]`;
    }
    if (out === "") {
      return String(segment);
    }
    return `${out}.${String(segment)}`;
  }, "");

/** A schema failure as issues, each named by the field that carried it. */
export const issuesOf = (error: Schema.SchemaError): ReadonlyArray<FormIssue> =>
  formatter(error.issue).issues.map((issue) => ({
    field: pathOf(Option.getOrElse(Option.fromNullishOr(issue.path), () => [])),
    message: issue.message,
  }));

// ---------------------------------------------------------------------------
// The actor key in a form
// ---------------------------------------------------------------------------

const decodeJsonTree = Schema.decodeEffect(Schema.fromJsonString(Tree));

/**
 * The key as `$key` carries it: `tenant=demo&list=inbox`. A person reading
 * view-source reads that, not JSON.
 */
export const encodeKey = <C extends AnyContract>(
  contract: C,
  key: KeyOf<C>,
): Effect.Effect<string> =>
  Schema.encodeEffect(contract.key)(key).pipe(
    Effect.flatMap(decodeJsonTree),
    Effect.map((encoded) => toBody(flatten(encoded))),
    Effect.orDie,
  );

/** `$key` back to the wire's JSON key string, through the key schema. */
export const decodeKey = (
  contract: AnyContract,
  raw: string,
): Effect.Effect<string, FormMalformed> =>
  Effect.gen(function* () {
    const nested = yield* tree(fromBody(raw));
    const key = yield* Effect.mapError(
      Schema.decodeUnknownEffect(contract.raw.key)(nested),
      (error) => FormMalformed.make({ reason: `$key: ${error.message}` }),
    );
    return yield* Effect.orDie(Schema.encodeUnknownEffect(contract.key)(key));
  });

// ---------------------------------------------------------------------------
// Return paths
// ---------------------------------------------------------------------------

/** Printable ASCII only: no C0 control, no space, no DEL, nothing wider. */
const printable = /^[\x21-\x7e]+$/;
const sentinel = "http://return-path.invalid";

/**
 * Only a root-relative path. `//host` is protocol-relative and leaves the
 * origin, and `/\host` is read the same way by browsers, so both are
 * refused. A URL parser drops tab, LF, and CR before it reads, so
 * `/<tab>/host` is `//host` to a browser: every control character, space,
 * and DEL is refused before the prefix is read. The path must then resolve
 * against a sentinel base to that same origin. An absolute URL is refused
 * even on this origin. A `$return` that passes is also a valid `Location`
 * header, so the reply can never fail after the send.
 */
export const isReturnPath = (raw: string): boolean =>
  printable.test(raw) &&
  raw.startsWith("/") &&
  !raw.startsWith("//") &&
  !raw.startsWith("/\\") &&
  Option.exists(Option.fromNullishOr(URL.parse(raw, sentinel)), (url) => url.origin === sentinel);
