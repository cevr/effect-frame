/* oxlint-disable effect/noNullish -- the invariant fixture deliberately carries the no-selection null value. */

import { describe, expect, it } from "bun:test";
import { assertInvariant } from "../src/common.js";

describe("benchmark final invariant", () => {
  it("turns a false final DOM invariant into a cell failure", () => {
    expect(() =>
      assertInvariant("create-1k", {
        ok: false,
        rows: 999,
        selected: null,
        reason: "row count 999 != 1000",
      }),
    ).toThrow("create-1k: final benchmark invariant failed: row count 999 != 1000");
  });
});
