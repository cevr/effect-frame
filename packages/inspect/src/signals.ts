/**
 * Process signals that end a command, and the exit codes they map to.
 * `bin.ts` turns the process's signals into one `Effect<InterruptSignal>`.
 */
import { Schema } from "effect";

export type ExitCode = 0 | 1 | 2 | 129 | 130 | 143;

export const InterruptSignal = Schema.Literals(["SIGINT", "SIGTERM", "SIGHUP"]);
export type InterruptSignal = Schema.Schema.Type<typeof InterruptSignal>;

const EXIT_CODES = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
} satisfies { readonly [Signal in InterruptSignal]: ExitCode };

/** 128 plus the signal number, as a shell reports it. */
export const exitCodeOf = (signal: InterruptSignal): ExitCode => EXIT_CODES[signal];
