import { Effect, Exit, Option } from "effect";
import manifest from "../../../package.json" with { type: "json" };
import { pinnedMismatch } from "./toolchain.js";

/**
 * The toolchain rule as a command. `bun run gate` runs it first, and a Bun
 * other than the pinned one stops the gate here, naming the binary that ran
 * (a dangling symlink shows as the path it resolved to).
 */

const main: Effect.Effect<void, string> = Option.match(
  pinnedMismatch(manifest.packageManager, Bun.version),
  {
    onNone: () => Effect.log(`toolchain: Bun ${Bun.version} at ${process.execPath}`),
    onSome: (message) => Effect.fail(`toolchain: ${message} (ran ${process.execPath})`),
  },
);

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
