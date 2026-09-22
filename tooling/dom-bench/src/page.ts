/* oxlint-disable effect/noAsyncFunction, effect/noGlobals, effect/noNewError, effect/noNodeBuiltinImport, effect/noNullish, effect/noThrowStatement, effect/noTernary -- this private CLI module owns the Bun bundler and loopback server boundaries for benchmark pages. */

import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { FrameworkName } from "./options.js";

const frameworkEntries = {
  "effect-frame": "./fixtures/effect-frame.tsx",
  solid2: "./fixtures/solid2.ts",
  octane: "./fixtures/octane.ts",
} satisfies Readonly<Record<FrameworkName, string>>;

/** Builds one framework fixture into `outputDirectory/fixture.js`, replacing that directory. */
export const bundleFixture = async (
  framework: FrameworkName,
  outputDirectory: string,
): Promise<string> => {
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  const entrypoint = resolve(import.meta.dir, frameworkEntries[framework]);
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir: outputDirectory,
    target: "browser",
    format: "esm",
    minify: false,
    conditions: framework === "effect-frame" ? ["browser", "source"] : ["browser"],
    naming: "fixture.js",
  });
  if (!result.success) {
    throw new Error(result.logs.map((log) => log.message).join("\n"));
  }
  const output = result.outputs[0];
  if (output === undefined) throw new Error(`no browser bundle produced for ${framework}`);
  return output.text();
};

export interface ServedPage {
  readonly url: string;
  readonly stop: () => void;
}

/**
 * Serves the fixture page from an owned loopback server on an ephemeral port.
 *
 * The page must not be a `data:` URL. Every row has two `<a href="#">` links,
 * and both engines resolve each link against the document URL during style
 * resolution. With the bundle inlined in a `data:` URL that URL is megabytes
 * long, and 20,000 links make the renderer stall for many seconds after a
 * 10,000-row render.
 */
export const servePage = (script: string): ServedPage => {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>effect-frame DOM benchmark</title></head><body><main id="main"></main><script type="module">${script}</script></body></html>`;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname === "/"
        ? new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })
        : new Response("not found", { status: 404 }),
  });
  return { url: `http://127.0.0.1:${server.port}/`, stop: () => void server.stop(true) };
};

/**
 * Returns `url` only when it names an owned loopback HTTP page. Every benchmark
 * navigation goes through this check, so a `data:` page fails before it loads.
 */
export const requireServedPageUrl = (url: string): string => {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
    throw new Error(
      `benchmark pages must be served from http://127.0.0.1; refusing ${parsed.protocol} page`,
    );
  }
  return url;
};
