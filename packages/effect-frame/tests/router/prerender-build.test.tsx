/* oxlint-disable effect/noGlobals -- the serving proofs build web-standard Requests and read Responses, the boundary under test. */
import { registerDom } from "./dom-setup.js";

registerDom();

import {
  Authenticated,
  CurrentPrincipal,
  Policies,
  Policy,
  Streaming,
  implementQuery,
  query,
} from "effect-frame/actor";
import { QueryTest } from "effect-frame/actor/testing";
import { Route } from "effect-frame/router";
import * as Prerender from "effect-frame/router/prerender";
import { View } from "effect-frame/view";
import { BunServices } from "@effect/platform-bun";
import { Clock, Effect, Exit, Fiber, FileSystem, Layer, Schema } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { eventually, idOf, makeControl, recordsIn, sideOf } from "../view/streaming-fixture.js";
import {
  blogLabels,
  blogRoutes,
  buildInto,
  clientBundle,
  indexRoute,
  labelOf,
  linksIn,
  namesIn,
  origin,
  postSegment,
  readText,
  routerFallback,
  seedIn,
  slugs,
  tempDirectory,
  textOfResponse,
  generationOf,
  servedTree,
  treeOf,
} from "./prerender-fixture.js";

/**
 * The prerender build and the server in front of it (#23 §2, §5, #86): every
 * page renders through the router's server document, in AwaitAll, at the URL
 * its route prints, and the server answers a built page before the router
 * runs. See `docs/design/prerender.md`.
 */

const posts = slugs.map((slug) => postSegment.href({ slug }, {}));

