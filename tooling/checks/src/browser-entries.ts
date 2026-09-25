/**
 * Every browser entry in the repository: each file a bundler compiles for a
 * page, and each published subpath a page imports. The boundary rule walks
 * the graph of each one.
 *
 * The list is written, not discovered. Adding a browser entry is a boundary
 * decision, and a list that must be edited to add one records it.
 */

/** The repository root, with no trailing slash. */
export const repositoryRoot = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");

export const browserEntries: ReadonlyArray<string> = [
  "apps/blog/src/client.tsx",
  "apps/notes/src/client.tsx",
  "apps/dashboard/src/client.tsx",
  "tooling/dom-bench/src/fixtures/effect-frame.tsx",
  "packages/effect-frame/examples/counter/client.tsx",
  "packages/effect-frame/examples/features/streaming-client.tsx",
  "packages/effect-frame/examples/features/driven-client.tsx",
  "packages/effect-frame/examples/features/inspection.ts",
  "packages/effect-frame/src/actor/client.ts",
  "packages/effect-frame/src/frame.ts",
  "packages/effect-frame/src/view/index.ts",
  "packages/effect-frame/src/router/index.ts",
  "packages/effect-frame/src/inspection/index.ts",
].map((entry) => `${repositoryRoot}/${entry}`);
