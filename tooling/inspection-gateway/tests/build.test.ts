/* oxlint-disable effect/noAsyncFunction -- this proof awaits Bun.build for the fixture entries. */
/**
 * Item 7 of the scope draft: build separation. The browser bundles are the
 * ones the browser proofs run. The production entry imports no inspection
 * code. The development entry carries the attachment and the shared
 * protocol, and no gateway, reader, Bun, or Node module.
 */
import { describe, expect, it } from "bun:test";
import * as H from "./harness.js";

const has = (inputs: ReadonlyArray<string>, fragment: string): boolean =>
  inputs.some((input) => input.includes(fragment));

describe("inspection build separation", () => {
  it("keeps every inspection module out of the production entry", async () => {
    const production = await H.bundle("main.tsx");
    expect(has(production.inputs, "tests/fixture/app.tsx")).toBe(true);
    for (const module of ["src/attach.ts", "src/protocol.ts", "src/gateway.ts", "src/client.ts"]) {
      expect({ module, bundled: has(production.inputs, `inspection-gateway/${module}`) }).toEqual({
        module,
        bundled: false,
      });
    }
    expect(has(production.inputs, "unstable/rpc/")).toBe(false);
    expect(has(production.inputs, "unstable/socket/")).toBe(false);
    expect(production.text.includes("effect-frame-inspection")).toBe(false);
    expect(production.text.includes("WebSocket")).toBe(false);
  }, 30_000);

  it("keeps the gateway and reader out of the development browser entry", async () => {
    const development = await H.bundle("main.dev.tsx");
    expect(has(development.inputs, "inspection-gateway/src/attach.ts")).toBe(true);
    expect(has(development.inputs, "inspection-gateway/src/protocol.ts")).toBe(true);
    expect(has(development.inputs, "inspection-gateway/src/gateway.ts")).toBe(false);
    expect(has(development.inputs, "inspection-gateway/src/client.ts")).toBe(false);
    expect(development.inputs.filter((input) => /^(bun|node:)/.test(input))).toEqual([]);
    expect(development.text.includes("Bun.serve")).toBe(false);
    expect(/(from\s*|import\(\s*|require\(\s*)["'](node:|bun["'])/.test(development.text)).toBe(
      false,
    );
    expect(development.text.includes("effect-frame-inspection.v")).toBe(true);
  }, 30_000);
});
