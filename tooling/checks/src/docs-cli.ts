// oxlint-disable effect/noGlobals -- Bun.file reads the docs: the rule checks the text a reader opens.
import { Effect, Exit } from "effect";
import { repositoryRoot } from "./browser-entries.js";
import { formatRepeat, repeatedTerms } from "./glossary.js";

/**
 * The docs rules as a command. `bun run gate` runs it: `CONTEXT.md`
 * defines each term once (`glossary.ts`).
 */

const glossaryFile = "CONTEXT.md";

const glossaryRule = Effect.gen(function* () {
  const text = yield* Effect.promise(() => Bun.file(`${repositoryRoot}/${glossaryFile}`).text());
  const repeats = repeatedTerms(text).map((repeat) => formatRepeat(glossaryFile, repeat));
  if (repeats.length === 0) {
    return yield* Effect.log(`docs: ${glossaryFile} defines each term once`);
  }
  yield* Effect.logError(repeats.join("\n"));
  return yield* Effect.fail(`docs: ${String(repeats.length)} glossary terms are defined twice`);
});

const main = glossaryRule;

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
