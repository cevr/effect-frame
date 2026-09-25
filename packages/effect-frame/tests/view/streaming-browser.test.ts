/* oxlint-disable effect/noAsyncFunction, effect/noGlobals, effect/noNullish, effect/noThrowStatement, effect/noNewError, effect/noTryCatch, effect/noNodeBuiltinImport, no-await-in-loop -- this proof drives real WebKit and Chrome pages through Bun.WebView against a real streaming Bun server. */
/**
 * Streamed documents (#22), real-browser proofs. A Bun server streams the
 * page from `browser/streaming-page.tsx`; WebKit and Chrome parse it and run
 * `browser/streaming-app.tsx`, which hydrates it. Every page is served with
 * `script-src 'self'`: an inline script cannot run, so a record that had to
 * run would fail here.
 */
import { resolve } from "node:path";
import { describe, expect, it } from "bun:test";
import { HttpServer, Policies, Policy, implementQuery } from "effect-frame/actor";
import type { ActorTransport, QueryCache } from "effect-frame/actor";
import { QueryTest } from "effect-frame/actor/testing";
import { Html } from "effect-frame/view";
import type { Context } from "effect";
import { Deferred, Effect, Exit, Layer, Option, Scope, Stream } from "effect";
import * as H from "../router/browser/harness.js";
import { Label, Page, TallPage } from "./browser/streaming-page.js";

const chrome = await H.capabilities("chrome");
const webkit = await H.capabilities("webkit");

let bundled: Promise<string> | undefined;
const bundleOnce = (): Promise<string> => {
  bundled ??= Bun.build({
    entrypoints: [resolve(import.meta.dir, "browser/streaming-app.tsx")],
    target: "browser",
    format: "esm",
    minify: false,
    conditions: ["browser", "source"],
  }).then(async (result) => {
    if (!result.success) throw new Error(result.logs.map((log) => log.message).join("\n"));
    const output = result.outputs[0];
    if (output === undefined) throw new Error("no bundle for streaming-app.tsx");
    return output.text();
  });
  return bundled;
};

type Mode = "defer" | "async" | "cut" | "await-all" | "split" | "tall";

/** The `split` label: a patch far larger than one parser step. */
const largeLabel = "x".repeat(200_000);

/** No time limit: the page waits for its query. */
const noLimit = { closeWhen: Effect.never };

interface PageServer {
  readonly origin: string;
  /** Every read the query host served: the render's, then the client's. */
  readonly reads: Array<string>;
  /** Every actor route the client called, such as `/query`. */
  readonly calls: Array<string>;
  readonly stop: () => Promise<void>;
}

/**
 * One page server. The query `a` is held until the client reports it has
 * hydrated, except in `await-all`, which cannot send a byte before it settles,
 * and in `tall`, where the test releases it with `POST /release`.
 */
