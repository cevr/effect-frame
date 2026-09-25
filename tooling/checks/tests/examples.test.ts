import { Effect } from "effect";
import { describe, expect, it } from "effect-bun-test";
import {
  exampleDrift,
  isReferenceDoc,
  jsdocDrift,
  jsdocPaths,
  regionsOf,
  resolveFrom,
  synced,
  syncedJsdoc,
} from "../src/examples";

/**
 * The examples rule: a ts or tsx block in a reference doc is a region of a
 * file the gate compiles and tests. A block names its region in the comment
 * above it, `<!-- example: path#region -->`, and must be that region's text.
 * `bun run docs` checks the repository's own docs.
 */

const source = [
  "import { Effect } from 'effect';",
  "",
  "// #region greet",
  "export const greet = (name: string) =>",
  "  Effect.succeed(`hello ${name}`);",
  "// #endregion greet",
  "",
  "export const other = 1;",
].join("\n");

const doc = (body: ReadonlyArray<string>) =>
  [
    "# Greeting",
    "",
    "<!-- example: examples/greet.ts#greet -->",
    "",
    "```ts",
    ...body,
    "```",
    "",
  ].join("\n");

const files = new Map([["examples/greet.ts", source]]);

describe("examples rule", () => {
  it.effect("reads each region of a source file, without the marker lines", () =>
    Effect.sync(() => {
      expect(regionsOf(source)).toEqual(
        new Map([
          ["greet", "export const greet = (name: string) =>\n  Effect.succeed(`hello ${name}`);"],
        ]),
      );
    }),
  );

  it.effect("drops the markers of a region nested inside another, and dedents", () =>
    Effect.sync(() => {
      const nested = [
        "  // #region outer",
        "  const a = 1;",
        "  // #region inner",
        "  const b = 2;",
        "  // #endregion inner",
        "  // #endregion outer",
      ].join("\n");
      expect(regionsOf(nested)).toEqual(
        new Map([
          ["outer", "const a = 1;\nconst b = 2;"],
          ["inner", "const b = 2;"],
        ]),
      );
    }),
  );

  it.effect("accepts a block that is its region's text", () =>
    Effect.sync(() => {
      const text = doc([
        "export const greet = (name: string) =>",
        "  Effect.succeed(`hello ${name}`);",
      ]);
      expect(exampleDrift("README.md", text, files)).toEqual([]);
    }),
  );

  it.effect("refuses a block that drifted from its region", () =>
    Effect.sync(() => {
      const text = doc(["export const greet = (who: string) => who;"]);
      expect(exampleDrift("README.md", text, files)).toEqual([
        { file: "README.md", line: 5, reason: "differs from examples/greet.ts#greet" },
      ]);
    }),
  );

  it.effect("refuses a block that names a region no file has", () =>
    Effect.sync(() => {
      const text = doc(["x"]).replace("#greet", "#missing");
      expect(exampleDrift("README.md", text, files)).toEqual([
        {
          file: "README.md",
          line: 5,
          reason: "names examples/greet.ts#missing, which does not exist",
        },
      ]);
    }),
  );

  it.effect("refuses a ts or tsx block with no example marker", () =>
    Effect.sync(() => {
      const text = [
        "# Loose",
        "",
        "```tsx",
        "const a = <p />;",
        "```",
        "",
        "```sh",
        "bun run gate",
        "```",
      ].join("\n");
      expect(exampleDrift("README.md", text, files)).toEqual([
        { file: "README.md", line: 3, reason: "a ts or tsx block names no example region" },
      ]);
    }),
  );

  it.effect("writes each marked block from its region", () =>
    Effect.sync(() => {
      const text = doc(["export const greet = (who: string) => who;"]);
      expect(synced(text, files)).toBe(
        doc(["export const greet = (name: string) =>", "  Effect.succeed(`hello ${name}`);"]),
      );
    }),
  );

  it.effect("reads the reference docs, and not the decision records", () =>
    Effect.sync(() => {
      const read = [
        "README.md",
        "AGENTS.md",
        "CONTEXT.md",
        "packages/effect-frame/README.md",
        "apps/notes/README.md",
        ".claude/skills/architecture-loop/SKILL.md",
        "docs/design/streaming.md",
        "plans/pass1/docs.md",
        ".changeset/one-path-per-value.md",
      ].filter(isReferenceDoc);
      expect(read).toEqual([
        "README.md",
        "AGENTS.md",
        "CONTEXT.md",
        "packages/effect-frame/README.md",
        "apps/notes/README.md",
        ".claude/skills/architecture-loop/SKILL.md",
      ]);
    }),
  );

  it.effect("resolves a marker's path from the doc that names it", () =>
    Effect.sync(() => {
      expect(resolveFrom("packages/effect-frame/README.md", "examples/counter/routes.tsx")).toBe(
        "packages/effect-frame/examples/counter/routes.tsx",
      );
      expect(resolveFrom("packages/inspect/README.md", "../effect-frame/examples/a.ts")).toBe(
        "packages/effect-frame/examples/a.ts",
      );
      expect(resolveFrom("README.md", "packages/a.ts")).toBe("packages/a.ts");
    }),
  );

  const jsdocFiles = new Map([["../examples/greet.ts", source]]);

  const module = (body: ReadonlyArray<string>) =>
    [
      "/**",
      " * Greets a name.",
      " *",
      " * @example ../examples/greet.ts#greet",
      " * ```ts",
      ...body,
      " * ```",
      " */",
      "export const greet = 1;",
      "",
      "  /**",
      "   * An untagged block is prose: the citation rule reads it.",
      "   *",
      "   * ```ts",
      "   * greet(1)",
      "   * ```",
      "   */",
    ].join("\n");

  it.effect("holds an @example block in JSDoc to its region", () =>
    Effect.sync(() => {
      const exact = module([
        " * export const greet = (name: string) =>",
        " *   Effect.succeed(`hello ${name}`);",
      ]);
      expect(jsdocDrift("src/greet.ts", exact, jsdocFiles)).toEqual([]);
      expect(jsdocPaths(exact)).toEqual(["../examples/greet.ts"]);
      const drifted = module([" * export const greet = (name: string) => name;"]);
      expect(jsdocDrift("src/greet.ts", drifted, jsdocFiles)).toEqual([
        { file: "src/greet.ts", line: 5, reason: "differs from ../examples/greet.ts#greet" },
      ]);
    }),
  );

  it.effect("refuses an @example block that names no region", () =>
    Effect.sync(() => {
      const bare = ["/**", " * @example", " * ```ts", " * greet(1)", " * ```", " */"].join("\n");
      expect(jsdocDrift("src/greet.ts", bare, jsdocFiles)).toEqual([
        { file: "src/greet.ts", line: 3, reason: "an @example block names no example region" },
      ]);
    }),
  );

  it.effect("writes an @example block from its region, with the JSDoc prefix", () =>
    Effect.sync(() => {
      const exact = module([
        " * export const greet = (name: string) =>",
        " *   Effect.succeed(`hello ${name}`);",
      ]);
      expect(syncedJsdoc(module([" * stale"]), jsdocFiles)).toBe(exact);
    }),
  );
});
