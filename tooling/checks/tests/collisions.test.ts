import { describe, expect, it } from "effect-bun-test";
import { Effect } from "effect";
import { collisions, declaredAliases, declaredSynonyms, duplicatePaths } from "../src/collisions";

/**
 * The one-name-per-meaning rule's reading. The built package itself is
 * checked by `bun run declarations`.
 */
describe("subpath name collisions", () => {
  it.effect("names a value two subpaths export", () =>
    Effect.sync(() => {
      expect(
        collisions(
          [
            { subpath: "./view", names: ["View", "mount"] },
            { subpath: "./router", names: ["Route", "mount"] },
          ],
          [],
        ),
      ).toEqual([{ name: "mount", subpaths: ["./view", "./router"] }]);
    }),
  );

  it.effect("lets a declared superset re-export its subset, and nothing more", () =>
    Effect.sync(() => {
      const surfaces = [
        { subpath: "./actor", names: ["Source", "ActorHost"] },
        { subpath: "./actor/client", names: ["Source"] },
        { subpath: "./view", names: ["ActorHost"] },
      ];
      expect(collisions(surfaces, declaredAliases)).toEqual([
        { name: "ActorHost", subpaths: ["./actor", "./view"] },
      ]);
    }),
  );

  it.effect("names one value a subpath exports flat and inside a namespace", () =>
    Effect.sync(() => {
      const conflict = () => 3;
      const UrlState = namespace({ make: () => 1, UrlStateConflict: conflict });
      expect(
        duplicatePaths(
          [
            {
              subpath: "./router",
              module: { UrlState, UrlStateConflict: conflict, link: () => 2 },
            },
          ],
          [],
          [],
        ),
      ).toEqual([["./router UrlState.UrlStateConflict", "./router UrlStateConflict"]]);
    }),
  );

  it.effect("names one value two subpaths export under two names", () =>
    Effect.sync(() => {
      const bind = () => 1;
      expect(
        duplicatePaths(
          [
            { subpath: "./view", module: { View: namespace({ bind }) } },
            { subpath: "./view/testing", module: { bindFor: bind } },
          ],
          [],
          [],
        ),
      ).toEqual([["./view View.bind", "./view/testing bindFor"]]);
    }),
  );

  it.effect("lets a declared superset carry its subset's values, and reads no constant", () =>
    Effect.sync(() => {
      const Source = namespace({ select: () => 1 });
      expect(
        duplicatePaths(
          [
            { subpath: "./actor", module: { Source, version: 1, name: "a" } },
            { subpath: "./actor/client", module: { Source, version: 1, other: "a" } },
          ],
          declaredAliases,
          [],
        ),
      ).toEqual([]);
    }),
  );

  it.effect("lets the JSX runtime name its one factory as each name the compiler asks for", () =>
    Effect.sync(() => {
      const jsx = () => 1;
      const module = { jsx, jsxs: jsx, jsxDEV: jsx, Fragment: () => 2 };
      expect(
        duplicatePaths([{ subpath: "./view/jsx-runtime", module }], [], declaredSynonyms),
      ).toEqual([]);
      expect(duplicatePaths([{ subpath: "./view/jsx-runtime", module }], [], [])).toHaveLength(1);
    }),
  );
});

/** An object that reads as an ES module namespace, as `export * as X` builds one. */
const namespace = (members: Readonly<Record<string, () => number>>): object =>
  Object.defineProperty({ ...members }, Symbol.toStringTag, { value: "Module" });