const servePage = async (mode: Mode): Promise<PageServer> => {
  const script = await bundleOnce();
  const gate = Deferred.makeUnsafe<void>();
  const reads: Array<string> = [];
  const calls: Array<string> = [];
  const scope = Effect.runSync(Scope.make());
  const layer = QueryTest.layer({
    queries: [
      implementQuery(Label, {
        run: (args) =>
          Effect.gen(function* () {
            reads.push(args.id);
            const nth = reads.length;
            if (mode !== "await-all") yield* Deferred.await(gate);
            if (mode === "split") return { label: largeLabel };
            return { label: `label ${String(nth)}` };
          }),
      }),
    ],
  });
  const context: Context.Context<QueryCache | ActorTransport> = await Effect.runPromise(
    Scope.provide(
      Layer.build(
        Layer.provide(layer, Layer.succeed(Policies, Policies.of({ public: Policy.allowAll }))),
      ),
      scope,
    ),
  );
  const actors = await Effect.runPromise(
    Effect.provideContext(
      HttpServer.make({
        prefix: "/actors",
        principal: HttpServer.anonymous,
        maxBodyBytes: HttpServer.defaultMaxBodyBytes,
        form: Option.none(),
      }),
      context,
    ),
  );
  let bootstrap = '<script type="module" src="/client.js"></script>';
  if (mode === "async" || mode === "split" || mode === "tall") {
    bootstrap = '<script type="module" async src="/client.js"></script>';
  }
  let main = '<main id="app">';
  if (mode === "tall") main = '<main id="app" data-page="tall">';
  const frame: Html.Document = {
    head: `<!doctype html><html><head><meta charset="utf-8"><title>streaming</title></head><body>${main}`,
    tail: "</main>",
    bootstrap,
    end: "</body></html>",
  };
  const page = (): ReadableStream<Uint8Array> => {
    if (mode === "await-all") {
      return Stream.toReadableStreamWith(
        Stream.encodeText(
          Stream.fromEffect(Html.renderAwaitAll(Page, { id: "a" }, frame, noLimit)),
        ),
        context,
      );
    }
    let streamed = Html.renderToStream(Page, { id: "a" }, frame, noLimit);
    if (mode === "tall") streamed = Html.renderToStream(TallPage, { id: "a" }, frame, noLimit);
    // `split`: the patch goes out in two writes with a pause between, so the
    // parser appends the record's element before all of its text. `Closed`
    // waits longer, so a record read only when the next one arrives shows.
    if (mode === "split") {
      const halves = Stream.flatMap(streamed, (chunk) => {
        if (chunk.includes('"Closed"')) {
          return Stream.fromEffect(Effect.as(Effect.sleep("1500 millis"), chunk));
        }
        if (!chunk.includes('"Patch"')) return Stream.succeed(chunk);
        const half = Math.floor(chunk.length / 2);
        return Stream.concat(
          Stream.succeed(chunk.slice(0, half)),
          Stream.fromEffect(Effect.as(Effect.sleep("300 millis"), chunk.slice(half))),
        );
      });
      return Stream.toReadableStreamWith(Stream.encodeText(halves), context);
    }
    // `cut`: the response ends after the first chunk, before any patch or `Closed`.
    if (mode === "cut") {
      return Stream.toReadableStreamWith(Stream.encodeText(Stream.take(streamed, 1)), context);
    }
    return Stream.toReadableStreamWith(Stream.encodeText(streamed), context);
  };
  const headers = {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "script-src 'self'",
  };
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/client.js") {
        return new Response(script, { headers: { "content-type": "text/javascript" } });
      }
      if (url.pathname === "/hydrated") {
        if (mode !== "tall") Effect.runSync(Deferred.succeed(gate, void 0));
        return new Response("ok");
      }
      if (url.pathname === "/release") {
        Effect.runSync(Deferred.succeed(gate, void 0));
        return new Response("ok");
      }
      if (url.pathname.startsWith("/actors/")) {
        calls.push(url.pathname.slice("/actors".length));
        return Effect.runPromise(actors(request));
      }
      if (url.pathname !== "/") {
        return new Response("not found", { status: 404 });
      }
      if (mode === "defer") {
        // Nothing runs before the document ends: settle the query once the
        // shell is out, so its patch is in the document before the client runs.
        Effect.runFork(Effect.andThen(Effect.sleep("150 millis"), Deferred.succeed(gate, void 0)));
      }
      return new Response(page(), { headers });
    },
  });
  return {
    origin: `http://127.0.0.1:${String(server.port)}`,
    reads,
    calls,
    stop: async () => {
      await server.stop(true);
      await Effect.runPromise(Scope.close(scope, Exit.void));
    },
  };
};

interface Seen {
  readonly labelAt: number;
  readonly closedAt: number;
  readonly report: { mismatches: Array<string>; unclaimed: number; resolvedAhead: number };
  readonly fallbackAtHydration: boolean;
  readonly stateAtHydration: string;
  readonly executableScripts: number;
  readonly closed: boolean;
}

