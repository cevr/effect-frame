import { Effect } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { leaksIn } from "../src/declarations";

/**
 * The declaration rule's reading: each kind an unresolved emit writes is
 * refused at its line, and the same word in a comment or a string is not.
 * The built declarations themselves are checked by `bun run declarations`,
 * which the gate runs after the build.
 */

describe("published declaration rule", () => {
  it.effect("refuses an `any` type and an unknown requirement across lines, and not a name", () =>
    Effect.sync(() => {
      const source = [
        "/** Works for any source. */",
        "export declare const select: any;",
        'declare const key = "any key";',
        "declare const any: (...policies: ReadonlyArray<Policy>) => Policy;",
        "  any: typeof any;",
        "export { any };",
        "export declare const run: () => Effect.Effect<{",
        "  report: any;",
        "}, unknown, unknown>;",
        "export declare const alone: Effect.Effect<void, never, unknown>;",
        "export declare const split: Effect.Effect<",
        "  (value: A) => B,",
        "  never,",
        "  unknown",
        ">;",
        "export declare const layer: Layer.Layer<Out, never, unknown>;",
        "export declare const fine: Effect.Effect<void, unknown, never>;",
        "export type Pure = Schema.Codec<unknown, unknown>;",
      ].join("\n");
      expect(leaksIn(source)).toEqual([
        { line: 2, kind: "any", text: "export declare const select: any;" },
        {
          line: 7,
          kind: "unknown requirements",
          text: "export declare const run: () => Effect.Effect<{",
        },
        { line: 8, kind: "any", text: "report: any;" },
        {
          line: 10,
          kind: "unknown requirements",
          text: "export declare const alone: Effect.Effect<void, never, unknown>;",
        },
        {
          line: 11,
          kind: "unknown requirements",
          text: "export declare const split: Effect.Effect<",
        },
        {
          line: 16,
          kind: "unknown requirements",
          text: "export declare const layer: Layer.Layer<Out, never, unknown>;",
        },
      ]);
    }),
  );
});
