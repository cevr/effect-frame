import { Option, Predicate } from "effect";

/**
 * A citation names something the package has.
 *
 * JSDoc, the reference docs and the changesets name the API as
 * `Head.member`: in backticks, or in a ts or tsx fence. When the API moves,
 * nothing compiles those names, so `Query.batched` and `Actor.spawn` stayed
 * in the text after the code was gone. The rule reads every such citation:
 *
 * - A head that is an effect-frame name (a value or a type a subpath
 *   exports, or a namespace alias of a subpath, as
 *   `import * as Driven from "effect-frame/view/driven"`) must have the
 *   member: a runtime member (`member in value`, so an inherited static
 *   counts), a type its namespace exports, a field of its interface, or a
 *   member of Effect's module of the same name (`Match`). An interface that
 *   extends another, or a type that is not an object literal, is open: any
 *   member resolves.
 * - In a changeset an unknown head must be someone else's name: an Effect
 *   module, a global, a name a module of the repository exports, or a
 *   span. A
 *   changeset that names a removed API lists it in
 *   `<!-- removed: Query, QueryCache.layerTest -->`, which exempts the head
 *   or the citation.
 *
 * JSDoc and reference docs do not refuse an unknown head: they cite span
 * names, file names and other libraries in the same form.
 */

/** What the rule knows about the names a citation can use. */
export interface Facts {
  /** Each effect-frame head's runtime values: an export, or a subpath module an alias names. */
  readonly values: ReadonlyMap<string, ReadonlyArray<object>>;
  /** Each effect-frame type head's members; `None` when any member resolves. */
  readonly types: ReadonlyMap<string, Option.Option<ReadonlySet<string>>>;
  /** Effect's own modules, by name, as `import * as Effect from "effect"` loads them. */
  readonly effect: ReadonlyMap<string, object>;
  /** Every Effect module name, the unstable ones included (`HttpRouter`). */
  readonly effectModules: ReadonlySet<string>;
  /** Every PascalCase name a module of the repository exports. */
  readonly declared: ReadonlySet<string>;
  /** Every `Effect.fn` span name. */
  readonly spans: ReadonlySet<string>;
}

/** Where a text comes from, which decides what the rule reads in it. */
export type Kind = "jsdoc" | "doc" | "changeset";

/** A citation that names nothing, at its 1-based line. */
export interface DeadCitation {
  readonly line: number;
  readonly citation: string;
}

const token = /(?<![\w$.])([A-Z][\w$]*)\.([A-Za-z_$][\w$]*)/g;
const inlineCode = /`([^`\n]+)`/g;
const fence = /^```(\S*)/;
const jsdocPrefix = /^\s*\*\s?/;
const removedMarker = /<!--\s*removed:([^>]*)-->/g;
const fileLike: ReadonlySet<string> = new Set(["md", "js", "mjs", "ts", "tsx", "json", "yml"]);
const globals: ReadonlySet<string> = new Set([
  "Bun",
  "Object",
  "Array",
  "JSON",
  "Math",
  "Number",
  "String",
  "Promise",
  "Symbol",
]);

/** The lines the rule reads, with their 1-based numbers: a source's JSDoc, or the whole doc. */
const readLines = (kind: Kind, text: string): ReadonlyArray<readonly [number, string]> => {
  const lines = text.split("\n").map((line, index): readonly [number, string] => [index + 1, line]);
  if (kind !== "jsdoc") {
    return lines;
  }
  let inside = false;
  return lines.flatMap(([number, line]): ReadonlyArray<readonly [number, string]> => {
    const opens = !inside && line.trimStart().startsWith("/**");
    inside = inside || opens;
    if (!inside) {
      return [];
    }
    inside = !line.includes("*/");
    return [
      [
        number,
        line
          .replace(/^\s*\/\*\*/, "")
          .replace(/\*\/.*$/, "")
          .replace(jsdocPrefix, ""),
      ],
    ];
  });
};

/** Every `Head.member` a text cites: all of a ts fence's code, and the inline code elsewhere. */
const citationsOf = (
  kind: Kind,
  text: string,
): ReadonlyArray<{ readonly line: number; readonly head: string; readonly member: string }> => {
  let mode: "prose" | "code" | "other" = "prose";
  return readLines(kind, text).flatMap(([line, content]) => {
    const opening = fence.exec(content.trim());
    if (Predicate.isNotNull(opening)) {
      const language = opening[1] ?? "";
      mode = Fences.after(mode, language);
      return [];
    }
    const code = Fences.codeOf(mode, content);
    return code.flatMap((span) =>
      Array.from(span.matchAll(token), (match) => ({
        line,
        head: match[1] ?? "",
        member: match[2] ?? "",
      })),
    );
  });
};

/** The fence state after a fence line, and the code a line holds in a state. */
const Fences = {
  after: (mode: "prose" | "code" | "other", language: string): "prose" | "code" | "other" => {
    if (mode !== "prose") {
      return "prose";
    }
    if (language === "ts" || language === "tsx") {
      return "code";
    }
    return "other";
  },
  codeOf: (mode: "prose" | "code" | "other", content: string): ReadonlyArray<string> => {
    if (mode === "code") {
      return [content];
    }
    if (mode === "other") {
      return [];
    }
    return Array.from(content.matchAll(inlineCode), (match) => match[1] ?? "");
  },
};

// oxlint-disable-next-line effect/noObjectParameters -- a module exports whatever it exports: the rule asks only whether a member is in it.
const hasMember = (value: object, member: string): boolean => member in value;

