import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/**/*.ts", "src/**/*.tsx"],
  format: "esm",
  dts: {
    // The root tsconfig maps @effect-frame/* to sibling sources for the editor.
    // Published types must reach siblings through their built dist instead.
    tsconfig: "tsconfig.build.json",
  },
  clean: true,
  unbundle: true,
  platform: "neutral",
  target: "esnext",
  deps: {
    neverBundle: [/^@effect\//, /^effect/, /^@effect-frame\//, /^@solidjs\//, /^@opentui\//],
  },
});
