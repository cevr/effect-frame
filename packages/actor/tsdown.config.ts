import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/**/*.ts"],
  format: "esm",
  dts: {
    // Published types resolve sibling packages through their built dist, not
    // the "source" condition the workspace uses in the editor and in tests.
    tsconfig: "tsconfig.build.json",
  },
  clean: true,
  unbundle: true,
  platform: "neutral",
  target: "esnext",
  deps: {
    neverBundle: [/^@effect\//, /^effect/],
  },
});
