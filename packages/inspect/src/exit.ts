/* oxlint-disable effect/noGlobals -- this module is the process boundary: it writes the streams and ends the process. */
/**
 * The process's output streams, and an exit that waits for them.
 *
 * `process.exit` does not wait for queued output, and a `process.stdout`
 * write callback can run before the bytes leave the process. When stdout is
 * a pipe, a large `--json` document was cut at the pipe's buffer (64 KiB or
 * 128 KiB). Each stream here has one queue and one writer fiber that awaits
 * every `Bun.write` in order; `exit` ends the queues, waits for the writers,
 * and only then ends the process.
 */
import type { Cause } from "effect";
import { Effect, Fiber, Queue, Stream } from "effect";

export interface Output {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** End the process with `exitCode` once every write has completed. */
  readonly exit: (exitCode: number) => Effect.Effect<never>;
}

const sink = Effect.fnUntraced(function* (target: typeof Bun.stdout) {
  const queue = yield* Queue.unbounded<string, Cause.Done>();
  const writer = yield* Stream.fromQueue(queue).pipe(
    Stream.runForEach((text) => Effect.promise(() => Bun.write(target, text))),
    Effect.forkDetach,
  );
  return {
    write: (text: string) => {
      Queue.offerUnsafe(queue, text);
    },
    drain: Effect.andThen(Queue.end(queue), Fiber.join(writer)),
  };
});

export const makeOutput: Effect.Effect<Output> = Effect.gen(function* () {
  const out = yield* sink(Bun.stdout);
  const err = yield* sink(Bun.stderr);
  return {
    stdout: out.write,
    stderr: err.write,
    exit: (exitCode) =>
      Effect.andThen(
        Effect.all([out.drain, err.drain], { concurrency: 2 }),
        Effect.sync(() => process.exit(exitCode)),
      ),
  };
});
