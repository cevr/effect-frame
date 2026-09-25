import { Effect, Option } from "effect";
import { describe, expect, it } from "effect-bun-test";
import manifest from "../../../package.json" with { type: "json" };
import { pinnedMismatch } from "../src/toolchain";

/**
 * The bundler is part of what the gate proves: a server bundle's contents and
 * the boundary's import graph come from `Bun.build`. So the gate runs on the
 * one Bun that `packageManager` names, and it checks that first
 * (`bun run toolchain`), so a different Bun fails with the cause instead of
 * in a bundle assertion three packages away.
 */
describe("the toolchain", () => {
  it.effect("runs the Bun that package.json pins", () =>
    Effect.sync(() => {
      const mismatch = pinnedMismatch(manifest.packageManager, Bun.version);
      expect(Option.getOrElse(mismatch, () => "")).toBe("");
    }),
  );

  it.effect("names both versions when the running Bun is not the pinned one", () =>
    Effect.sync(() => {
      const mismatch = pinnedMismatch("bun@1.4.2", "1.4.0");
      expect(Option.isSome(mismatch)).toBe(true);
      const message = Option.getOrElse(mismatch, () => "");
      expect(message).toContain("bun@1.4.2");
      expect(message).toContain("1.4.0");
      expect(Option.isNone(pinnedMismatch("bun@1.4.2", "1.4.2"))).toBe(true);
    }),
  );

  it.effect("the gate checks the toolchain before any lane runs", () =>
    Effect.sync(() => {
      expect(manifest.scripts.gate.startsWith("bun run toolchain && ")).toBe(true);
      expect(manifest.scripts.toolchain).toBe("bun run --cwd tooling/checks toolchain");
    }),
  );
});
