// oxlint-disable effect/noGlobals -- Bun.spawnSync lists the tracked tree and Bun.file reads it: the rule checks the docs against the files git holds.
import { Effect, Exit, Option } from "effect";
import { repositoryRoot } from "./browser-entries.js";
import { deadCitations, formatCitation, type Tree } from "./paths.js";

/**
 * The cited-path rule as a command. `bun run gate` runs it, and a doc that
 * cites a path or a test name the tree does not hold turns the gate red
 * with the file and line of each one.
 *
 * `plans/` is not read: it holds the architecture loop's working notes,
 * which quote paths as they were on the day of a sweep.
 */

const skipped = /^plans\//;

/** Every tracked file, relative to the repository root. */
const trackedFiles = Effect.sync(() => {
  const listed = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: repositoryRoot });
  return listed.stdout
    .toString()
    .split("\0")
    .filter((file) => file.length > 0);
});

const main = Effect.gen(function* () {
  const files = yield* trackedFiles;
  const tracked = new Set(files);
  const directories = new Set(
    files.flatMap((file) =>
      file
        .split("/")
        .slice(0, -1)
        .map((_, index, parts) => parts.slice(0, index + 1).join("/")),
    ),
  );
  const markdown = files.filter((file) => file.endsWith(".md") && !skipped.test(file));
  const texts = new Map(
    yield* Effect.forEach(
      files.filter((file) => /\.(?:md|tsx?)$/.test(file)),
      (file) =>
        Effect.map(
          Effect.promise(() => Bun.file(`${repositoryRoot}/${file}`).text()),
          (text): readonly [string, string] => [file, text],
        ),
      { concurrency: 16 },
    ),
  );
  const tree: Tree = {
    exists: (path) => tracked.has(path) || directories.has(path.replace(/\/$/, "")),
    read: (path) => Option.fromNullishOr(texts.get(path)),
  };
  const dead = markdown.flatMap((file) =>
    Option.match(tree.read(file), {
      onNone: () => [],
      onSome: (text) => deadCitations(text, tree).map((citation) => formatCitation(file, citation)),
    }),
  );
  if (dead.length === 0) {
    return yield* Effect.log(
      `paths: ${String(markdown.length)} Markdown files cite no missing path or test`,
    );
  }
  yield* Effect.logError(dead.join("\n"));
  return yield* Effect.fail(`paths: ${String(dead.length)} citations name nothing in the tree`);
});

Effect.runFork(
  main.pipe(
    Effect.tapCause((cause) => Effect.logError(cause)),
    Effect.exit,
    Effect.flatMap((exit) =>
      Effect.sync(() => {
        process.exitCode = Exit.match(exit, { onSuccess: () => 0, onFailure: () => 1 });
      }),
    ),
  ),
);
