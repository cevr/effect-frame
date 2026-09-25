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
 */

/** One block the rule refuses: the line of its opening fence, 1-based. */
export interface Drift {
  readonly file: string;
  readonly line: number;
  readonly reason: string;
}

const regionStart = /^\s*\/\/ #region (\S+)\s*$/;
const regionEnd = /^\s*\/\/ #endregion (\S+)\s*$/;
const marker = /^<!-- example: (\S+)#(\S+) -->$/;
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

const lastTextBefore = (lines: ReadonlyArray<string>, index: number): Option.Option<string> =>
  Option.fromNullishOr(
    lines
      .slice(0, index)
      .toReversed()
      .find((text) => text.trim().length > 0),
  );

/** Every ts or tsx block of a markdown file. A block inside another fence is not one. */
const blocksOf = (markdown: string): ReadonlyArray<Block> => {
  const lines = markdown.split("\n");
  const blocks: Array<Block> = [];
  let index = 0;
  while (index < lines.length) {
    const text = lines[index] ?? "";
    if (!anyFence.test(text.trimStart())) {
      index += 1;
      continue;
    }
    // An unclosed fence runs to the end of the file.
    const found = lines.findIndex((later, at) => at > index && later.trim() === "```");
    const end = Math.max(found, 0) || lines.length;
    if (codeFence.test(text.trimStart())) {
      blocks.push({
        open: index,
        close: end,
        body: dedent(lines.slice(index + 1, end)),
        names: Option.flatMap(lastTextBefore(lines, index), (before) =>
          Option.map(Option.fromNullishOr(marker.exec(before.trim())), (match) => ({
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

/** Every block of `markdown` that names no region, names a missing one, or differs from it. */
export const exampleDrift = (
  file: string,
  markdown: string,
  files: ReadonlyMap<string, string>,
): ReadonlyArray<Drift> =>
  blocksOf(markdown).flatMap((block): ReadonlyArray<Drift> => {
    const line = block.open + 1;
    return Option.match(block.names, {
      onNone: () => [{ file, line, reason: "a ts or tsx block names no example region" }],
      onSome: ({ path, region }) =>
        Option.match(regionText(files, path, region), {
          onNone: () => [{ file, line, reason: `names ${path}#${region}, which does not exist` }],
          onSome: (text) =>
            [{ file, line, reason: `differs from ${path}#${region}` }].filter(
              () => text !== block.body,
            ),
        }),
    });
  });

/** `markdown` with every marked block written from its region. A block with no region stays. */
export const synced = (markdown: string, files: ReadonlyMap<string, string>): string => {
  const lines = markdown.split("\n");
  const indentOf = (text: string): string => text.slice(0, text.length - text.trimStart().length);
  return blocksOf(markdown)
    .toReversed()
    .reduce((current, block) => {
      const indent = indentOf(lines[block.open] ?? "");
      return Option.match(
        Option.flatMap(block.names, ({ path, region }) => regionText(files, path, region)),
        {
          onNone: () => current,
          onSome: (text) => [
            ...current.slice(0, block.open + 1),
            ...text.split("\n").map((body) => `${indent}${body}`.trimEnd()),
            ...current.slice(block.close),
          ],
        },
      );
    }, lines)
    .join("\n");
};

/** Every region path a markdown file names, so the command reads only those files. */
export const namedPaths = (markdown: string): ReadonlyArray<string> =>
  Array.from(
    new Set(
      blocksOf(markdown).flatMap((block) =>
        Option.match(block.names, { onNone: () => [], onSome: ({ path }) => [path] }),
      ),
    ),
  );

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