const seen = (view: Bun.WebView) => view.evaluate<Seen>("window.__stream");
const text = (view: Bun.WebView, selector: string) =>
  view.evaluate<string>(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`);
const exists = (view: Bun.WebView, selector: string) =>
  view.evaluate<boolean>(`document.querySelector(${JSON.stringify(selector)}) !== null`);

/** Open `mode` in `engine`, run `check`, and stop both the page and its server. */
const withPage = async (
  engine: H.Engine,
  mode: Mode,
  check: (view: Bun.WebView, server: PageServer) => Promise<void>,
): Promise<void> => {
  const server = await servePage(mode);
  const backend = H.backendOf(engine);
  if (backend === undefined) throw new Error(`no ${engine} on this host`);
  const view = new Bun.WebView({ backend });
  try {
    await view.navigate(`${server.origin}/`);
    await H.waitFor(view, "window.__stream && window.__stream.hydrated", "the client hydrated");
    await check(view, server);
  } finally {
    view.close();
    await server.stop();
  }
};

/**
 * Wait for `expression` while the document is still arriving. Chrome has no
 * page to evaluate in until the navigation commits, so an early evaluate
 * throws; that is a wait, not a failure.
 */
const openWhile = async (view: Bun.WebView, expression: string): Promise<void> => {
  const until = performance.now() + 5_000;
  while (performance.now() < until) {
    const found = await view.evaluate<boolean>(`Boolean(${expression})`).catch(() => false);
    if (found) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${expression}`);
};