/** A clock fixed at `at` for `builtAt`, which still sleeps in real time. */
const fixedAt = (at: number) =>
  Effect.map(Effect.clockWith(Effect.succeed), (real): Clock.Clock => ({
    currentTimeMillisUnsafe: () => at,
    currentTimeMillis: Effect.succeed(at),
    currentTimeNanosUnsafe: () => BigInt(at) * 1_000_000n,
    currentTimeNanos: Effect.succeed(BigInt(at) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => real.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: real.monotonicTimeNanos,
    sleep: (duration) => real.sleep(duration),
  }));

const withClockAt =
  (at: number) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(fixedAt(at), (clock) => Effect.provideService(effect, Clock.Clock, clock));

/** Every proof here reads and writes real files. */
const platform = it.scopedLive.layer(BunServices.layer);

describe("the prerender build (#23 §2)", () => {
  platform(
    "prerender renders every input through the SSR pipeline, at the URL href prints",
    () =>
      Effect.gen(function* () {
        const control = makeControl(blogLabels);
        const server = yield* sideOf(control);
        const directory = yield* tempDirectory;
        const out = `${directory}/dist/prerender`;
        const manifest = yield* buildInto(server, blogRoutes, out);

        // One page per input, each at the href its route prints.
        expect(manifest.pages.map((page) => page.href)).toEqual(
          [indexRoute.href({}, {}), ...posts].toSorted(),
        );
        expect(posts).toContain("/blog/a%2Fb");
        for (const page of manifest.pages) {
          expect(page.file).toBe(`${page.href.slice(1)}/index.html`);
          const html = yield* readText(`${yield* generationOf(out)}/${page.file}`);
          expect(html).toContain(Prerender.clientScript);
        }
        const aPost = yield* readText(`${yield* generationOf(out)}/blog/a%2Fb/index.html`);
        expect(aPost).toContain('<p id="body">body of a/b</p>');
        expect(manifest.client).toBe("client.js");
        expect(yield* readText(`${yield* generationOf(out)}/client.js`)).toBe(clientBundle);
        expect(JSON.parse(yield* readText(`${yield* generationOf(out)}/manifest.json`))).toEqual(
          manifest,
        );
      }),
    10_000,
  );

  platform("every link a prerendered page renders points at a page that was built", () =>
    Effect.gen(function* () {
      const server = yield* sideOf(makeControl(blogLabels));
      const directory = yield* tempDirectory;
      const out = `${directory}/out`;
      const manifest = yield* buildInto(server, blogRoutes, out);
      const built = new Set(manifest.pages.map((page) => page.href));
      const links: Array<string> = [];
      for (const page of manifest.pages) {
        links.push(...linksIn(yield* readText(`${yield* generationOf(out)}/${page.file}`)));
      }
      expect(links.length).toBeGreaterThan(slugs.length);
      expect(links.filter((link) => !built.has(link))).toEqual([]);
    }),
  );

  platform("a prerendered document is AwaitAll: only a seed of patches, stamped builtAt", () =>
    Effect.gen(function* () {
      const server = yield* sideOf(makeControl(blogLabels));
      const directory = yield* tempDirectory;
      const out = `${directory}/out`;
      const manifest = yield* buildInto(server, blogRoutes, out);
      const html = yield* readText(`${yield* generationOf(out)}/blog/first/index.html`);
      expect(html).not.toContain(Streaming.containerId);
      expect(recordsIn(html)).toEqual([]);
      const seed = seedIn(html);
      expect(seed.map((patch) => patch.id)).toEqual([idOf("post-first")]);
      expect(seed.map((patch) => patch.builtAt)).toEqual([manifest.builtAt]);
      expect(seed.map((patch) => patch.outcome._tag)).toEqual(["Value"]);
    }),
  );

  platform("nested prerender routes enumerate the product of parent and child inputs", () =>
    Effect.gen(function* () {
      const runs: Array<string> = [];
      const org = Route.segment("org", {
        path: "/:org",
        params: Schema.Struct({ org: Schema.String }),
      });
      const doc = Route.child(org, "doc", {
        path: "docs/:doc",
        params: Schema.Struct({ org: Schema.String, doc: Schema.String }),
      });
      const tree = Route.prerender(
        "orgs",
        Route.layout(org, [Route.leaf(doc, () => Effect.succeed(<p>doc</p>))], (props) =>
          Effect.map(props.outlet, (outlet) => <main>{outlet}</main>),
        ),
        {
          inputs: [
            Route.inputs(org, Effect.succeed([{ org: "x" }, { org: "y" }, { org: "z" }])),
            Route.inputs(doc, ({ org: parent }) =>
              Effect.sync(() => {
                runs.push(parent);
                return [{ doc: "1" }, { doc: "2" }];
              }),
            ),
          ],
        },
      );
      const server = yield* sideOf(makeControl({}));
      const directory = yield* tempDirectory;
      const manifest = yield* buildInto(server, [tree], `${directory}/out`);
      expect(runs).toEqual(["x", "y", "z"]);
      expect(manifest.pages.map((page) => page.href)).toEqual([
        "/x/docs/1",
        "/x/docs/2",
        "/y/docs/1",
        "/y/docs/2",
        "/z/docs/1",
        "/z/docs/2",
      ]);
    }),
  );

  platform("two inputs that print one href are one page, and pages are listed by href", () =>
    Effect.gen(function* () {
      const tag = Route.segment("tag", {
        path: "/tags/:tag",
        params: Schema.Struct({ tag: Schema.String }),
      });
      const tree = Route.prerender(
        "tags",
        Route.leaf(tag, () => Effect.succeed(<p>tag</p>)),
        {
          inputs: [Route.inputs(tag, Effect.succeed([{ tag: "b" }, { tag: "a" }, { tag: "b" }]))],
        },
      );
      const server = yield* sideOf(makeControl({}));
      const directory = yield* tempDirectory;
      const manifest = yield* buildInto(server, [tree], `${directory}/out`);
      expect(manifest.pages.map((page) => page.href)).toEqual(["/tags/a", "/tags/b"]);
    }),
  );

  platform("a prerender leaf under a plain layout that contributes no params builds", () =>
    Effect.gen(function* () {
      const chrome = Route.segment("chrome", { path: "/docs", params: Schema.Struct({}) });
      const page = Route.child(chrome, "page", {
        path: ":page",
        params: Schema.Struct({ page: Schema.String }),
      });
      const tree = Route.prerender(
        "chrome",
        Route.layout(
          chrome,
          [Route.leaf(page, () => Effect.succeed(<p id="page">page</p>))],
          (props) => Effect.map(props.outlet, (outlet) => <nav>{outlet}</nav>),
        ),
        { inputs: [Route.inputs(page, () => Effect.succeed([{ page: "intro" }]))] },
      );
      const server = yield* sideOf(makeControl({}));
      const directory = yield* tempDirectory;
      const manifest = yield* buildInto(server, [tree], `${directory}/out`);
      expect(manifest.pages.map((one) => one.href)).toEqual(["/docs/intro"]);
      expect(
        yield* readText(`${yield* generationOf(`${directory}/out`)}/docs/intro/index.html`),
      ).toContain('<nav><p id="page" tabindex="-1">page</p></nav>');
    }),
  );

  platform("the build issues one read for a query two routes share", () =>
    Effect.gen(function* () {
      const control = makeControl(blogLabels);
      const server = yield* sideOf(control);
      const directory = yield* tempDirectory;
      const manifest = yield* buildInto(server, blogRoutes, `${directory}/out`);
      // N posts and the index: N + 1 pages, and the index query the posts'
      // inputs and the index page both read is read once.
      expect(manifest.pages).toHaveLength(slugs.length + 1);
      expect(control.calls.filter((id) => id === "index")).toEqual(["index"]);
    }),
  );

  platform(
    "a rebuild over an unchanged store produces the same content, apart from builtAt and the ETags it changes",
    () =>
      Effect.gen(function* () {
        const server = yield* sideOf(makeControl(blogLabels));
        const directory = yield* tempDirectory;
        const out = `${directory}/out`;
        const first = yield* buildInto(server, blogRoutes, out).pipe(withClockAt(1_000));
        const firstTree = yield* servedTree(out);
        const again = yield* buildInto(server, blogRoutes, out).pipe(withClockAt(1_000));
        // At one instant, the trees are byte-identical.
        expect(yield* servedTree(out)).toEqual(firstTree);
        expect(again).toEqual(first);

        // At another instant, only `builtAt` and the validators it changes differ.
        const later = yield* buildInto(server, blogRoutes, out).pipe(withClockAt(2_000));
        expect(later.builtAt).toBe(2_000);
        const unstamped = (text: string) =>
          text
            .replaceAll(/"builtAt":\d+/g, "builtAt")
            .replaceAll(/"etag":"(?:[^"\\]|\\.)*"/g, "etag");
        expect((yield* servedTree(out)).map(([name, text]) => [name, unstamped(text)])).toEqual(
          firstTree.map(([name, text]) => [name, unstamped(text)]),
        );
        expect(yield* namesIn(`${out}/staging`)).toEqual([]);
        // No loaded site holds an older generation: only the published one is left.
        expect(yield* namesIn(`${out}/generations`)).toHaveLength(1);
      }),
  );

  platform(
    "a crashed build leaves the previous tree serving, and leaves no staging behind",
    () =>
      Effect.gen(function* () {
        const directory = yield* tempDirectory;
        const out = `${directory}/out`;
        const good = yield* sideOf(makeControl(blogLabels));
        yield* buildInto(good, blogRoutes, out);
        const previous = yield* servedTree(out);

        // Abort mid-build: one post's read never answers, and the build is interrupted.
        // The store changed since: a page this build wrote would differ.
        const changed = { ...blogLabels, "post-a/b": "changed", "post-first": "changed" };
        const held = makeControl(changed, ["post-second"]);
        const stuck = yield* sideOf(held);
        const building = yield* Effect.forkChild(buildInto(stuck, blogRoutes, out));
        yield* eventually("the held read started", () => held.calls.includes("post-second"));
        yield* Fiber.interrupt(building);
        expect(yield* servedTree(out)).toEqual(previous);
        expect(yield* namesIn(`${out}/staging`)).toEqual([]);
        expect(yield* namesIn(`${out}/generations`)).toHaveLength(1);

        // A build that fails partway leaves it as well.
        const failing = makeControl(changed);
        const Broken = Route.prerender("broken", {
          path: "/broken",
          params: Schema.Struct({}),
          search: Route.search(Schema.Struct({})),
          view: () => Effect.die("the page crashed"),
          inputs: Effect.succeed([{}]),
        });
        const crashed = yield* Effect.exit(
          buildInto(yield* sideOf(failing), [...blogRoutes, Broken], out),
        );
        expect(Exit.isFailure(crashed)).toBe(true);
        expect(yield* servedTree(out)).toEqual(previous);
        expect(yield* namesIn(`${out}/staging`)).toEqual([]);
        expect(yield* namesIn(`${out}/generations`)).toHaveLength(1);
      }),
    10_000,
  );
});