const resolves = (facts: Facts, head: string, member: string): boolean =>
  Option.getOrElse(Option.fromNullishOr(facts.values.get(head)), () => []).some((value) =>
    hasMember(value, member),
  ) ||
  Option.exists(Option.fromNullishOr(facts.types.get(head)), (members) =>
    Option.match(members, { onNone: () => true, onSome: (known) => known.has(member) }),
  ) ||
  Option.exists(Option.fromNullishOr(facts.effect.get(head)), (module) =>
    hasMember(module, member),
  );

const isKnown = (facts: Facts, head: string): boolean =>
  facts.values.has(head) || facts.types.has(head);

const isForeign = (facts: Facts, head: string, member: string): boolean =>
  facts.effectModules.has(head) ||
  facts.declared.has(head) ||
  globals.has(head) ||
  facts.spans.has(`${head}.${member}`) ||
  fileLike.has(member);

/** The names a changeset's `<!-- removed: … -->` markers list. */
const removedIn = (text: string): ReadonlySet<string> =>
  new Set(
    Array.from(text.matchAll(removedMarker), (match) => match[1] ?? "").flatMap((list) =>
      list
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0),
    ),
  );

/** Every citation of a text that names nothing, once per line. */
export const deadCitations = (
  kind: Kind,
  text: string,
  facts: Facts,
): ReadonlyArray<DeadCitation> => {
  const removed = removedIn(text);
  const seen = new Set<string>();
  return citationsOf(kind, text).flatMap(({ line, head, member }) => {
    const citation = `${head}.${member}`;
    const marked = removed.has(head) || removed.has(citation);
    const dead =
      (isKnown(facts, head) && !resolves(facts, head, member)) ||
      (!isKnown(facts, head) && kind === "changeset" && !isForeign(facts, head, member));
    const key = `${String(line)} ${citation}`;
    if (!dead || marked || seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [{ line, citation }];
  });
};

/** One dead citation as the gate prints it. */
export const formatCitation = (file: string, dead: DeadCitation): string =>
  `${file}:${String(dead.line)}: ${dead.citation} names nothing effect-frame has; cite the current name, or list a removed one in <!-- removed: … --> in a changeset`;

const declaration =
  /export\s+(?:declare\s+)?(?:abstract\s+)?(?:interface|type|class|const|let|function\s*\*?|enum|namespace)\s+([A-Za-z_$][\w$]*)/g;
const exportList = /export\s+(?:type\s+)?\{([^}]*)\}/g;
const namespaceExport = /export\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from/g;

/** The names a module's text exports itself, as types and values. `export *` is followed by the caller. */
export const typeExportsOf = (text: string): ReadonlySet<string> =>
  new Set([
    ...Array.from(text.matchAll(declaration), (match) => match[1] ?? ""),
    ...Array.from(text.matchAll(exportList), (match) => match[1] ?? "").flatMap((list) =>
      list
        .split(",")
        .map(
          (part) =>
            part
              .trim()
              .replace(/^type\s+/, "")
              .split(/\s+as\s+/)
              .pop()
              ?.trim() ?? "",
        )
        .filter((name) => name.length > 0),
    ),
    ...Array.from(text.matchAll(namespaceExport), (match) => match[1] ?? ""),
  ]);

const comments = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
const typeStart =
  /^[ \t]*(?:export\s+)?(?:declare\s+)?(interface|type)\s+([A-Z][\w$]*)(?=\s*(?:<|=|\{|extends\b))/gm;
const memberName = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*[:(<]/;
const opens: ReadonlySet<string> = new Set(["{", "(", "["]);
const closes: ReadonlySet<string> = new Set(["}", ")", "]"]);

/** The member names of an object type body that starts after `{` at `from`. */
const bodyMembers = (text: string, from: number): ReadonlySet<string> => {
  const members = new Set<string>();
  let depth = 0;
  let segment = "";
  for (const char of text.slice(from)) {
    if (depth === 0 && (char === ";" || char === "," || char === "\n" || char === "}")) {
      Option.map(Option.fromNullishOr(memberName.exec(segment)?.[1]), (name) => members.add(name));
      segment = "";
      if (char === "}") {
        return members;
      }
      continue;
    }
    depth += Number(opens.has(char)) - Number(closes.has(char));
    segment += char;
  }
  return members;
};

/** One declaration's members, or `None` when it extends another or is not an object type. */
const declaredMembers = (
  text: string,
  kind: string,
  after: number,
): Option.Option<ReadonlySet<string>> => {
  const brace = text.indexOf("{", after);
  const equals = text.indexOf("=", after);
  if (kind === "interface") {
    const head = text.slice(after, brace);
    if (brace < 0 || /\bextends\b/.test(head.replace(/<[^>]*>/g, ""))) {
      return Option.none();
    }
    return Option.some(bodyMembers(text, brace + 1));
  }
  if (
    equals < 0 ||
    !/^\s*(?:<[\s\S]*>)?\s*$/.test(text.slice(after, equals)) ||
    text.slice(equals + 1).trimStart()[0] !== "{"
  ) {
    return Option.none();
  }
  return Option.some(bodyMembers(text, text.indexOf("{", equals) + 1));
};

/**
 * Every interface's and object type's members across sources, by name. A
 * name declared twice has the members of both; `None` if either is open.
 */
export const typeFieldsOf = (
  sources: ReadonlyArray<string>,
): ReadonlyMap<string, Option.Option<ReadonlySet<string>>> => {
  const fields = new Map<string, Option.Option<ReadonlySet<string>>>();
  for (const source of sources) {
    const text = source.replace(comments, "");
    for (const match of text.matchAll(typeStart)) {
      const name = match[2] ?? "";
      const found = declaredMembers(text, match[1] ?? "", match.index + match[0].length);
      const before = Option.getOrElse(Option.fromNullishOr(fields.get(name)), () => found);
      fields.set(
        name,
        Option.zipWith(before, found, (a, b): ReadonlySet<string> => new Set([...a, ...b])),
      );
    }
  }
  return fields;
};
