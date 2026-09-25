import { Effect } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { accidentalMajors, firstMajor, type Workspace } from "../src/changesets";

/**
 * The release rule: no package goes to 1.0 by accident. A hand-written
 * changeset never sees the CLI's first-major warning, so the gate refuses a
 * `major` bump of a package below 1.0, and a published package at 1.0 or
 * above (the Version PR, where the changesets are already consumed), until
 * `firstMajor` is flipped. The repository's own changesets are checked by
 * `bun run docs`.
 */

const workspace: ReadonlyArray<Workspace> = [
  { name: "effect-frame", version: "0.27.0", published: true },
  { name: "@effect-frame/inspect", version: "0.0.0", published: false },
];

const changeset = (bumps: ReadonlyArray<string>): string =>
  ["---", ...bumps, "---", "", "A change."].join("\n");

describe("changeset rule", () => {
  it.effect("refuses a major bump of a package below 1.0, at its line", () =>
    Effect.sync(() => {
      const found = accidentalMajors(
        false,
        workspace,
        new Map([
          ["major.md", changeset(['"effect-frame": major'])],
          ["private.md", changeset(["'@effect-frame/inspect': major", '"effect-frame": patch'])],
          ["minor.md", changeset(['"effect-frame": minor'])],
        ]),
      );
      expect(found).toEqual([
        '.changeset/major.md:2: "effect-frame": major takes effect-frame from 0.27.0 to 1.0.0; bump minor, or set firstMajor in tooling/checks/src/changesets.ts',
        '.changeset/private.md:2: "@effect-frame/inspect": major takes @effect-frame/inspect from 0.0.0 to 1.0.0; bump minor, or set firstMajor in tooling/checks/src/changesets.ts',
      ]);
    }),
  );

  it.effect("refuses a published package at 1.0 or above, and not a private one", () =>
    Effect.sync(() => {
      const found = accidentalMajors(
        false,
        [
          { name: "effect-frame", version: "1.0.0", published: true },
          { name: "@effect-frame/inspect", version: "2.1.0", published: false },
        ],
        new Map(),
      );
      expect(found).toEqual([
        "effect-frame is 1.0.0: its first major release is a decision; set firstMajor in tooling/checks/src/changesets.ts",
      ]);
    }),
  );

  it.effect("allows both once firstMajor is set, and the repository has not set it", () =>
    Effect.sync(() => {
      const found = accidentalMajors(
        true,
        [{ name: "effect-frame", version: "1.0.0", published: true }],
        new Map([["major.md", changeset(['"effect-frame": major'])]]),
      );
      expect(found).toEqual([]);
      expect(firstMajor).toBe(false);
    }),
  );
});
