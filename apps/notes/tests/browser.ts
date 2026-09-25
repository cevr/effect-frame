/* oxlint-disable effect/noAsyncFunction, effect/noGlobals, effect/noNullish, effect/noNewError, effect/noThrowStatement, effect/noTryCatch, no-await-in-loop -- this harness owns the real browsers for the Notes navigation proof. */
import type { Engine } from "@effect-frame/test-browser";
import { backendOf, requireBrowser } from "@effect-frame/test-browser";

/**
 * The real-browser harness for Notes, modelled on
 * `packages/effect-frame/tests/router/browser/harness.ts`: WebKit on macOS
 * through Bun.WebView, and a system Chrome where one exists, found by
 * `@effect-frame/test-browser`: under CI a missing engine this platform can
 * run fails the file, so CI never passes on proofs it did not run, and
 * elsewhere its proofs skip with one line. The page is the real Notes
 * server, so there is no bundling and no page server here.
 */

export type { Engine } from "@effect-frame/test-browser";

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
 * passes one. A missing engine fails the file under CI (`requireBrowser`),
 * and otherwise skips `suites` with one line that names them.
 */
export const hasNavigation = async (
  engine: Engine,
  origin: string,
  suites: string,
): Promise<boolean> => {
  if (requireBrowser(engine, suites) === undefined) return false;
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
