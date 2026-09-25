// oxlint-disable effect/noGlobals, effect/noNodeBuiltinImport -- the test writes files to a temporary directory and runs oxlint over them with Bun.spawnSync: it drives the linter as the gate does.
import { Effect, Schema } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { repositoryRoot } from "../src/browser-entries";

/**
 * The repository's `.oxlintrc.json`, run over sources placed where an app,
 * an example, a test, or the framework keeps them. Its overrides are matched
 * by path, so each fixture sits at the path it stands for.
 */

const oxlint = join(repositoryRoot, "node_modules/.bin/oxlint");

/** The repository config with its plugins resolved from the repository. */
const config = (): string => {
  const text = readFileSync(join(repositoryRoot, ".oxlintrc.json"), "utf8");
  return text
    .replace(
      '"oxlint-plugin-effect/plugin"',
      JSON.stringify(Bun.resolveSync("oxlint-plugin-effect/plugin", repositoryRoot)),
    )
    .replace(
      '"./tooling/checks/src/lint-plugin.ts"',
      JSON.stringify(join(repositoryRoot, "tooling/checks/src/lint-plugin.ts")),
    );
};

const Report = Schema.fromJsonString(
  Schema.Struct({
    diagnostics: Schema.Array(
      Schema.Struct({ code: Schema.String, filename: Schema.String, help: Schema.String }),
    ),
  }),
);

/** A `no-restricted-imports` finding: the file, and the message the config gives. */
interface Finding {
  readonly filename: string;
  readonly help: string;
}

/** Lint files at their paths under the repository config; return the `no-restricted-imports` findings, by file. */
const restricted = (files: Readonly<Record<string, string>>): ReadonlyArray<Finding> => {
  const directory = mkdtempSync(join(tmpdir(), "frame-config-"));
  writeFileSync(join(directory, ".oxlintrc.json"), config());
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), source);
  }
  const run = Bun.spawnSync(
    [oxlint, "-c", ".oxlintrc.json", "--format", "json", ...Object.keys(files)],
    { cwd: directory },
  );
  return Schema.decodeUnknownSync(Report)(run.stdout.toString())
    .diagnostics.filter((diagnostic) => diagnostic.code === "eslint(no-restricted-imports)")
    .map(({ filename, help }) => ({ filename, help }))
    .toSorted((a, b) => a.filename.localeCompare(b.filename));
};

const holdsRef = 'import { Ref } from "effect";\nexport const make = Ref.make(0);\n';

describe("lint config", () => {
  it.effect("app and example code holds state only in actors", () =>
    Effect.sync(() => {
      const found = restricted({
        "apps/demo/src/state.ts": holdsRef,
        "apps/demo/src/server.ts": holdsRef,
        "apps/demo/src/cells.server.ts":
          'import { SubscriptionRef } from "effect";\nexport const make = SubscriptionRef.make(0);\n',
        "apps/demo/src/flag.ts":
          'import * as MutableRef from "effect/MutableRef";\nexport const flag = MutableRef.make(false);\n',
        "packages/effect-frame/examples/demo/state.ts": holdsRef,
        "apps/demo/tests/state.test.ts": holdsRef,
        "packages/effect-frame/src/state.ts": holdsRef,
      });
      expect(found.map((finding) => finding.filename)).toEqual([
        "apps/demo/src/cells.server.ts",
        "apps/demo/src/flag.ts",
        "apps/demo/src/server.ts",
        "apps/demo/src/state.ts",
        "packages/effect-frame/examples/demo/state.ts",
      ]);
      expect(found.every((finding) => finding.help.includes("Actor.local(Behavior.value"))).toBe(
        true,
      );
    }),
  );

  it.effect("app code still imports a server module only from a server module", () =>
    Effect.sync(() => {
      const found = restricted({
        "apps/demo/src/view.ts": 'export { posts } from "./posts.server";\n',
        "apps/demo/src/posts.server.ts": "export const posts = 1;\n",
        "apps/demo/src/page.server.ts": 'export { posts } from "./posts.server";\n',
      });
      expect(found.map((finding) => finding.filename)).toEqual(["apps/demo/src/view.ts"]);
    }),
  );
});
