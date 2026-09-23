/* oxlint-disable effect/noAsyncFunction, effect/noGlobals, effect/noNullish, effect/noNewError, effect/noThrowStatement, effect/noTryCatch, effect/noNodeBuiltinImport, no-await-in-loop -- this harness owns the real browsers for the Notes navigation proof. */
import { existsSync } from "node:fs";

/**
 * The real-browser harness for Notes, modelled on
 * `packages/effect-frame/tests/router/browser/harness.ts`: WebKit on macOS
 * through Bun.WebView, and a system Chrome where one exists. An engine that
 * is absent is `undefined`, and its proofs skip, except Chrome under CI:
 * there a missing Chrome fails the file, so CI never passes on proofs it
 * did not run. The page is the real Notes
 * server, so there is no bundling and no page server here.
 */

export type Engine = "webkit" | "chrome";

const chromePath = (): string | undefined => {
  const found = Bun.which("google-chrome") ?? Bun.which("chromium") ?? undefined;
  if (found !== undefined) return found;
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (process.platform === "darwin" && existsSync(mac)) return mac;
  return undefined;
};

const backendOf = (engine: Engine): Bun.WebView.ConstructorOptions["backend"] | undefined => {
  if (engine === "webkit") {
    if (process.platform === "darwin") return { type: "webkit", stderr: "ignore" };
    return undefined;
  }
  const path = chromePath();
  if (path === undefined) return undefined;
  return { type: "chrome", url: false, path, stderr: "ignore" };
};

export const open = async (engine: Engine, url: string): Promise<Bun.WebView> => {
  const backend = backendOf(engine);
  if (backend === undefined) throw new Error(`no ${engine} on this host`);
  const view = new Bun.WebView({ backend, width: 800, height: 600 });
  await view.navigate(url);
  return view;
};

/**
 * Whether this engine exists here and has the Navigation API, read from a
 * real page. The Notes client needs a live origin for it, so the caller
 * passes one.
 */
export const hasNavigation = async (engine: Engine, origin: string): Promise<boolean> => {
  const found = await probeNavigation(engine, origin);
  if (!found && engine === "chrome" && (Bun.env["CI"] ?? "") !== "") {
    throw new Error(
      "CI needs Chrome with the Navigation API for the Notes navigation proofs: install google-chrome or chromium",
    );
  }
  return found;
};

const probeNavigation = async (engine: Engine, origin: string): Promise<boolean> => {
  if (backendOf(engine) === undefined) return false;
  const view = await open(engine, `${origin}/scratch`);
  try {
    return await view.evaluate<boolean>(`"navigation" in window`);
  } finally {
    view.close();
  }
};

/** Poll a page expression until it is truthy. */
export const waitFor = async (
  view: Bun.WebView,
  expression: string,
  label: string,
  timeoutMillis = 5_000,
): Promise<void> => {
  const until = performance.now() + timeoutMillis;
  while (performance.now() < until) {
    if (await view.evaluate<boolean>(`Boolean(${expression})`)) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${label}: ${expression}`);
};