const proofs = (engine: H.Engine) => {
  it(
    "a patch that arrives before hydration replaces the fallback, and the report says so",
    () =>
      withPage(engine, "defer", async (view, server) => {
        // A deferred module runs after the parser finished: the patch was there first.
        const first = await seen(view);
        expect(first.report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 1 });
        expect(first.fallbackAtHydration).toBe(false);
        expect(await text(view, "#label")).toBe("label 1");
        expect(await view.evaluate<string>("document.querySelector('section').innerHTML")).toBe(
          '<p id="label">label 1</p><footer id="foot">foot</footer>',
        );
        await H.waitFor(view, "window.__stream.closed", "the channel closed");
        // The value came from the document, not from a second read.
        expect(server.reads).toEqual(["a"]);
        expect(server.calls).toEqual([]);
      }),
    30_000,
  );

  // WebKit runs no external script, async or not, before the parser ends: the
  // client can never see a late patch there. The late path is proven in Chrome.
  it.skipIf(engine === "webkit")(
    "a late patch settles the scope with no claim, observed with no script execution",
    () =>
      withPage(engine, "async", async (view, server) => {
        // An async module runs while the query is still held: the client sees the fallback.
        const first = await seen(view);
        expect(first.report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 0 });
        expect(first.fallbackAtHydration).toBe(true);
        expect(first.stateAtHydration).toBe("Loading");
        // The client's report released the query; its patch streams in and lands.
        await H.waitFor(
          view,
          `document.querySelector("#label")?.textContent === "label 1"`,
          "the late patch",
        );
        expect(await exists(view, "#pending")).toBe(false);
        await H.waitFor(view, "window.__stream.closed", "the channel closed");
        // Only the module script can run, and inline script is refused by the policy.
        expect(first.executableScripts).toBe(1);
        expect(server.reads).toEqual(["a"]);
        expect(server.calls).toEqual([]);
      }),
    30_000,
  );

  // As above: only Chrome runs the client while the document still streams.
  it.skipIf(engine === "webkit")(
    "a patch the parser appends in parts is read whole, once, with no second read",
    () =>
      withPage(engine, "split", async (view, server) => {
        const first = await seen(view);
        expect(first.fallbackAtHydration).toBe(true);
        await H.waitFor(
          view,
          `document.querySelector("#label")?.textContent.length === ${String(largeLabel.length)}`,
          "the split patch",
        );
        await H.waitFor(view, "window.__stream.closed", "the channel closed");
        // It landed when its own text was whole, well before `Closed` came.
        const landed = await view.evaluate<number>(
          "window.__stream.closedAt - window.__stream.labelAt",
        );
        expect(landed).toBeGreaterThan(750);
        // The record was read whole: no StreamEnded, so no second read.
        expect(server.reads).toEqual(["a"]);
        expect(server.calls).toEqual([]);
      }),
    30_000,
  );

  it(
    "a response that ends with no Closed fails StreamEnded, no scope hangs, and /query reaches Ready",
    () =>
      withPage(engine, "cut", async (view, server) => {
        // The document ended with the placeholder open and no `Closed`.
        expect(await exists(view, "#frame-records script.frame-record")).toBe(true);
        expect(
          await view.evaluate<boolean>(
            `document.getElementById("frame-records").textContent.includes('"Closed"')`,
          ),
        ).toBe(false);
        // The channel still ends: the entry failed StreamEnded and read again.
        await H.waitFor(view, "window.__stream.closed", "the channel ended");
        // The client read again over POST /actors/query and converged.
        await H.waitFor(
          view,
          `document.querySelector("#label")?.textContent === "label 1"`,
          "Ready",
        );
        expect(server.calls).toEqual(["/query"]);
        expect(await exists(view, "#pending")).toBe(false);
      }),
    30_000,
  );

  // The reader scrolls while the boundary 4000 px down still shows its
  // fallback, then the patch lands. In Chrome the client has hydrated and the
  // patch settles the live scope; in WebKit the parser holds the client until
  // the document ends, so hydration places the patched value. Either way the
  // content fills in place and the viewport stays where the reader put it.
  it("a late patch fills content in place and does not move the viewport", async () => {
    const server = await servePage("tall");
    const backend = H.backendOf(engine);
    if (backend === undefined) throw new Error(`no ${engine} on this host`);
    const view = new Bun.WebView({ backend });
    try {
      // The document is open until the query settles: do not wait for its load.
      const loaded = view.navigate(`${server.origin}/`);
      await openWhile(
        view,
        `document.getElementById("pending") && document.documentElement.scrollHeight > 5000`,
      );
      expect(await view.evaluate<number>("(scrollTo(0, 1000), scrollY)")).toBe(1000);
      // Chrome runs the async client while the document streams: release the
      // query only once it has hydrated, so the patch lands in a live scope.
      if (engine === "chrome") {
        await H.waitFor(view, "window.__stream && window.__stream.hydrated", "the client hydrated");
      }
      await fetch(`${server.origin}/release`, { method: "POST" });
      await H.waitFor(view, "window.__stream && window.__stream.hydrated", "the client hydrated");
      await H.waitFor(
        view,
        `document.querySelector("#label")?.textContent === "label 1"`,
        "the late patch",
      );
      await loaded;
      expect((await seen(view)).fallbackAtHydration).toBe(engine === "chrome");
      expect(await exists(view, "#pending")).toBe(false);
      expect(await view.evaluate<number>("scrollY")).toBe(1000);
      // The value came from the patch, not from a second read.
      expect(server.reads).toEqual(["a"]);
      expect(server.calls).toEqual([]);
    } finally {
      view.close();
      await server.stop();
    }
  }, 30_000);

  it(
    "an AwaitAll document writes no record channel and hydrates with no mismatch",
    () =>
      withPage(engine, "await-all", async (view, server) => {
        const first = await seen(view);
        expect(first.report).toEqual({ mismatches: [], unclaimed: 0, resolvedAhead: 0 });
        expect(await exists(view, "#frame-records")).toBe(false);
        expect(await text(view, "#label")).toBe("label 1");
        expect(server.reads).toEqual(["a"]);
        expect(server.calls).toEqual([]);
      }),
    30_000,
  );
};

describe.skipIf(webkit === undefined)("streamed documents in WebKit", () => proofs("webkit"));
describe.skipIf(chrome === undefined)("streamed documents in Chrome", () => proofs("chrome"));
