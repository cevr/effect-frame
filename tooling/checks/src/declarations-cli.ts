// oxlint-disable effect/noGlobals -- the command reports through the process exit code, as the gate reads it.
import { Effect, Exit } from "effect";
import { repositoryRoot } from "./browser-entries.js";
import { checkDeclarations, formatLeak } from "./declarations.js";

/**
 * The declaration rule as a command. `bun run gate` runs it after the build,
 * and a leaked `any` or `unknown` in any package's `dist` turns the gate red
 * with the file and line of each one.
 */

const main = Effect.gen(function* () {
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
