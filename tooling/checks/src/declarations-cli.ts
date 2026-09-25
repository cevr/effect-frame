import { Effect, Exit } from "effect";
import { repositoryRoot } from "./browser-entries.js";
import { readFacts } from "./citation-facts.js";
import { deadCitations, formatCitation, type Kind } from "./citations.js";
import { isReferenceDoc } from "./examples.js";
import { checkDeclarations, formatLeak } from "./declarations.js";
import { checkSubpaths, formatMissing } from "./subpaths.js";
import {
  collisions,
  declaredAliases,
  declaredSynonyms,
  duplicatePaths,
  formatCollision,
  readSurfaces,
} from "./collisions.js";

/**
 * The declaration rules as a command. `bun run gate` runs it after the
 * build. A published subpath whose `types` or `default` file the build did
 * not write, or a leaked `any` or `unknown` in any package's `dist`, turns
 * the gate red with the file of each one, and so does a value name that
 * two subpaths export, or a value a reader can import by two paths
 * (`collisions.ts`), and so does a `Head.member` citation in JSDoc, a
 * reference doc or a changeset that names nothing the package has
 * (`citations.ts`). It also writes the consumer
 * module that imports every published subpath, which `tsc -p consumer`
 * then compiles against `dist`.
 */

const subpathRule = Effect.gen(function* () {
  const checked = yield* checkSubpaths(repositoryRoot);
  const missing = checked.flatMap((one) =>
    one.missing.map((file) => formatMissing(one.name, file)),
  );
  if (missing.length > 0) {
    yield* Effect.logError(missing.join("\n"));
    return yield* Effect.fail(
      `declarations: ${String(missing.length)} exported files were not built`,
    );
  }
  return yield* Effect.log(
    `declarations: ${checked
      .map((one) => `${one.name} publishes ${String(one.subpaths)} subpaths`)
      .join(", ")}, each built`,
  );
});

const collisionRule = Effect.gen(function* () {
  const { name, surfaces } = yield* readSurfaces(repositoryRoot, "packages/effect-frame");
  const found = collisions(surfaces, declaredAliases);
  if (found.length > 0) {
    yield* Effect.logError(found.map((one) => formatCollision(name, one)).join("\n"));
    return yield* Effect.fail(
      `declarations: ${String(found.length)} names are exported by more than one subpath`,
    );
  }
  const duplicated = duplicatePaths(surfaces, declaredAliases, declaredSynonyms);
  if (duplicated.length > 0) {
    yield* Effect.logError(
      duplicated.map((paths) => `${name} exports one value as ${paths.join(" and ")}`).join("\n"),
    );
    return yield* Effect.fail(
      `declarations: ${String(duplicated.length)} values are exported by more than one path`,
    );
  }
  return yield* Effect.log(
    `declarations: ${name}'s ${String(surfaces.length)} subpaths export each value name once, and each value by one path`,
  );
});

/** Which files the citation rule reads, and how. */
const kindOf = (file: string): ReadonlyArray<Kind> => {
  if (/^packages\/[^/]+\/src\/.+\.tsx?$/.test(file)) {
    return ["jsdoc"];
  }
  if (/^\.changeset\/[^/]+\.md$/.test(file)) {
    return ["changeset"];
  }
  if (isReferenceDoc(file)) {
    return ["doc"];
  }
  return [];
};

const citationRule = Effect.gen(function* () {
  const { name, surfaces } = yield* readSurfaces(repositoryRoot, "packages/effect-frame");
  const { facts, texts } = yield* readFacts(
    repositoryRoot,
    "packages/effect-frame",
    surfaces.map((surface) => ({ subpath: surface.subpath, module: surface.module })),
  );
  const read = [...texts].flatMap(([file, text]) =>
    kindOf(file).map((kind) => ({ file, text, kind })),
  );
  const dead = read.flatMap(({ file, text, kind }) =>
    deadCitations(kind, text, facts).map((citation) => formatCitation(file, citation)),
  );
  if (dead.length > 0) {
    yield* Effect.logError(dead.join("\n"));
    return yield* Effect.fail(
      `declarations: ${String(dead.length)} citations name nothing ${name} has`,
    );
  }
  return yield* Effect.log(
    `declarations: every Head.member citation in ${String(read.length)} sources, docs and changesets names something ${name} has`,
  );
});

const main = Effect.gen(function* () {
  yield* subpathRule;
  yield* collisionRule;
  yield* citationRule;
  const checked = yield* checkDeclarations(repositoryRoot);
  if (checked.files === 0) {
    return yield* Effect.fail("declarations: no dist/**/*.d.ts found; run the build first");
  }
  if (checked.leaking.length === 0) {
    return yield* Effect.log(
      `declarations: ${String(checked.files)} declaration files leak no type`,
    );
  }
  yield* Effect.logError(
    checked.leaking
      .flatMap((one) => one.leaks.map((leak) => formatLeak(one.file, leak)))
      .join("\n"),
  );
  return yield* Effect.fail(
    `declarations: ${String(checked.leaking.length)} declaration files leak a type`,
  );
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
