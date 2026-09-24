import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/**/*.ts", "src/**/*.tsx"],
  format: "esm",
  dts: {
    // Emitted from source, so the package's own subpath imports resolve
    // while `dist` is cleaned: see tsconfig.build.json.
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
