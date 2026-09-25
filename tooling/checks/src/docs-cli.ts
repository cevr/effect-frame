// oxlint-disable effect/noGlobals -- Bun.spawnSync lists the tracked tree and Bun.file reads and writes the docs: the rules check the text a reader opens.
import { Effect, Exit, Option } from "effect";
import { repositoryRoot } from "./browser-entries.js";
import {
  exampleDrift,
  formatDrift,
  isReferenceDoc,
  jsdocDrift,
  jsdocPaths,
  namedPaths,
  resolveFrom,
  synced,
  syncedJsdoc,
  type Drift,
} from "./examples.js";
import { accidentalMajors, decodeWorkspace, firstMajor } from "./changesets.js";
import { formatRepeat, repeatedTerms } from "./glossary.js";

/**
 * The docs rules as a command. `bun run gate` runs it:
 *
 * - `CONTEXT.md` defines each term once (`glossary.ts`).
 * - Every ts or tsx block in a reference doc, and every `@example` block in
 *   the JSDoc of `packages/*\/src`, is a region of a file the gate compiles,
 *   word for word (`examples.ts`).
 * - No package goes to 1.0 by accident: no `major` changeset on a 0.x
 *   package, and no published package at 1.0, until `firstMajor` is set
 *   (`changesets.ts`).
 *
 * `bun run docs --fix` writes every marked block from its region first.
 */

const glossaryFile = "CONTEXT.md";
const fixing = process.argv.includes("--fix");

const read = (file: string) => Effect.promise(() => Bun.file(`${repositoryRoot}/${file}`).text());

const glossaryRule = Effect.gen(function* () {
  const text = yield* read(glossaryFile);
  const repeats = repeatedTerms(text).map((repeat) => formatRepeat(glossaryFile, repeat));
  if (repeats.length === 0) {
    return yield* Effect.log(`docs: ${glossaryFile} defines each term once`);
  }
  yield* Effect.logError(repeats.join("\n"));
  return yield* Effect.fail(`docs: ${String(repeats.length)} glossary terms are defined twice`);
});

/** The tracked files `keep` admits, relative to the repository root. */
const tracked = (keep: (file: string) => boolean) =>
  Effect.sync(() =>
    Bun.spawnSync(["git", "ls-files", "-z"], { cwd: repositoryRoot })
      .stdout.toString()
      .split("\0")
      .filter(keep),
  );

/** Every tracked reference doc. */
const referenceDocs = tracked(isReferenceDoc);

/** How the rule reads one kind of file: its blocks, their region paths, and the fix. */
interface Reading {
  readonly paths: (text: string) => ReadonlyArray<string>;
  readonly drift: (
    file: string,
    text: string,
    sources: ReadonlyMap<string, string>,
  ) => ReadonlyArray<Drift>;
  readonly synced: (text: string, sources: ReadonlyMap<string, string>) => string;
}

const docReading: Reading = { paths: namedPaths, drift: exampleDrift, synced };
const jsdocReading: Reading = { paths: jsdocPaths, drift: jsdocDrift, synced: syncedJsdoc };

/** The sources a file's markers name, keyed as the markers write them. A missing file is left out. */
const sourcesOf = (reading: Reading, doc: string, text: string) =>
  Effect.map(
    Effect.forEach(reading.paths(text), (path) => {
      const file = Bun.file(`${repositoryRoot}/${resolveFrom(doc, path)}`);
      return Effect.flatMap(
        Effect.promise(() => file.exists()),
        (exists): Effect.Effect<ReadonlyArray<readonly [string, string]>> =>
          Effect.when(
            Effect.map(
              Effect.promise(() => file.text()),
              (source): ReadonlyArray<readonly [string, string]> => [[path, source]],
            ),
            Effect.succeed(exists),
          ).pipe(Effect.map((found) => Option.getOrElse(found, () => []))),
      );
    }),
    (entries) => new Map(entries.flat()),
  );

/** One file's refused blocks; with `--fix`, after writing its marked blocks. */
const driftsOf = (reading: Reading, file: string) =>
  Effect.gen(function* () {
    const text = yield* read(file);
    const sources = yield* sourcesOf(reading, file, text);
    if (fixing) {
      const written = reading.synced(text, sources);
      if (written !== text) {
        yield* Effect.promise(() => Bun.write(`${repositoryRoot}/${file}`, written));
        yield* Effect.log(`docs: wrote the examples of ${file}`);
      }
      return reading.drift(file, written, sources);
    }
    return reading.drift(file, text, sources);
  });

const sourceFile = /^packages\/[^/]+\/src\/.+\.tsx?$/;

const examplesRule = Effect.gen(function* () {
  const docs = yield* referenceDocs;
  const sources = yield* tracked((file) => sourceFile.test(file));
  const drifts = yield* Effect.all([
    Effect.forEach(docs, (doc) => driftsOf(docReading, doc)),
    Effect.forEach(sources, (source) => driftsOf(jsdocReading, source), { concurrency: 16 }),
  ]);
  const refused = drifts.flat(2).map(formatDrift);
  if (refused.length === 0) {
    return yield* Effect.log(
      `docs: every ts and tsx block in ${String(docs.length)} reference docs, and every @example in ${String(sources.length)} source files, is a compiled example`,
    );
  }
  yield* Effect.logError(refused.join("\n"));
  return yield* Effect.fail(
    `docs: ${String(refused.length)} blocks are not compiled examples; mark each <!-- example: path#region --> (or @example path#region) and run bun run docs --fix`,
  );
});

const manifestPath = /^(?:packages|apps|tooling)\/[^/]+\/package\.json$/;
const changesetPath = /^\.changeset\/[^/]+\.md$/;

const changesetRule = Effect.gen(function* () {
  const manifests = yield* tracked((file) => manifestPath.test(file));
  const workspace = yield* Effect.forEach(manifests, (manifest) =>
    Effect.flatMap(read(manifest), decodeWorkspace),
  );
  const files = yield* tracked((file) => changesetPath.test(file));
  const changesets = new Map(
    yield* Effect.forEach(files, (file) =>
      Effect.map(read(file), (text): readonly [string, string] => [
        file.replace(/^\.changeset\//, ""),
        text,
      ]),
    ),
  );
  const refused = accidentalMajors(firstMajor, workspace, changesets);
  if (refused.length === 0) {
    return yield* Effect.log(
      `docs: ${String(changesets.size)} changesets take no package to 1.0 by accident`,
    );
  }
  yield* Effect.logError(refused.join("\n"));
  return yield* Effect.fail(`docs: ${String(refused.length)} releases would make a first major`);
});

// Every rule runs and reports, whichever fails first.
const main = Effect.all([
  Effect.exit(glossaryRule),
  Effect.exit(examplesRule),
  Effect.exit(changesetRule),
]).pipe(Effect.flatMap((exits) => Effect.all(exits, { discard: true })));

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
