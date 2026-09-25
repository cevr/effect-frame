import { Option } from "effect";

/**
 * A commit carries its Conventional Commits type, with `!` for a breaking
 * change (AGENTS.md "Changes"). The changelog and the release notes read
 * the history by type, so a subject such as "wip" is a change no reader can
 * place. Lefthook's `commit-msg` hook runs the rule on the message git
 * wrote, so it refuses before the commit exists.
 *
 * The subject is the first line that is not a comment. Git's own subjects
 * (a merge, a revert, a `fixup!`, `squash!` or `amend!`) pass as written.
 */

/** The types the history uses. */
export const commitTypes: ReadonlyArray<string> = [
  "feat",
  "fix",
  "docs",
  "refactor",
  "test",
  "chore",
  "perf",
  "build",
  "ci",
  "style",
  "revert",
];

const typed = new RegExp(`^(?:${commitTypes.join("|")})(?:\\([^()\\s]+\\))?!?: \\S`);
const gitSubject = /^(?:Merge |Revert "|fixup! |squash! |amend! )/;

/** Why a commit message is refused, if it is. */
export const commitTypeRefusal = (message: string): Option.Option<string> => {
  const subject = Option.getOrElse(
    Option.fromNullishOr(
      message
        .split("\n")
        .map((line) => line.trimEnd())
        .find((line) => line.length > 0 && !line.startsWith("#")),
    ),
    () => "",
  );
  return Option.liftPredicate(
    `commit subject "${subject}" has no Conventional Commits type: write <type>(<scope>)?!?: <subject>, with a type of ${commitTypes.join(", ")}`,
    () => !typed.test(subject) && !gitSubject.test(subject),
  );
};
