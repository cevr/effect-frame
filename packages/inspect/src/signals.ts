/**
 * Process signals that end a command, and the exit codes they map to.
 * `bin.ts` aborts one AbortController with the signal name as its reason.
 */
import { Effect, Option, Schema } from "effect";

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

const decodeSignal = Schema.decodeUnknownOption(InterruptSignal);

/** The signal an abort carries; a bare abort counts as SIGINT. */
export const signalOf = (abort: AbortSignal): InterruptSignal =>
  Option.getOrElse(decodeSignal(abort.reason), () => "SIGINT");

/** Wait for the abort and return its signal. */
export const untilInterrupted = (abort: AbortSignal): Effect.Effect<InterruptSignal> =>
  Effect.callback<InterruptSignal>((resume) => {
    if (abort.aborted) {
      resume(Effect.succeed(signalOf(abort)));
      return;
    }
    const onAbort = () => resume(Effect.succeed(signalOf(abort)));
    abort.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => abort.removeEventListener("abort", onAbort));
  });
