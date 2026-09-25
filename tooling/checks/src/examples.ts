import { Option } from "effect";

/**
 * Code in the reference docs is code the gate compiles.
 *
 * A reference doc (a README, `AGENTS.md`, `CONTEXT.md`) shows TypeScript
 * only as a region of a file the gate typechecks and tests. The comment
 * above a block names it, `<!-- example: path#region -->`, and the block
 * must be that region's text: the lines between `// #region name` and
 * `// #endregion name`, without any region marker line, dedented. A ts or
 * tsx block with no marker is refused, so no block can drift from the API
 * it shows. `synced` writes every marked block from its region.
 *
 * JSDoc is the reference for a module, so an `@example` block there is held
 * the same way: the tag names the region, ` * @example path#region`, with
 * `path` relative to the source file, and the ts or tsx block after it must
 * be that region's text under the ` * ` prefix. A JSDoc block with no
 * `@example` tag is prose; the citation rule reads it.
 */

/** One block the rule refuses: the line of its opening fence, 1-based. */
export interface Drift {
  readonly file: string;
  readonly line: number;
  readonly reason: string;
}

const regionStart = /^\s*\/\/ #region (\S+)\s*$/;
const regionEnd = /^\s*\/\/ #endregion (\S+)\s*$/;
const codeFence = /^```(ts|tsx)\s*$/;
const anyFence = /^```/;

const isMarkerLine = (text: string): boolean => regionStart.test(text) || regionEnd.test(text);

/** The lines with their common leading whitespace removed. Blank lines do not count. */
const dedent = (lines: ReadonlyArray<string>): string => {
  const indents = lines
    .filter((text) => text.trim().length > 0)
    .map((text) => text.length - text.trimStart().length);
  // `Math.min()` of nothing is Infinity; `slice(Infinity)` would empty every line.
  const cut = Math.min(Number.MAX_SAFE_INTEGER, ...indents);
  return lines.map((text) => text.slice(cut).trimEnd()).join("\n");
};

/** Every region of a source file by name, as a block shows it. */
export const regionsOf = (source: string): ReadonlyMap<string, string> => {
  const lines = source.split("\n");
  const regions = new Map<string, string>();
  lines.forEach((text, index) => {
    Option.map(Option.fromNullishOr(regionStart.exec(text)?.[1]), (name) => {
      const end = lines.findIndex((later, at) => at > index && regionEnd.exec(later)?.[1] === name);
      if (end > index) {
        regions.set(
          name,
          dedent(lines.slice(index + 1, end).filter((body) => !isMarkerLine(body))),
        );
      }
    });
  });
  return regions;
};

/** One ts or tsx block: its fence line, its body lines, and the region its marker names. */
interface Block {
  readonly open: number;
  readonly close: number;
  readonly body: string;
  readonly names: Option.Option<{ readonly path: string; readonly region: string }>;
}

/** Where a kind of file keeps its blocks and how it marks them. */
interface Dialect {
  /** The file's lines as prose, one for one: a JSDoc line without its ` * ` prefix. */
  readonly view: (text: string) => ReadonlyArray<string>;
  /** The line above a block that names its region: `path` is group 1, `region` group 2. */
  readonly marker: RegExp;
  /** Whether a block, given the text above it, is held to a region at all. */
  readonly held: (before: Option.Option<string>) => boolean;
  /** Why a held block that names no region is refused. */
  readonly unmarked: string;
}

const markdownDialect: Dialect = {
  view: (text) => text.split("\n"),
  marker: /^<!-- example: (\S+)#(\S+) -->$/,
  held: () => true,
  unmarked: "a ts or tsx block names no example region",
};

const jsdocLine = /^\s*\*(?: (.*))?$/;

const jsdocDialect: Dialect = {
  view: (text) =>
    text
      .split("\n")
      .map((line) => Option.getOrElse(Option.fromNullishOr(jsdocLine.exec(line)?.[1]), () => "")),
  marker: /^@example (\S+)#(\S+)$/,
  held: (before) => Option.exists(before, (text) => /^@example\b/.test(text.trim())),
  unmarked: "an @example block names no example region",
};

const lastTextBefore = (lines: ReadonlyArray<string>, index: number): Option.Option<string> =>
  Option.fromNullishOr(
    lines
      .slice(0, index)
      .toReversed()
      .find((text) => text.trim().length > 0),
  );