// ---------------------------------------------------------------------------
// A policy that refuses Anonymous fails the build (#23 §2.3)
// ---------------------------------------------------------------------------

const Draft = query("PrerenderDraft", {
  version: 1,
  args: Schema.Struct({ id: Schema.String }),
  result: Schema.Struct({ label: Schema.String }),
  policy: "member",
  depends: [],
});

const draftLabel = "unpublished-draft";

const guarded = Layer.build(
  QueryTest.layer({
    queries: [implementQuery(Draft, { run: () => Effect.succeed({ label: draftLabel }) })],
  }).pipe(
    Layer.provide(Layer.succeed(Policies, Policies.of({ member: Policy.authenticated }))),
    Layer.orDie,
  ),
);

const draftSegment = Route.segment("draft", {
  path: "/drafts/:id",
  params: Schema.Struct({ id: Schema.String }),
  data: ({ params }) => ({ draft: Route.query(Draft, { id: params.id }) }),
});

const draftRoute = Route.prerender(
  "drafts",
  Route.leaf(draftSegment, (props) =>
    Effect.succeed(<p id="draft">{View.bind(props.data.draft.state, labelOf)}</p>),
  ),
  { inputs: [Route.inputs(draftSegment, Effect.succeed([{ id: "d1" }]))] },
);

