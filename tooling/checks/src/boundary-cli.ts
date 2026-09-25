import { Effect, Exit } from "effect";
import { checkEntry, formatViolation } from "./boundary.js";
import { browserEntries, repositoryRoot } from "./browser-entries.js";

/**
 * The build rule as a command. `bun run gate` runs it after the build, and a
 * server import reachable from any browser entry turns the gate red with the
 * chain of files that reached it.
 */

const main = Effect.gen(function* () {
  const checked = yield* Effect.forEach(
    browserEntries,
    (entry) => Effect.map(checkEntry(entry), (violations) => ({ entry, violations })),
    { concurrency: 4 },
  );
  const failed = checked.filter((one) => one.violations.length > 0);
  if (failed.length === 0) {
    return yield* Effect.log(
      `boundary: ${String(browserEntries.length)} browser entries are clean`,
    );
  }
  yield* Effect.forEach(failed, (one) =>
    Effect.logError(
      [
        `boundary: ${one.entry.replace(repositoryRoot, ".")}`,
        ...one.violations.map((violation) => formatViolation(violation, repositoryRoot)),
      ].join("\n"),
    ),
  );
  return yield* Effect.fail(`boundary: ${String(failed.length)} browser entries reach server code`);
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
