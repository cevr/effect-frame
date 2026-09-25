#!/usr/bin/env bun
/* oxlint-disable effect/noGlobals, node/no-process-env -- this file is the process boundary: argv, environment, signals, streams, and the exit code. */
/**
 * The `effect-frame` executable. It only wires the process to `Cli.main`.
 * SIGINT, SIGTERM, and SIGHUP complete the command's interrupt with the
 * signal's name; the command cleans up and returns 130, 143, or 129.
 */
import { Deferred, Effect, Exit, Fiber, Option } from "effect";
import * as Cli from "./cli.js";
import { makeOutput } from "./exit.js";
import { TOKEN_ENV } from "./reader.js";
import type { InterruptSignal } from "./signals.js";

const signals: ReadonlyArray<InterruptSignal> = ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * The first of the signals to arrive. Its listeners go when it completes or
 * is interrupted: the release below runs on both, where an `Effect.callback`
 * cleanup runs only on interrupt. A second signal during cleanup then gets
 * the process's default handling.
 */
const firstSignal = Effect.gen(function* () {
  const arrived = yield* Deferred.make<InterruptSignal>();
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      signals.map((signal) => {
        const listener = () => void Deferred.doneUnsafe(arrived, Exit.succeed(signal));
        process.on(signal, listener);
        return { signal, listener };
      }),
    ),
    (listeners) =>
      Effect.sync(() => {
        for (const { signal, listener } of listeners) process.off(signal, listener);
      }),
  );
  return yield* Deferred.await(arrived);
}).pipe(Effect.scoped);

const env = (name: string) => Option.fromNullishOr(process.env[name]);

Effect.runFork(
  Effect.gen(function* () {
    // Listen from the start, so a signal before the command waits is not lost.
    const listening = yield* Effect.forkChild(firstSignal);
    const output = yield* makeOutput;
    const exitCode = yield* Cli.main({
      argv: process.argv.slice(2),
      token: Option.filter(env(TOKEN_ENV), (token) => token.length > 0),
      home: env("HOME"),
      xdgStateHome: env("XDG_STATE_HOME"),
      pid: process.pid,
      interrupt: Fiber.join(listening),
      stdout: output.stdout,
      stderr: output.stderr,
    });
    return yield* output.exit(exitCode);
  }),
);
