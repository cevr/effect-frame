import { describe, expect, it } from "effect-bun-test";
import { Effect } from "effect";
import { collisions, declaredAliases } from "../src/collisions";

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
});
