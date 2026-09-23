/* oxlint-disable effect/noGlobals -- a process-boundary fixture: it floods stdout, then exits. */
/** Write `bytes` to stdout in two calls through `Output`, then exit 3. */
import { Effect } from "effect";
import { makeOutput } from "../../src/exit.js";

const bytes = Number(process.argv[2]);

Effect.runFork(
  Effect.gen(function* () {
    const output = yield* makeOutput;
    output.stdout("x".repeat(bytes / 2));
    output.stdout("y".repeat(bytes / 2));
    return yield* output.exit(3);
  }),
);
