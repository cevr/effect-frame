import { Effect, Ref } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { decodeProbe, encodeProbe } from "../src/codec-probe";

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