/** Every ts or tsx block a dialect holds. A block inside another fence is not one. */
const blocksOf = (dialect: Dialect, text: string): ReadonlyArray<Block> => {
  const lines = dialect.view(text);
  const blocks: Array<Block> = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!anyFence.test(line.trimStart())) {
      index += 1;
      continue;
    }
    // An unclosed fence runs to the end of the file.
    const found = lines.findIndex((later, at) => at > index && later.trim() === "```");
    const end = Math.max(found, 0) || lines.length;
    const before = lastTextBefore(lines, index);
    if (codeFence.test(line.trimStart()) && dialect.held(before)) {
      blocks.push({
        open: index,
        close: end,
        body: dedent(lines.slice(index + 1, end)),
        names: Option.flatMap(before, (above) =>
          Option.map(Option.fromNullishOr(dialect.marker.exec(above.trim())), (match) => ({
            path: match[1] ?? "",
            region: match[2] ?? "",
          })),
        ),
      });
    }
    index = end + 1;
  }
  return blocks;
};

const regionText = (
  files: ReadonlyMap<string, string>,
  path: string,
  region: string,
): Option.Option<string> =>
  Option.flatMap(Option.fromNullishOr(files.get(path)), (source) =>
    Option.fromNullishOr(regionsOf(source).get(region)),
  );

const driftOf =
  (dialect: Dialect) =>
  (file: string, text: string, files: ReadonlyMap<string, string>): ReadonlyArray<Drift> =>
    blocksOf(dialect, text).flatMap((block): ReadonlyArray<Drift> => {
      const line = block.open + 1;
      return Option.match(block.names, {
        onNone: () => [{ file, line, reason: dialect.unmarked }],
        onSome: ({ path, region }) =>
          Option.match(regionText(files, path, region), {
            onNone: () => [{ file, line, reason: `names ${path}#${region}, which does not exist` }],
            onSome: (body) =>
              [{ file, line, reason: `differs from ${path}#${region}` }].filter(
                () => body !== block.body,
              ),
          }),
      });
    });

/** Every block of a markdown doc that names no region, names a missing one, or differs from it. */
export const exampleDrift = driftOf(markdownDialect);

/** Every `@example` block of a source file's JSDoc that names no region, a missing one, or differs from it. */
export const jsdocDrift = driftOf(jsdocDialect);

/** The text with every marked block written from its region, under the fence's prefix. */
const syncedOf =
  (dialect: Dialect) =>
  (text: string, files: ReadonlyMap<string, string>): string => {
    const lines = text.split("\n");
    return blocksOf(dialect, text)
      .toReversed()
      .reduce((current, block) => {
        const fence = lines[block.open] ?? "";
        const prefix = fence.slice(0, fence.indexOf("```"));
        return Option.match(
          Option.flatMap(block.names, ({ path, region }) => regionText(files, path, region)),
          {
            onNone: () => current,
            onSome: (body) => [
              ...current.slice(0, block.open + 1),
              ...body.split("\n").map((line) => `${prefix}${line}`.trimEnd()),
              ...current.slice(block.close),
            ],
          },
        );
      }, lines)
      .join("\n");
  };

/** `markdown` with every marked block written from its region. A block with no region stays. */
export const synced = syncedOf(markdownDialect);

/** A source file with every `@example` block written from its region, under the ` * ` prefix. */
export const syncedJsdoc = syncedOf(jsdocDialect);

const pathsOf =
  (dialect: Dialect) =>
  (text: string): ReadonlyArray<string> =>
    Array.from(
      new Set(
        blocksOf(dialect, text).flatMap((block) =>
          Option.match(block.names, { onNone: () => [], onSome: ({ path }) => [path] }),
        ),
      ),
    );

/** Every region path a markdown file names, so the command reads only those files. */
export const namedPaths = pathsOf(markdownDialect);

/** Every region path a source file's `@example` tags name. */
export const jsdocPaths = pathsOf(jsdocDialect);

/** One drift as the gate prints it. */
export const formatDrift = (drift: Drift): string =>
  `${drift.file}:${String(drift.line)}: ${drift.reason}`;

const referenceDoc =
  /^(?:README\.md|AGENTS\.md|CONTEXT\.md|docs\/toolchain\.md|(?:packages|apps)\/[^/]+\/README\.md|\.claude\/skills\/.+\.md)$/;

/**
 * Whether a tracked file is a reference doc, which the rule reads. The
 * decision records in `docs/design/` and `docs/research/`, the changesets,
 * and `plans/` quote code as it was on their day, and are not read.
 */
export const isReferenceDoc = (path: string): boolean => referenceDoc.test(path);

/** A path a marker names, from the directory of the doc that names it. */
export const resolveFrom = (doc: string, path: string): string => {
  const parts = doc.split("/").slice(0, -1);
  for (const part of path.split("/")) {
    if (part === "..") {
      parts.pop();
    } else if (part !== ".") {
      parts.push(part);
    }
  }
  return parts.join("/");
};
