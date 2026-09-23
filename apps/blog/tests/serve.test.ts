import { registerDom } from "./dom-setup.js";

registerDom();

import * as Prerender from "effect-frame/router/prerender";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Tracer } from "effect";
import { describe, expect, it } from "effect-bun-test";
import {
  buildInto,
  builtPage,
  fetchPage,
  generationOf,
  reservedPorts,
  serverOver,
  storeOf,
  withoutBuiltAt,
  withoutMinted,
  workspace,
} from "./fixture.js";

/**
 * The built tree is a cache over SSR (#23 §5), on a real Bun server: a
 * built page is its file, answered before the router runs; a page with no
 * file falls through to the router and is the same document. See
 * `docs/design/blog-example.md`.
 */

const platform = it.scopedLive.layer(BunServices.layer);

/**
 * Every span the server opens, by name. The router opens `Branch.create`
 * for each route it matches, so a page it never touched leaves none.
 */
const spanNames = () => {
  const names: Array<string> = [];
  const tracer = Tracer.make({
    span: (options) => {
      names.push(options.name);
      return new Tracer.NativeSpan(options);
    },
  });
  return { names, layer: Layer.succeed(Tracer.Tracer, tracer) };
};

const routerRuns = (names: ReadonlyArray<string>) =>
  names.filter((name) => name === "Branch.create").length;

describe("serving the built Blog over SSR (#23 §5)", () => {
  platform(
    "a built page is its file, before the router; a missing one falls through to the router and is the same page",
    () =>
      Effect.gen(function* () {
        const site = yield* workspace();
        const store = yield* storeOf(site.posts);
        const manifest = yield* buildInto(store, site.out);
        const spans = spanNames();
        const server = yield* serverOver(store, site.out, spans.layer);
        expect(reservedPorts).not.toContain(server.port);
        const url = `${server.url}/posts/second-wind`;
        const entry = manifest.pages.find((page) => page.href === "/posts/second-wind");
        const built = yield* builtPage(site.out, "/posts/second-wind");

        // A hit: the file's bytes and its ETag, and the router never ran.
        const hit = yield* fetchPage(url);
        expect(hit.status).toBe(200);
        expect(hit.text).toBe(built);
        expect(hit.headers.get("etag")).toBe(entry?.etag ?? "");
        expect(hit.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
        expect(routerRuns(spans.names)).toBe(0);

        // A revalidation with that ETag: 304 and no body.
        const unchanged = yield* fetchPage(url, {
          headers: { "if-none-match": entry?.etag ?? "" },
        });
        expect(unchanged.status).toBe(304);
        expect(unchanged.text).toBe("");
        expect(routerRuns(spans.names)).toBe(0);

        // The bundle the build wrote beside the pages.
        const bundle = yield* fetchPage(`${server.url}/client.js`);
        expect(bundle.status).toBe(200);
        expect(bundle.text).toBe('console.log("blog");');

        // The file is gone: the router renders the page on request.
        const fs = yield* FileSystem.FileSystem;
        yield* Effect.orDie(
          fs.remove(`${yield* generationOf(site.out)}/posts/second-wind`, { recursive: true }),
        );
        const missed = yield* fetchPage(url);
        expect(missed.status).toBe(200);
        expect(routerRuns(spans.names)).toBeGreaterThan(0);
        expect(missed.text).not.toContain('"builtAt"');
        // The same document, but for the stamp and the form's minted identity.
        expect(withoutMinted(missed.text)).toBe(withoutMinted(withoutBuiltAt(built)));
      }),
    20_000,
  );

  platform(
    "a page with no file on the first start renders through the router: the output is optional",
    () =>
      Effect.gen(function* () {
        const site = yield* workspace();
        const store = yield* storeOf(site.posts);
        const spans = spanNames();
        // Nothing was built.
        const server = yield* serverOver(store, site.out, spans.layer);
        const page = yield* fetchPage(`${server.url}/posts/third-time`);
        expect(page.status).toBe(200);
        expect(page.text).toContain('<h1 id="title">Third time</h1>');
        expect(page.text).toContain(Prerender.clientScript);
        expect(routerRuns(spans.names)).toBeGreaterThan(0);
        // The bundle is the one the server built at start.
        const bundle = yield* fetchPage(`${server.url}/client.js`);
        expect(bundle.status).toBe(200);
        expect(bundle.text.length).toBeGreaterThan(1_000);
      }),
    20_000,
  );
});