describe("a prerender build renders as Anonymous (#23 §2.3)", () => {
  platform(
    "a query whose policy refuses Anonymous fails the build with PrerenderUnauthorized and writes no file",
    () =>
      Effect.gen(function* () {
        const server = yield* guarded;
        const directory = yield* tempDirectory;
        const out = `${directory}/out`;
        // A signed-in caller changes nothing: the build is Anonymous.
        const refused = yield* Effect.flip(
          buildInto(server, [draftRoute], out).pipe(
            Effect.provideService(
              CurrentPrincipal,
              Authenticated.make({ subject: "alice", claims: {} }),
            ),
          ),
        );
        expect(refused).toEqual(
          Prerender.PrerenderUnauthorized.make({
            route: "drafts",
            href: "/drafts/d1",
            read: "query",
            contract: "PrerenderDraft",
          }),
        );
        expect(yield* treeOf(out)).toEqual([]);

        // Over a tree already built, the refusal leaves it untouched.
        yield* buildInto(yield* sideOf(makeControl(blogLabels)), blogRoutes, out);
        const previous = yield* servedTree(out);
        yield* Effect.flip(buildInto(server, [draftRoute], out));
        expect(yield* servedTree(out)).toEqual(previous);
        expect(previous.some(([, text]) => text.includes(draftLabel))).toBe(false);
      }),
  );
});

