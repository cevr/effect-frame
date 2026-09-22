import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/bin.ts"],
  format: "esm",
  dts: false,
  clean: true,
  unbundle: true,
  // The executable runs on Bun: it uses Bun.serve and Bun.file.
  platform: "node",
  target: "esnext",
  fixedExtension: false,
  deps: {
    neverBundle: [/^effect/, /^bun$/],
  },
});
