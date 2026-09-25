// oxlint-disable effect/noGlobals -- process.argv names the message file git wrote and Bun.file reads it: the hook hands the rule that file.
import { Effect, Exit, Option } from "effect";
import { commitTypeRefusal } from "./commit-message.js";

/**
 * The commit message rule as a command. Lefthook's `commit-msg` hook runs
 * it with the path of the message git wrote.
 */

const main = Effect.gen(function* () {
  const file = yield* Effect.fromOption(Option.fromNullishOr(process.argv[2])).pipe(
    Effect.mapError(() => "commit-msg: name the message file"),
  );
  const message = yield* Effect.promise(() => Bun.file(file).text());
  return yield* Option.match(commitTypeRefusal(message), {
    onNone: (): Effect.Effect<void, string> => Effect.void,
    onSome: (refusal) => Effect.fail(`commit-msg: ${refusal}`),
  });
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
