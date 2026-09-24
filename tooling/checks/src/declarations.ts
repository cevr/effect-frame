// oxlint-disable effect/noGlobals -- Bun.Glob and Bun.file read the built declarations: the rule checks what a consumer installs.
import { Effect } from "effect";

/**
 * The published declarations, as a build rule.
 *
 * A declaration emitter that cannot resolve a type does not fail: it writes
 * `any`, or `unknown` for an Effect's error and requirements, and the source
 * still typechecks. A consumer then gets a widened type that no test in this
 * repository sees, because the tests read the source. So the rule reads what
 * a consumer installs, each `dist/**\/*.d.ts` of each package, after the
 * build.
 *
 * It refuses two kinds:
 * - `any` in a type position. Once comments, string literals, and export or
 *   import name lists are gone, an `any` that is not a declared name or a
 *   `typeof` reference is a type.
 * - `unknown` as the requirements of an `Effect`, a `Stream`, or a `Layer`,
 *   read from the type arguments across lines. No published type needs an
 *   unknown requirement; an unresolved inferred one becomes it.
 */

/** One leaked type, at its 1-based line. */
export interface Leak {
  readonly line: number;
  readonly kind: "any" | "unknown requirements";
  readonly text: string;
}

/**
 * Blank out comments and string literals, keeping every newline, so a match
 * in what remains is a type and its line number is the file's.
 */
const typesOnly = (source: string): string =>
  source.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g,
    (match) => match.replace(/[^\n]/g, " "),
  );

/** Blank out `export { ... }` and `import { ... }` lists: they name values, not types. */
const withoutNameLists = (text: string): string =>
  text.replace(/\b(?:export|import)\s+(?:type\s+)?\{[^}]*\}/g, (match) =>
    match.replace(/[^\n]/g, " "),
  );

/** `any` as a type, not a name: `Policy.any` is declared as `const any:` and read as `typeof any`. */
const anyType = /(?<!typeof\s+|const\s+|let\s+|function\s+|\.)\bany\b(?!\s*[:?(])/g;

/**
 * A type whose third argument is its requirements: `Effect`, `Stream`, and
 * `Layer` (its input). An unresolved inferred type becomes `unknown` there.
 */
const withRequirements = /\b(?:Effect\.Effect|Effect|Stream\.Stream|Stream|Layer\.Layer|Layer)</g;

const lineAt = (text: string, offset: number): number => text.slice(0, offset).split("\n").length;

/**
 * The top-level type arguments of the list that opens just before `start`,
 * read across lines with balanced brackets. `=>` is an arrow, not a close.
 */
const typeArguments = (text: string, start: number): ReadonlyArray<string> => {
  const found: Array<string> = [];
  let depth = 1;
  let from = start;
  for (let at = start; at < text.length && depth > 0; at += 1) {
    const char = text.charAt(at);
    if (char === "=" && text.charAt(at + 1) === ">") {
      at += 1;
    } else if ("<([{".includes(char)) {
      depth += 1;
    } else if (">)]}".includes(char)) {
      depth -= 1;
    } else if (char === "," && depth === 1) {
      found.push(text.slice(from, at));
      from = at + 1;
    }
    if (depth === 0) {
      found.push(text.slice(from, at));
    }
  }
  return found.map((one) => one.trim());
};

/** Every leaked type in one declaration file's text. */
export const leaksIn = (source: string): ReadonlyArray<Leak> => {
  const original = source.split("\n");
  const types = typesOnly(source);
  const leak = (kind: Leak["kind"], line: number): Leak => ({
    line,
    kind,
    text: (original[line - 1] ?? "").trim(),
  });
  const anys = Array.from(withoutNameLists(types).matchAll(anyType), (match) =>
    leak("any", lineAt(types, match.index)),
  );
  const unknowns = Array.from(types.matchAll(withRequirements)).flatMap((match) => {
    const argumentsAt = match.index + match[0].length;
    if (typeArguments(types, argumentsAt)[2] !== "unknown") {
      return [];
    }
    return [leak("unknown requirements", lineAt(types, match.index))];
  });
  return [...anys, ...unknowns].toSorted((a, b) => a.line - b.line);
};

/** The declaration files a package publishes, relative to the repository root. */
const declarationFiles = (root: string) =>
  Effect.sync(() =>
    Array.from(new Bun.Glob("packages/*/dist/**/*.d.ts").scanSync({ cwd: root })).toSorted(),
  );

/** One file's leaks, with its path relative to the repository root. */
export interface FileLeaks {
  readonly file: string;
  readonly leaks: ReadonlyArray<Leak>;
}

/** Every published declaration file under `root` that leaks a type. */
export const checkDeclarations = (root: string) =>
  Effect.gen(function* () {
    const files = yield* declarationFiles(root);
    const checked = yield* Effect.forEach(
      files,
      (file) =>
        Effect.map(
          Effect.promise(() => Bun.file(`${root}/${file}`).text()),
          (text): FileLeaks => ({ file, leaks: leaksIn(text) }),
        ),
      { concurrency: 8 },
    );
    return { files: files.length, leaking: checked.filter((one) => one.leaks.length > 0) };
  });

/** One leak as the gate prints it: `file:line: kind: text`. */
export const formatLeak = (file: string, leak: Leak): string =>
  `${file}:${String(leak.line)}: ${leak.kind}: ${leak.text}`;
