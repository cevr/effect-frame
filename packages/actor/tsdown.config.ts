import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/**/*.ts"],
  format: "esm",
  dts: {
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
