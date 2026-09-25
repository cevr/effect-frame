import { Effect, Option } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { deadCitations, otherRepositoriesMarker, type Tree } from "../src/paths";

/**
 * The cited-path rule's reading, over a tree in memory: a backticked
 * repository path must exist, a test name cited after a test file must be
 * one of its titles, and an Open or Superseded row, a file marked as citing
 * other repositories, and a revision-qualified path are left alone. The
 * repository's own docs are checked by `bun run paths`, which the gate runs.
 */

const files = new Map([
  [
    "packages/effect-frame/tests/actor/local.test.ts",
    [
      'describe("a local actor", () => {',
      '  it.effect("applies a message once", () => Effect.void);',
      "  for (const mode of modes) {",
      "    it.effect(`${mode}: resumes from the document`, () => Effect.void);",
      "  }",
      "});",
    ].join("\n"),
  ],
  [
    "packages/effect-frame/tests/actor/suite.ts",
    [
      "export const suite = (name: string) =>",
      "  describe(`Store conformance: ${name}`, () => {",
      '    it.effect("every case passes, the mounted router asks again for nothing", () => Effect.void);',
      "  });",
    ].join("\n"),
  ],
  [
    "packages/effect-frame/tests/actor/store.test.ts",
    ['import { suite } from "./suite.js";', 'suite("memory");'].join("\n"),
  ],
]);

const tree: Tree = {
  exists: (path) =>
    files.has(path) || Array.from(files.keys()).some((file) => file.startsWith(`${path}/`)),
  read: (path) => Option.fromNullishOr(files.get(path)),
};

describe("cited path rule", () => {
  it.effect("refuses a backticked repository path that nothing in the tree has", () =>
    Effect.sync(() => {
      const markdown = [
        "The proof is `packages/effect-frame/tests/actor/local.test.ts:12`.",
        "It moved from `packages/actor/tests/local.test.ts`.",
        "The package is `packages/effect-frame`; `Effect.gen` is not a path.",
        "A glob `packages/*/dist/**/*.d.ts` is not one either.",
      ].join("\n");
      expect(deadCitations(markdown, tree)).toEqual([
        { line: 2, kind: "path", text: "packages/actor/tests/local.test.ts" },
      ]);
    }),
  );

  it.effect("refuses a cited test name the file does not hold, and reads a template title", () =>
    Effect.sync(() => {
      const markdown = [
        "| Claim | Proof | Status |",
        '| One apply | `packages/effect-frame/tests/actor/local.test.ts` — "a local actor > applies a message once", "SSR: resumes from the document", "applies a message twice" | Proven |',
      ].join("\n");
      expect(deadCitations(markdown, tree)).toEqual([
        { line: 2, kind: "test name", text: "applies a message twice" },
      ]);
    }),
  );

  it.effect("reads the titles of a suite the test file imports, and an elided citation", () =>
    Effect.sync(() => {
      const markdown = [
        '| Stores | `packages/effect-frame/tests/actor/store.test.ts` — "Store conformance: memory > every case passes, …", "… : a case that is not there" | Proven |',
      ].join("\n");
      expect(deadCitations(markdown, tree)).toEqual([
        { line: 1, kind: "test name", text: "… : a case that is not there" },
      ]);
    }),
  );

  it.effect("leaves an Open or Superseded row, and a revision-qualified path, alone", () =>
    Effect.sync(() => {
      const markdown = [
        '| Later | `apps/chat/tests/driven.test.tsx` — "a session" | Proven in packages; app row open |',
        '| Before | `packages/actor/tests/remote.test.ts` — "the authorizer" | Superseded by the row below |',
        "The prototype was `93bcf80:packages/view/prototypes/remote-host.ts`.",
      ].join("\n");
      expect(deadCitations(markdown, tree)).toEqual([]);
    }),
  );

  it.effect("leaves a file that cites other repositories alone", () =>
    Effect.sync(() => {
      const markdown = [otherRepositoriesMarker, "Read `packages/signals/src`."].join("\n");
      expect(deadCitations(markdown, tree)).toEqual([]);
    }),
  );
});
