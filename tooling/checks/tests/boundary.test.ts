import { Effect } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { checkEntry, formatViolation } from "../src/boundary";
import { browserEntries, repositoryRoot } from "../src/browser-entries";

/**
 * The build rule, proved on both sides: every browser entry in the
 * repository is clean, and a graph that reaches a server module is refused
 * with the chain of files that reached it.
 */

const fixtures = `${repositoryRoot}/tooling/checks/tests/fixtures`;

describe("server/client build rule", () => {
  for (const entry of browserEntries) {
    it.effect(`${entry.replace(repositoryRoot, ".")} reaches no server module`, () =>
      Effect.gen(function* () {
        const violations = yield* checkEntry(entry);
        expect(violations.map((violation) => formatViolation(violation, repositoryRoot))).toEqual(
          [],
        );
      }),
    );
  }

  it.effect("a server module three files deep is refused with its path chain", () =>
    Effect.gen(function* () {
      const violations = yield* checkEntry(`${fixtures}/leaking-entry.ts`);
      expect(violations.map((violation) => violation.reason)).toEqual([
        "a server module (*.server.*)",
      ]);
      expect(violations.map((violation) => formatViolation(violation, fixtures))).toEqual([
        [
          "refused a server module (*.server.*):",
          "  ./leaking-entry.ts",
          "    -> ./middle.ts",
          "      -> ./secret.server.js",
        ].join("\n"),
      ]);
    }),
  );

  it.effect("the full actor entry is refused from a browser entry", () =>
    Effect.gen(function* () {
      const violations = yield* checkEntry(`${fixtures}/full-entry.ts`);
      expect(violations.map((violation) => violation.reason)).toEqual([
        "the full actor entry (use effect-frame/actor/client)",
      ]);
    }),
  );

  it.effect("a browser entry may reach the child view a server view nests", () =>
    Effect.gen(function* () {
      const violations = yield* checkEntry(`${fixtures}/nesting-entry.ts`);
      expect(violations).toEqual([]);
    }),
  );

  it.effect("a clean fixture produces no violation", () =>
    Effect.gen(function* () {
      const violations = yield* checkEntry(`${fixtures}/clean-entry.ts`);
      expect(violations).toEqual([]);
    }),
  );
});
