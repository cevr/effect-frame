/* oxlint-disable effect/noAsyncFunction, effect/noGlobals, effect/noNullish, effect/noNewError, effect/noNewPromise, effect/noRuntimeTypeof, effect/noTryCatch, effect/noThrowStatement, effect/noNodeBuiltinImport, no-await-in-loop -- this harness owns the real browser, the page server, and bundling for the route slice 5 browser proof. */
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";

/**
 * The real-browser harness for the leave proof. It follows
 * `packages/inspect/tests/harness.ts`: WebKit on macOS through Bun.WebView,
 * and a system Chrome where one exists (on macOS too, so both engines run).
 * An engine that is absent is `undefined`, and its proofs skip.
 */

export type Engine = "webkit" | "chrome";

const chromePath = (): string | undefined => {
  const found = Bun.which("google-chrome") ?? Bun.which("chromium") ?? undefined;
  if (found !== undefined) return found;
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (process.platform === "darwin" && existsSync(mac)) return mac;
  return undefined;
};

export const backendOf = (
  engine: Engine,
): Bun.WebView.ConstructorOptions["backend"] | undefined => {
  if (engine === "webkit") {
    if (process.platform === "darwin") return { type: "webkit", stderr: "ignore" };
    return undefined;
  }
  const path = chromePath();
  if (path === undefined) return undefined;
  return { type: "chrome", url: false, path, stderr: "ignore" };
};

export const hasEngine = (engine: Engine): boolean => backendOf(engine) !== undefined;

/** Bundle a fixture entry in this directory for the browser. */
export const bundle = async (entry = "leave-app.tsx"): Promise<string> => {
  const result = await Bun.build({
    entrypoints: [resolve(import.meta.dir, entry)],
    target: "browser",
    format: "esm",
    minify: false,
    conditions: ["browser", "source"],
  });
  if (!result.success) throw new Error(result.logs.map((log) => log.message).join("\n"));
  const output = result.outputs[0];
  if (output === undefined) throw new Error(`no bundle for ${entry}`);
  return output.text();
};

export interface PageServer<Config> {
  readonly origin: string;
  /** The config the next page load reads. */
  config: Config;
  readonly stop: () => void;
}

/**
 * Serve the bundle at /app.js and the page at every other path. This uses
 * `node:http`, not `Bun.serve`: the router tests share a process with a
 * happy-dom registration, which replaces the global `Response` and `URL`.
 * The page reads `config` as `window[global]` before the bundle runs.
 */
export const serve = async <Config>(
  bundleText: string,
  initial: Config,
  global = "__leaveConfig",
): Promise<PageServer<Config>> => {
  let config: Config = initial;
  const server = createServer((request, response) => {
    if (request.url === "/app.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(bundleText);
      return;
    }
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>leave proof</title><script>window[${JSON.stringify(global)}] = ${JSON.stringify(config)};</script></head><body><main id="root"></main><script type="module" src="/app.js"></script></body></html>`;
    response.writeHead(200, { "content-type": "text/html" });
    response.end(html);
  });
  await new Promise<void>((listening) => {
    server.listen(0, "127.0.0.1", listening);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no page server address");
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    get config() {
      return config;
    },
    set config(next) {
      config = next;
    },
    stop: () => {
      server.closeAllConnections();
      server.close();
    },
  };
};

/** What one engine offers, read from a real page on a loopback origin. */
export interface Capabilities {
  readonly navigation: boolean;
  readonly precommit: boolean;
  readonly agent: string;
}

/** Probe an engine once, so proofs can branch or skip on what it really has. */
export const capabilities = async (engine: Engine): Promise<Capabilities | undefined> => {
  if (!hasEngine(engine)) return undefined;
  const server = await serve("", {});
  const view = await open(engine, `${server.origin}/probe`);
  try {
    return await view.evaluate<Capabilities>(
      `({ navigation: "navigation" in window, precommit: "NavigationPrecommitController" in window, agent: navigator.userAgent })`,
    );
  } finally {
    view.close();
    server.stop();
  }
};

export const open = async (engine: Engine, url: string): Promise<Bun.WebView> => {
  const backend = backendOf(engine);
  if (backend === undefined) throw new Error(`no ${engine} on this host`);
  const view = new Bun.WebView({ backend });
  await view.navigate(url);
  return view;
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

/**
 * Browser-UI Back or Forward: the path a toolbar button takes, without a
 * script call. WebKit's WebView has `back`/`forward`; Chrome takes the
 * DevTools history entry command, which is the same browser-initiated path.
 */
export const uiTraverse = async (view: Bun.WebView, delta: -1 | 1): Promise<void> => {
  const history = await view.cdp<{
    readonly currentIndex: number;
    readonly entries: ReadonlyArray<{ readonly id: number }>;
  }>("Page.getNavigationHistory");
  const entry = history.entries[history.currentIndex + delta];
  if (entry === undefined) throw new Error(`no history entry at ${String(delta)}`);
  await view.cdp("Page.navigateToHistoryEntry", { entryId: entry.id });
};
