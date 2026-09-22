/* oxlint-disable effect/noGlobals, effect/noAsyncFunction, effect/noConditionalEmptyObjectSpread, effect/noTernary, effect/noNullish, node/no-process-env -- this runner is the process boundary a public executable would own: argv, environment, SIGINT, streams, and exit code. */
/**
 * A process wrapper around the CLI-shaped `run` function. The proof uses it
 * to show a real process disconnect and SIGINT exit code; it is not a bin.
 */
import { Effect } from "effect";
import * as Client from "../../src/client.js";

const interrupt = new AbortController();
process.once("SIGINT", () => interrupt.abort());

const result = await Effect.runPromise(
  Client.run(process.argv.slice(2), {
    ...(process.env[Client.TOKEN_ENV] === undefined
      ? {}
      : { token: process.env[Client.TOKEN_ENV] }),
    interrupt: interrupt.signal,
  }),
);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.exitCode);
