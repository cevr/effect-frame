import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/**/*.ts", "src/**/*.tsx"],
  format: "esm",
  dts: {
    // Published types resolve the package's own subpaths through dist, not
    // the "source" condition the workspace uses in the editor and in tests.
    tsconfig: "tsconfig.build.json",
  },
  clean: true,
  unbundle: true,
  platform: "neutral",
  target: "esnext",
  deps: {
    neverBundle: [/^@effect\//, /^effect/, /^@solidjs\//, /^@opentui\//],
  },
});
