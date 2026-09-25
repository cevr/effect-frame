import { Effect } from "effect";
import { describe, expect, it } from "effect-bun-test";
import manifest from "../../../package.json" with { type: "json" };

/**
 * The bundler is part of what the gate proves: a server bundle's contents and
 * the boundary's import graph come from `Bun.build`. So the gate runs on the
 * one Bun that `packageManager` names, and a different Bun fails here, first,
 * with the cause, instead of in a bundle assertion three packages away.
 */
describe("the toolchain", () => {
  it.effect("runs the Bun that package.json pins", () =>
    Effect.sync(() => {
      const pinned = manifest.packageManager.replace(/^bun@/, "");
      const running = Bun.version;
      expect(
        running,
        `package.json pins bun@${pinned}, but this is Bun ${running}; install bun@${pinned}`,
      ).toBe(pinned);
    }),
  );
});
