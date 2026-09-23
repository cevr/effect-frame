#!/usr/bin/env bun
/* oxlint-disable effect/noGlobals, node/no-process-env, effect/noNullish -- this file is the process boundary: argv, environment, signals, streams, and the exit code. */
/**
 * The `effect-frame` executable. It only wires the process to `Cli.main`.
 * SIGINT, SIGTERM, and SIGHUP abort the command with the signal name as the
 * reason; the command cleans up and returns 130, 143, or 129.
 */
import { Effect, Option } from "effect";
import * as Cli from "./cli.js";
import { makeOutput } from "./exit.js";
import { TOKEN_ENV } from "./reader.js";

const interrupt = new AbortController();
const signals: ReadonlyArray<"SIGINT" | "SIGTERM" | "SIGHUP"> = ["SIGINT", "SIGTERM", "SIGHUP"];
for (const signal of signals) {
  process.on(signal, () => interrupt.abort(signal));
}

const env = (name: string) => Option.fromNullishOr(process.env[name]);

Effect.runFork(
  Effect.gen(function* () {
    const output = yield* makeOutput;
    const exitCode = yield* Cli.main({
      argv: process.argv.slice(2),
      token: Option.filter(env(TOKEN_ENV), (token) => token.length > 0),
      home: env("HOME"),
      xdgStateHome: env("XDG_STATE_HOME"),
      pid: process.pid,
      interrupt: interrupt.signal,
      stdout: output.stdout,
      stderr: output.stderr,
    });
    return yield* output.exit(exitCode);
  }),
);
