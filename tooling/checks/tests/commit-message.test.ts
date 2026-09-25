// oxlint-disable effect/noGlobals -- Bun.file reads lefthook.yml and ci.yml: the test checks the files the hook and CI run.
import { Effect, Option } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { commitTypeRefusal } from "../src/commit-message";
import { repositoryRoot } from "../src/browser-entries";

/**
 * The change rules in AGENTS.md "Changes": a commit carries its
 * Conventional Commits type (lefthook's `commit-msg` hook runs the rule),
 * and a pull request that changes the published package carries a
 * changeset (CI runs `changeset status` against main).
 */

const refused = (message: string): boolean => Option.isSome(commitTypeRefusal(message));

describe("commit message rule", () => {
  it.effect("refuses a subject with no Conventional Commits type", () =>
    Effect.sync(() => {
      expect(refused("wip")).toBe(true);
      expect(refused("Feat: capitalised type")).toBe(true);
      expect(refused("feat:no space")).toBe(true);
      expect(refused("feature(view): not a type")).toBe(true);
      expect(refused("feat(view): ")).toBe(true);
      expect(refused("")).toBe(true);
      expect(Option.getOrElse(commitTypeRefusal("wip"), () => "")).toContain('"wip"');
    }),
  );

  it.effect("admits a typed subject, a breaking one, and git's own subjects", () =>
    Effect.sync(() => {
      expect(refused("feat(view): View.show")).toBe(false);
      expect(refused("fix!: drop the old form")).toBe(false);
      expect(refused("refactor(router)!: one receipt")).toBe(false);
      expect(refused("# Please enter the commit message\n\ndocs: a line\n\nbody")).toBe(false);
      expect(refused("Merge branch 'main' into arch-pass2")).toBe(false);
      expect(refused('Revert "feat: a thing"')).toBe(false);
      expect(refused("fixup! feat(view): View.show")).toBe(false);
    }),
  );

  it.effect("the hook and CI run the change rules", () =>
    Effect.gen(function* () {
      const hooks = yield* Effect.promise(() => Bun.file(`${repositoryRoot}/lefthook.yml`).text());
      const ci = yield* Effect.promise(() =>
        Bun.file(`${repositoryRoot}/.github/workflows/ci.yml`).text(),
      );
      expect(hooks).toContain("commit-msg:");
      expect(hooks).toContain("bun tooling/checks/src/commit-message-cli.ts {1}");
      expect(ci).toContain("fetch-depth: 0");
      expect(ci).toContain("changeset status --since=origin/main");
    }),
  );
});
