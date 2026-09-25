/* oxlint-disable effect/noAsyncFunction, effect/noGlobals, effect/noNewError, effect/noNullish, effect/noThrowStatement, effect/noTernary, effect/noNodeBuiltinImport, no-await-in-loop -- this harness owns the real browser, the page server, and bundling for the transport proof. */
import type { Engine } from "@effect-frame/test-browser";
import { backendOf, requireBrowser } from "@effect-frame/test-browser";
import { Effect, Exit, Scope } from "effect";
import { resolve } from "node:path";
import * as Gateway from "../src/gateway.js";
import * as Client from "../src/reader.js";
import type { FixtureConfig } from "./fixture/app.js";

export const fixtureDir = resolve(import.meta.dir, "fixture");

export interface Bundle {
  readonly text: string;
  readonly inputs: ReadonlyArray<string>;
}

/** Bundle one fixture entry for the browser, as the proof's app build. */
export const bundle = async (entry: "main.tsx" | "main.dev.tsx"): Promise<Bundle> => {
  const result = await Bun.build({
    entrypoints: [resolve(fixtureDir, entry)],
    target: "browser",
    format: "esm",
    minify: false,
    conditions: ["browser", "source"],
    metafile: true,
  });
  if (!result.success) throw new Error(result.logs.map((log) => log.message).join("\n"));
  const output = result.outputs[0];
  if (output === undefined) throw new Error(`no bundle for ${entry}`);
  // Metafile inputs are relative to the working directory; make them absolute.
  const inputs = Object.keys(result.metafile?.inputs ?? {}).map((input) => resolve(input));
  return { text: await output.text(), inputs };
};

/**
 * Counts WebSocket constructions before the application script runs. While
 * `holding`, an inbound frame reaches the page and is counted in `held` but
 * never reaches the application, so a request stays pending at an idle root.
 */
const socketProbe = `<script>
window.__sockets = { created: 0, all: [], holding: false, held: 0 };
const NativeWebSocket = window.WebSocket;
window.WebSocket = class extends NativeWebSocket {
  constructor(...args) {
    super(...args);
    window.__sockets.created += 1;
    window.__sockets.all.push(this);
  }
  addEventListener(type, listener, options) {
    if (type !== "message") return super.addEventListener(type, listener, options);
    return super.addEventListener(type, (event) => {
      if (window.__sockets.holding) window.__sockets.held += 1;
      else listener.call(this, event);
    }, options);
  }
};
window.__openSockets = () => window.__sockets.all.filter((socket) => socket.readyState === 1).length;
</script>`;

export interface PageServer {
  readonly origin: string;
  readonly url: (path: string, config: FixtureConfig) => string;
  readonly stop: () => void;
}

/** Serve the bundle with page config injected per request. */
export const servePage = (bundleText: string): PageServer => {
  const configs = new Map<string, FixtureConfig>();
  let sequence = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/app.js") {
        return new Response(bundleText, { headers: { "content-type": "text/javascript" } });
      }
      const config = configs.get(url.searchParams.get("config") ?? "") ?? { name: "unconfigured" };
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>inspection proof</title>${socketProbe}<script>window.__fixtureConfig = ${JSON.stringify(config)};</script></head><body><main id="root"></main><script type="module" src="/app.js"></script></body></html>`;
      return new Response(html, { headers: { "content-type": "text/html" } });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  return {
    origin,
    url: (path, config) => {
      sequence += 1;
      const key = String(sequence);
      configs.set(key, config);
      return `${origin}${path}?config=${key}`;
    },
    stop: () => server.stop(true),
  };
};

/**
 * The browser the proofs drive: WebKit on macOS, where Bun.WebView ships
 * it, or a system Chrome elsewhere.
 */
const engine: Engine = process.platform === "darwin" ? "webkit" : "chrome";

/**
 * Whether this host runs the real-browser proofs named by `suites`. Under
 * CI a missing browser fails the file; elsewhere one line names the skip.
 */
export const hasBrowser = (suites: string): boolean => requireBrowser(engine, suites) !== undefined;

export const openView = async (url: string): Promise<Bun.WebView> => {
  const backend = backendOf(engine);
  if (backend === undefined) throw new Error("no browser backend on this host");
  const view = new Bun.WebView({ backend });
  await view.navigate(url);
  return view;
};

export const evaluate = <A>(view: Bun.WebView, expression: string): Promise<A> =>
  view.evaluate<A>(expression);

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

export const waitUntil = async (
  check: () => Promise<boolean>,
  label: string,
  timeoutMillis = 5_000,
): Promise<void> => {
  const until = performance.now() + timeoutMillis;
  while (performance.now() < until) {
    if (await check()) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
};

export interface RunningGateway {
  readonly gateway: Gateway.Gateway;
  readonly attachToken: string;
  readonly readToken: string;
  readonly close: () => Promise<void>;
}

/** The gateway's named defaults; a proof overrides the one it is about. */
type GatewayTuning = Pick<Gateway.GatewayOptions, "allowedOrigin"> &
  Partial<Pick<Gateway.GatewayOptions, "port" | "maxSnapshotBytes" | "maxRoots">>;

export const startGateway = async (options: GatewayTuning): Promise<RunningGateway> => {
  const attachToken = Gateway.makeToken();
  const readToken = Gateway.makeToken();
  const scope = Effect.runSync(Scope.make());
  const gateway = await Effect.runPromise(
    Scope.provide(
      Gateway.make({
        port: 0,
        maxSnapshotBytes: Gateway.defaultMaxSnapshotBytes,
        maxRoots: Gateway.defaultMaxRoots,
        ...options,
        attachToken,
        readToken,
      }),
      scope,
    ),
  );
  return {
    gateway,
    attachToken,
    readToken,
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
};

export const stats = (running: RunningGateway) => Effect.runPromise(running.gateway.stats);

export const cli = (
  argv: ReadonlyArray<string>,
  token: string,
  interrupt?: AbortSignal,
): Promise<Client.CliResult> =>
  Effect.runPromise(Client.run(argv, interrupt === undefined ? { token } : { token, interrupt }));

export const cliJson = async <A>(
  argv: ReadonlyArray<string>,
  token: string,
): Promise<{ readonly result: Client.CliResult; readonly body: A }> => {
  const result = await cli([...argv, "--json"], token);
  return { result, body: JSON.parse(result.stdout) };
};
