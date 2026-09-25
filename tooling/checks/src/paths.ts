import { Array as Arr, Option } from "effect";

/**
 * The repository paths the docs cite, as a build rule.
 *
 * A doc names a file in backticks: `packages/effect-frame/src/view/view.ts`.
 * When the file moves, the doc still reads well and points at nothing, and
 * the acceptance matrix, whose proof column is a list of test files and test
 * names, stops being proof. So the rule reads every tracked Markdown file and
 * refuses a backticked repository path that no tracked file or directory
 * has, and a test name cited after a test file that the file does not hold.
 *
 * Three things are not refused, each because the doc says so where it is
 * written:
 * - a table row whose last cell (its status) says Open or Superseded: an
 *   Open row names the test that will prove it, and a Superseded row names
 *   the one that was removed;
 * - a file that declares `<!-- paths: other repositories -->`, because its
 *   paths belong to the repositories it studies;
 * - a path qualified with another repository or a git revision,
 *   `bible-tools:apps/…` or `93bcf80:packages/…`, which is not a path in this
 *   tree.
 */

/** The top-level directories whose paths a doc cites. */
const roots = ["packages/", "apps/", "tooling/", "docs/", ".github/", ".claude/", ".changeset/"];

/** A file that declares this cites other repositories' paths. */
export const otherRepositoriesMarker = "<!-- paths: other repositories -->";

/** A status that names a proof which does not exist yet, or no longer does. */
const exemptStatus = /\b(?:open|superseded)\b/i;

/** One refused citation, at its 1-based line. */
export interface DeadCitation {
  readonly line: number;
  readonly kind: "path" | "test name";
  readonly text: string;
}

/** What the rule reads from the repository. */
export interface Tree {
  /** Whether a tracked file or directory has this path. */
  readonly exists: (path: string) => boolean;
  /** The text of a tracked file. */
  readonly read: (path: string) => Option.Option<string>;
}

const isExemptRow = (line: string): boolean => {
  if (!line.startsWith("|")) {
    return false;
  }
  const cells = line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|");
  return Option.exists(Arr.last(cells), (status) => exemptStatus.test(status));
};

/**
 * The repository path a backticked span names, with any `:line` suffix or
 * `#anchor` removed, or nothing when the span is not a path: a glob, a
 * template, or a span with a space.
 */
const pathIn = (span: string): ReadonlyArray<string> => {
  if (!roots.some((root) => span.startsWith(root)) || /[\s*{}<>…$]/.test(span)) {
    return [];
  }
  return [span.replace(/#.*$/, "").replace(/(?::\d+(?:-\d+)?)+$/, "")];
};

/** The strings a test file could build a test title from, and each as a pattern where `${…}` matches any text. */
interface Titles {
  readonly literals: ReadonlyArray<string>;
  readonly patterns: ReadonlyArray<RegExp>;
}

const titlesIn = (source: string): Titles => {
  const literals = Array.from(
    source.matchAll(/`(?:[^`\\]|\\.)*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g),
    (match) => match[0].slice(1, -1).replace(/\\(.)/g, "$1"),
  );
  const patterns = literals.map((body) => {
    const parts = body.split(/\$\{[^}]*\}/);
    const escaped = parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp(`^${escaped.join(".+")}$`, "s");
  });
  return { literals, patterns };
};

/** `a/b/../c` as `a/c`. */
const normalize = (path: string): string =>
  path
    .split("/")
    .reduce<ReadonlyArray<string>>((parts, part) => {
      if (part === "..") {
        return parts.slice(0, -1);
      }
      if (part === ".") {
        return parts;
      }
      return Arr.append(parts, part);
    }, [])
    .join("/");

/**
 * A test file's text and the text of each module it imports by a relative
 * path, one level deep: a shared suite names its tests in its own file.
 */
const sourcesOf = (path: string, tree: Tree): ReadonlyArray<string> =>
  Option.match(tree.read(path), {
    onNone: () => [],
    onSome: (source) => {
      const directory = path.replace(/\/[^/]*$/, "");
      const imported = Array.from(source.matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g), (match) =>
        normalize(`${directory}/${match[0].replace(/^from\s+["']|["']$/g, "")}`),
      ).flatMap((base) => {
        const stem = base.replace(/\.[cm]?[jt]sx?$/, "");
        return Arr.findFirst([`${stem}.ts`, `${stem}.tsx`], (candidate) =>
          Option.isSome(tree.read(candidate)),
        ).pipe(
          Option.flatMap(tree.read),
          Option.match({ onNone: () => [], onSome: (text) => [text] }),
        );
      });
      return [source, ...imported];
    },
  });

/**
 * Whether one cited title, or one side of `outer > inner`, is a title the
 * files hold. A `…` in the citation elides text: each part around it must
 * appear in one of the file's strings.
 */
const holds = (piece: string, titles: Titles): boolean => {
  if (!piece.includes("…")) {
    return titles.patterns.some((pattern) => pattern.test(piece));
  }
  return piece
    .split("…")
    .map((part) => part.trim().replace(/^:\s*|\s*:$/g, ""))
    .filter((part) => part.length > 0)
    .every((part) => titles.literals.some((literal) => literal.includes(part)));
};

/**
 * The test names a proof cites after a test file: the quoted strings that
 * follow `— ` up to the first text that is not a separator. A `describe`
 * title and an `it` title are cited as `outer > inner`.
 */
const citedNames = (tail: string): ReadonlyArray<string> =>
  Option.match(Option.fromNullishOr(/^\s*—\s*((?:"[^"]*"(?:,\s*|\s+and\s+|;\s*)?)+)/.exec(tail)), {
    onNone: () => [],
    onSome: (list) => Array.from(list[0].matchAll(/"([^"]*)"/g), (name) => name[0].slice(1, -1)),
  });

const testFile = /`((?:packages|apps|tooling)\/[^`\s]+\.test\.tsx?)`/;

/** The cited names a test file does not hold as a title, `describe > it` read piece by piece. */
const missingNames = (line: string, tree: Tree): ReadonlyArray<string> => {
  const pieces = line.split(testFile);
  return pieces.flatMap((path, index) => {
    if (index % 2 === 0) {
      return [];
    }
    const sources = sourcesOf(path, tree);
    if (sources.length === 0) {
      return [];
    }
    const titles = titlesIn(sources.join("\n"));
    const tail = Option.getOrElse(Arr.get(pieces, index + 1), () => "");
    return citedNames(tail).filter(
      (name) => !name.split(" > ").every((piece) => holds(piece, titles)),
    );
  });
};

/** Every dead citation in one Markdown file's text. */
export const deadCitations = (markdown: string, tree: Tree): ReadonlyArray<DeadCitation> => {
  if (markdown.includes(otherRepositoriesMarker)) {
    return [];
  }
  return markdown.split("\n").flatMap((line, index): ReadonlyArray<DeadCitation> => {
    if (isExemptRow(line)) {
      return [];
    }
    const paths = Array.from(line.matchAll(/`[^`]+`/g), (match) => match[0].slice(1, -1))
      .flatMap(pathIn)
      .filter((path) => !tree.exists(path))
      .map((text): DeadCitation => ({ line: index + 1, kind: "path", text }));
    const names = missingNames(line, tree).map((text): DeadCitation => ({
      line: index + 1,
      kind: "test name",
      text,
    }));
    return Arr.appendAll(paths, names);
  });
};

/** One dead citation as the gate prints it: `file:line: kind: text`. */
export const formatCitation = (file: string, citation: DeadCitation): string =>
  `${file}:${String(citation.line)}: ${citation.kind}: ${citation.text}`;
