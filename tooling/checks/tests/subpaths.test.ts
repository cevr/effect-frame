import { Effect } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { consumerModule, decodeSubpaths, missingFiles } from "../src/subpaths";

/**
 * The exports-map rule's reading: each published subpath names a `types`
 * and a `default` file that the build must have written, and the consumer
 * project imports every subpath, so an unresolvable one fails `tsc`. The
 * built package itself is checked by `bun run declarations`.
 */

/** A manifest as the file on disk holds it. */
const manifest = `{
  "name": "effect-frame",
  "exports": {
    "./actor": {
      "source": "./src/actor/index.ts",
      "types": "./dist/actor/index.d.ts",
      "default": "./dist/actor/index.js"
    },
    "./view/jsx-runtime": {
      "source": "./src/view/jsx-runtime.ts",
      "types": "./dist/view/jsx-runtime.d.ts",
      "default": "./dist/view/jsx-runtime.js"
    }
  }
}`;

describe("published subpath rule", () => {
  it.effect("reads each subpath with its declaration and its module", () =>
    Effect.gen(function* () {
      const subpaths = yield* decodeSubpaths(manifest);
      expect(subpaths).toEqual({
        name: "effect-frame",
        subpaths: [
          {
            key: "./actor",
            types: "./dist/actor/index.d.ts",
            default: "./dist/actor/index.js",
          },
          {
            key: "./view/jsx-runtime",
            types: "./dist/view/jsx-runtime.d.ts",
            default: "./dist/view/jsx-runtime.js",
          },
        ],
      });
    }),
  );

  it.effect("names each file the exports map promises and the build did not write", () =>
    Effect.gen(function* () {
      const { subpaths } = yield* decodeSubpaths(manifest);
      const written = new Set(["./dist/actor/index.d.ts", "./dist/view/jsx-runtime.js"]);
      expect(missingFiles(subpaths, (file) => written.has(file))).toEqual([
        { key: "./actor", field: "default", file: "./dist/actor/index.js" },
        { key: "./view/jsx-runtime", field: "types", file: "./dist/view/jsx-runtime.d.ts" },
      ]);
    }),
  );

  it.effect("writes a consumer module that imports every subpath by its public name", () =>
    Effect.gen(function* () {
      const { name, subpaths } = yield* decodeSubpaths(manifest);
      expect(consumerModule(name, subpaths)).toContain(
        [
          'export * as S0 from "effect-frame/actor";',
          'export * as S1 from "effect-frame/view/jsx-runtime";',
        ].join("\n"),
      );
    }),
  );

  it.effect("refuses an exports entry with no types or default file", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        decodeSubpaths(
          '{ "name": "effect-frame", "exports": { "./actor": "./src/actor/index.ts" } }',
        ),
      );
      expect(failure._tag).toBe("SchemaError");
    }),
  );
});