// ---------------------------------------------------------------------------
// Serving (#23 §5)
// ---------------------------------------------------------------------------

const request = (path: string, headers: Record<string, string> = {}) =>
  new Request(`${origin}${path}`, { headers });

describe("serving a prerendered tree (#23 §5)", () => {
  platform(
    "a prerendered file is served before the router runs, with an ETag, and If-None-Match answers 304",
    () =>
      Effect.gen(function* () {
        const server = yield* sideOf(makeControl(blogLabels));
        const directory = yield* tempDirectory;
        const out = `${directory}/out`;
        const manifest = yield* buildInto(server, blogRoutes, out);
        const site = yield* Prerender.load(out);
        const routed: Array<string> = [];
        const handler = yield* Prerender.serve(site, routerFallback(server, blogRoutes, routed));
        const page = manifest.pages.find((one) => one.href === "/blog/first");
        const etag = page?.etag ?? "";

        const hit = yield* handler(request("/blog/first"));
        expect(hit.status).toBe(200);
        expect(hit.headers.get("etag")).toBe(etag);
        expect(hit.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
        expect(yield* textOfResponse(hit)).toBe(
          yield* readText(`${yield* generationOf(out)}/blog/first/index.html`),
        );

        const fresh = yield* handler(request("/blog/first", { "if-none-match": etag }));
        expect(fresh.status).toBe(304);
        expect(yield* textOfResponse(fresh)).toBe("");
        const weak = yield* handler(request("/blog/first", { "if-none-match": `"x", W/${etag}` }));
        expect(weak.status).toBe(304);
        const stale = yield* handler(request("/blog/first", { "if-none-match": '"other"' }));
        expect(stale.status).toBe(200);

        const bundle = yield* handler(request("/client.js"));
        expect(yield* textOfResponse(bundle)).toBe(clientBundle);
        // No request the tree answered reached the router.
        expect(routed).toEqual([]);

        const missing = yield* handler(request("/elsewhere"));
        expect(missing.status).toBe(404);
        expect(routed).toEqual(["/elsewhere"]);
      }),
  );

  platform(
    "a prerender route with no file on disk answers through SSR, and its patches carry no builtAt",
    () =>
      Effect.gen(function* () {
        const server = yield* sideOf(makeControl(blogLabels));
        const directory = yield* tempDirectory;
        const out = `${directory}/out`;
        yield* buildInto(server, blogRoutes, out);
        const built = yield* readText(`${yield* generationOf(out)}/blog/first/index.html`);
        const site = yield* Prerender.load(out);
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(`${yield* generationOf(out)}/blog/first/index.html`);
        const routed: Array<string> = [];
        const handler = yield* Prerender.serve(site, routerFallback(server, blogRoutes, routed));

        const answer = yield* handler(request("/blog/first"));
        expect([answer.status, answer.headers.get("x-mode")]).toEqual([200, "AwaitAll"]);
        expect(routed).toEqual(["/blog/first"]);
        const html = yield* textOfResponse(answer);
        const seed = seedIn(html);
        expect(seed.map((patch) => patch.id)).toEqual([idOf("post-first")]);
        expect(seed.every((patch) => !("builtAt" in patch))).toBe(true);
        // The same document, but for the stamp.
        expect(html).toBe(built.replaceAll(/,"builtAt":\d+/g, ""));
      }),
  );

  platform("a tree with no manifest serves nothing, and every request renders", () =>
    Effect.gen(function* () {
      const directory = yield* tempDirectory;
      const site = yield* Prerender.load(`${directory}/none`);
      expect(site.pages.size).toBe(0);
      const routed: Array<string> = [];
      const server = yield* sideOf(makeControl(blogLabels));
      const handler = yield* Prerender.serve(site, routerFallback(server, blogRoutes, routed));
      yield* handler(request("/client.js"));
      expect(routed).toEqual(["/client.js"]);
    }),
  );
});
