// oxlint-disable effect/noGlobals, effect/noNodeBuiltinImport -- the test writes a file to a temporary directory and runs oxlint over it with Bun.spawnSync: it drives the linter as the gate does.
import { Effect } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot } from "../src/browser-entries";

/**
 * The `frame` lint plugin, run by oxlint as the gate runs it, over sources
 * written for each rule. The repository itself is linted by `bun run lint`.
 */

const plugin = join(repositoryRoot, "tooling/checks/src/lint-plugin.ts");
const oxlint = join(repositoryRoot, "node_modules/.bin/oxlint");

/** Lint one source with one `frame` rule on, and return the rule's findings. */
const lint = (rule: string, source: string): ReadonlyArray<string> => {
  const directory = mkdtempSync(join(tmpdir(), "frame-lint-"));
  const config = { jsPlugins: [plugin], rules: { [`frame/${rule}`]: "error" } };
  writeFileSync(join(directory, ".oxlintrc.json"), JSON.stringify(config));
  writeFileSync(join(directory, "sample.ts"), source);
  const run = Bun.spawnSync([oxlint, "-c", ".oxlintrc.json", "--format", "unix", "sample.ts"], {
    cwd: directory,
  });
  return run.stdout
    .toString()
    .split("\n")
    .filter((line) => line.includes(`frame(${rule})`) || line.includes(`frame/${rule}`));
};

describe("frame lint plugin", () => {
  it.effect("refuses a switch statement", () =>
    Effect.sync(() => {
      const found = lint(
        "no-switch",
        "export const f = (n: number): number => {\n  switch (n) {\n    case 1:\n      return 1;\n    default:\n      return 2;\n  }\n};\n",
      );
      expect(found).toHaveLength(1);
      expect(found[0]).toContain("sample.ts:2:");
    }),
  );

  it.effect("refuses a disable directive with no reason, and not one with a reason", () =>
    Effect.sync(() => {
      const found = lint(
        "disable-reason",
        [
          "// oxlint-disable-next-line no-debugger",
          "export const a = 1;",
          "// oxlint-disable-next-line no-debugger -- the probe stops here on purpose",
          "export const b = 2;",
          "// a comment that names oxlint-disable in passing",
          "export const c = 3;",
        ].join("\n"),
      );
      expect(found).toHaveLength(1);
      expect(found[0]).toContain("sample.ts:1:");
    }),
  );

  it.effect("refuses an Effect.fn span not named Area.operation", () =>
    Effect.sync(() => {
      const found = lint(
        "span-name",
        [
          'import { Effect } from "effect";',
          'export const a = Effect.fn("test.draw")(function* () {});',
          'export const b = Effect.fn("runQuery")(function* () {});',
          'export const c = Effect.fn("Notes.renderPage")(function* () {});',
          'export const d = Effect.fn("Actor.durable.process")(function* () {});',
        ].join("\n"),
      );
      expect(found).toHaveLength(2);
      expect(found[0]).toContain("sample.ts:2:");
      expect(found[1]).toContain("sample.ts:3:");
    }),
  );
});
