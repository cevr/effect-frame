import { Effect, Ref } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { decodeProbe, encodeProbe } from "../src/codec-probe";
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
      // oxlint-disable-next-line effect/noGlobals -- the running Bun is the fact under test.
      const running = Bun.version;
      expect(
        running,
        `package.json pins bun@${pinned}, but this is Bun ${running}; install bun@${pinned}`,
      ).toBe(pinned);
    }),
  );
});

describe("Effect v4 toolchain compatibility", () => {
  it.effect("encodes and decodes a browser-safe schema", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeProbe({ text: "frame" });
      const encoded = yield* encodeProbe(decoded);
      expect(encoded).toEqual({ text: "frame" });
    }),
  );

  it.effect("keeps invalid input in the typed failure channel", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(decodeProbe({ text: "" }));
      expect(failure._tag).toBe("SchemaError");
    }),
  );

  it.effect("waits for a scoped finalizer before returning", () =>
    Effect.gen(function* () {
      const released = yield* Ref.make(false);
      yield* Effect.acquireRelease(Effect.void, () =>
        Effect.yieldNow.pipe(Effect.andThen(Ref.set(released, true))),
      ).pipe(Effect.scoped);
      expect(yield* Ref.get(released)).toBe(true);
    }),
  );
});
