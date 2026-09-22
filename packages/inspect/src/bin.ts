#!/usr/bin/env bun
/* oxlint-disable effect/noGlobals, node/no-process-env, effect/noNullish -- this file is the process boundary: argv, environment, SIGINT, streams, and the exit code. */
/**
 * The `effect-frame` executable. It only wires the process to `Cli.main`.
 */
import { Effect, Option } from "effect";
import * as Cli from "./cli.js";
import { TOKEN_ENV } from "./reader.js";

const stateHome = Option.getOrElse(
  Option.filter(Option.fromNullishOr(process.env["XDG_STATE_HOME"]), (dir) => dir.length > 0),
  () => `${Option.getOrElse(Option.fromNullishOr(process.env["HOME"]), () => ".")}/.local/state`,
);

const interrupt = new AbortController();
process.once("SIGINT", () => interrupt.abort());

Effect.runFork(
  Cli.main({
    argv: process.argv.slice(2),
    token: Option.filter(Option.fromNullishOr(process.env[TOKEN_ENV]), (token) => token.length > 0),
    defaultStateDir: `${stateHome}/effect-frame/inspect`,
    interrupt: interrupt.signal,
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
  }).pipe(Effect.flatMap((exitCode) => Effect.sync(() => process.exit(exitCode)))),
);
