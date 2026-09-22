/* oxlint-disable effect/noAsyncFunction, effect/noGlobals, effect/noNewPromise, effect/noNodeBuiltinImport, effect/noTryCatch -- this test reads the benchmark sources and drives the loopback page server through fetch. */

import { describe, expect, it } from "bun:test";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { requireServedPageUrl, servePage } from "../src/page.js";

const sourceRoot = resolve(import.meta.dir, "../src");

const readSources = async (): Promise<ReadonlyArray<{ path: string; text: string }>> => {
  const names = await readdir(sourceRoot, { recursive: true });
  const paths = names
    .filter((name) => /\.(ts|tsx)$/.test(name))
    .map((name) => resolve(sourceRoot, name));
  return Promise.all(paths.map(async (path) => ({ path, text: await Bun.file(path).text() })));
};

describe("benchmark page loading", () => {
  it("serves the page from an owned loopback server", async () => {
    const page = servePage("window.__pageTestMarker = 1;");
    try {
      expect(requireServedPageUrl(page.url)).toBe(page.url);
      const response = await fetch(page.url);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(await response.text()).toContain("window.__pageTestMarker = 1;");
    } finally {
      page.stop();
    }
  });

  it("refuses data URL pages", () => {
    expect(() => requireServedPageUrl("data:text/html,<p>row</p>")).toThrow("refusing data: page");
    expect(() => requireServedPageUrl("https://example.com/")).toThrow("refusing https: page");
  });

  it("routes every navigation through the loopback guard and never builds a data URL", async () => {
    const sources = await readSources();
    const navigations = sources.flatMap(({ path, text }) =>
      Array.from(text.matchAll(/\.navigate\(([^)]*\)?)\)/g), (match) => ({
        path,
        argument: match[1],
      })),
    );
    expect(navigations.length).toBeGreaterThan(0);
    for (const navigation of navigations) {
      expect(navigation.argument).toStartWith("requireServedPageUrl(");
    }
    for (const { path, text } of sources) {
      const dataUrl =
        /data:[\w.+-]+\/[\w.+-]+/.test(text) || /encodeURIComponent\(html\)/.test(text);
      expect({ path, dataUrl }).toEqual({ path, dataUrl: false });
    }
  });
});
