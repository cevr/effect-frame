import { describe, expect, it } from "bun:test";
import type { Host } from "../src/index.js";
import { requireBrowser } from "../src/index.js";

/** A host with the given platform, CI flag and Chrome, that records its warnings. */
const hostOf = (options: { platform: string; ci: boolean; chrome: boolean }) => {
  const warnings: Array<string> = [];
  const paths = new Map<string, string>();
  if (options.chrome) paths.set("chromium", "/usr/bin/chromium");
  const host: Host = {
    platform: options.platform,
    ci: options.ci,
    which: (command) => paths.get(command),
    exists: () => false,
    warn: (line) => warnings.push(line),
  };
  return { host, warnings };
};

describe("requireBrowser: a proof that does not run says so", () => {
  it("answers the Chrome backend where Chrome is on PATH, and warns nothing", () => {
    const { host, warnings } = hostOf({ platform: "linux", ci: true, chrome: true });
    expect(requireBrowser("chrome", "the proofs", host)).toEqual({
      type: "chrome",
      url: false,
      path: "/usr/bin/chromium",
      stderr: "ignore",
    });
    expect(warnings).toEqual([]);
  });

  it("fails the file under CI when Chrome is missing", () => {
    const { host } = hostOf({ platform: "linux", ci: true, chrome: false });
    expect(() => requireBrowser("chrome", "streamed documents", host)).toThrow(
      "no chrome on this host for streamed documents",
    );
  });

  it("skips locally with one line naming the suites", () => {
    const { host, warnings } = hostOf({ platform: "linux", ci: false, chrome: false });
    expect(requireBrowser("chrome", "streamed documents", host)).toBeUndefined();
    expect(warnings).toEqual(["skipped in chrome (no chrome on PATH): streamed documents"]);
  });

  it("skips WebKit off macOS, under CI too, and says why", () => {
    const { host, warnings } = hostOf({ platform: "linux", ci: true, chrome: true });
    expect(requireBrowser("webkit", "leave checks", host)).toBeUndefined();
    expect(warnings).toEqual(["skipped in webkit (webkit runs on macOS only): leave checks"]);
  });

  it("answers WebKit on macOS", () => {
    const { host } = hostOf({ platform: "darwin", ci: true, chrome: false });
    expect(requireBrowser("webkit", "leave checks", host)).toEqual({
      type: "webkit",
      stderr: "ignore",
    });
  });
});
