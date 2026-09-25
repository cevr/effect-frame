/* oxlint-disable effect/noGlobals, effect/noNullish, effect/noNewError, effect/noThrowStatement, effect/noNodeBuiltinImport -- test tooling at the host edge: it reads PATH, the platform and CI, and fails a test file by throwing. */
import { existsSync } from "node:fs";

/**
 * The one rule for the real-browser proofs, shared by every harness:
 * which browser runs a proof, and what happens when it is missing.
 *
 * - WebKit runs through Bun.WebView on macOS only.
 * - Chrome is a system `google-chrome` or `chromium` on `PATH`, or the
 *   macOS app.
 * - An engine this platform can run but does not have fails the file under
 *   `CI`: CI never passes on proofs it did not run.
 * - Anywhere else a missing engine skips its suites, and says so in one
 *   line that names them.
 */

export type Engine = "webkit" | "chrome";

export type Backend = NonNullable<Bun.WebView.ConstructorOptions["backend"]>;

/** What the rule reads from the host. A test gives its own. */
export interface Host {
  readonly platform: string;
  /** Whether `CI` is set to anything. */
  readonly ci: boolean;
  readonly which: (command: string) => string | undefined;
  readonly exists: (path: string) => boolean;
  readonly warn: (line: string) => void;
}

/** This process's host. */
export const processHost: Host = {
  platform: process.platform,
  ci: (Bun.env["CI"] ?? "") !== "",
  which: (command) => Bun.which(command) ?? undefined,
  exists: existsSync,
  warn: (line) => console.warn(line),
};

const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** The engine's backend on `host`, or `undefined` when it has none. */
export const backendOf = (engine: Engine, host: Host = processHost): Backend | undefined => {
  if (engine === "webkit") {
    if (host.platform === "darwin") return { type: "webkit", stderr: "ignore" };
    return undefined;
  }
  const found = host.which("google-chrome") ?? host.which("chromium");
  if (found !== undefined) return { type: "chrome", url: false, path: found, stderr: "ignore" };
  if (host.platform === "darwin" && host.exists(macChrome)) {
    return { type: "chrome", url: false, path: macChrome, stderr: "ignore" };
  }
  return undefined;
};

/** Whether this platform can run the engine at all: WebKit only on macOS. */
const runsHere = (engine: Engine, host: Host): boolean =>
  engine === "chrome" || host.platform === "darwin";

/**
 * The backend that runs `suites` in `engine`. When the engine is missing,
 * it throws under `CI` if this platform can run it; otherwise it prints one
 * line naming the skipped suites and answers `undefined`, and the caller
 * skips them.
 */
export const requireBrowser = (
  engine: Engine,
  suites: string,
  host: Host = processHost,
): Backend | undefined => {
  const backend = backendOf(engine, host);
  if (backend !== undefined) return backend;
  if (host.ci && runsHere(engine, host)) {
    throw new Error(
      `CI runs every browser proof, but there is no ${engine} on this host for ${suites}: install google-chrome or chromium`,
    );
  }
  if (runsHere(engine, host)) {
    host.warn(`skipped in ${engine} (no ${engine} on PATH): ${suites}`);
  } else {
    host.warn(`skipped in ${engine} (${engine} runs on macOS only): ${suites}`);
  }
  return undefined;
};
