import { registerDom } from "./dom-setup.js";

registerDom();

import { Route } from "effect-frame/router";
import * as Prerender from "effect-frame/router/prerender";
import { BunServices } from "@effect/platform-bun";
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, Option, Schema } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { Slug } from "../src/contract.js";
import { routes } from "../src/routes.js";
import { index, post } from "../src/segments.js";
import {
  buildInto,
  builtPage,
  generationOf,
  hiddenValue,
  linksIn,
  makeReads,
  published,
  readText,
  storeOf,
  treeOf,
  withClockAt,
  withoutMinted,
  workspace,
  writePost,
} from "./fixture.js";
import { DraftRoute, refusedTree } from "./fixture-routes.js";

/**
 * The Blog build (#23 §2, #25 §2): every page the tree enumerates, written
 * where its route's `href` says, from one read of the store, as
 * `Anonymous`. See `docs/design/blog-example.md`.
 */

const platform = it.scopedLive.layer(BunServices.layer);

const slug = Schema.decodeSync(Slug);

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

/** The first published post. */
const firstPost = Option.getOrThrow(Option.fromNullishOr(published[0]));

/** A manifest with every ETag masked. */
const withoutEtags = (text: string) => text.replaceAll(/"etag":"(?:[^"\\]|\\.)*"/g, "etag");

/** The hrefs the build must write: the index, and one per published post. */
const expectedHrefs = [
  index.href({}, {}),
  ...published.map((one) => post.href({ slug: slug(one.slug) }, {})),
].toSorted();

describe("the Blog build (#23 §2)", () => {
  platform("each built page sits at the href its route prints, and the manifest says so", () =>
    Effect.gen(function* () {
      const site = yield* workspace();
      const store = yield* storeOf(site.posts);
      const manifest = yield* buildInto(store, site.out);
      const generation = yield* generationOf(site.out);

      expect(manifest.pages.map((page) => page.href)).toEqual(expectedHrefs);
      for (const page of manifest.pages) {
        expect(page.file).toBe(`${page.href.slice(1)}/index.html`);
        const html = yield* readText(`${generation}/${page.file}`);
        expect(html).toContain(Prerender.clientScript);
      }
      // The draft is not a page: the index does not list it.
      expect(manifest.pages.map((page) => page.href)).not.toContain("/posts/next-week");
      // The receipt on disk is the one the build returned.
      expect(decodeJson(yield* readText(`${generation}/manifest.json`))).toEqual(manifest);
      expect(yield* readText(`${generation}/client.js`)).toBe('console.log("blog");');
    }),
  );

  platform("every link a built page renders points at a page that was built", () =>
    Effect.gen(function* () {
      const site = yield* workspace();
      const manifest = yield* buildInto(yield* storeOf(site.posts), site.out);
      const built = new Set(manifest.pages.map((page) => page.href));
      const indexLinks = linksIn(yield* builtPage(site.out, "/posts"));
      // The index links to every published post, and to itself from the chrome.
      expect(indexLinks.toSorted()).toEqual(expectedHrefs);
      const links: Array<string> = [];
      for (const page of manifest.pages) {
        links.push(...linksIn(yield* builtPage(site.out, page.href)));
      }
      expect(links.filter((link) => !built.has(link))).toEqual([]);
    }),
  );

  platform("the build reads PostIndex once for N + 1 pages", () =>
    Effect.gen(function* () {
      const site = yield* workspace();
      const reads = makeReads();
      const manifest = yield* buildInto(yield* storeOf(site.posts, reads), site.out);
      // The posts' inputs and the index page read the same key: one handler run.
      expect(manifest.pages).toHaveLength(published.length + 1);
      expect(reads.index).toBe(1);
      // Each post body is read once, by its own page.
      expect(reads.bodies.toSorted()).toEqual(published.map((one) => one.slug).toSorted());
    }),
  );

  platform("the Blog tree, whose chrome adds no param, is accepted at definition", () =>
    Effect.sync(() => {
      // Building `routes` ran the check; the chrome needed no inputs.
      expect(routes.map((route) => route.name)).toEqual(["blog"]);
    }),
  );

  platform(
    "a prerender post leaf under an org layout that adds a param is refused at definition",
    () =>
      Effect.sync(() => {
        const refused = Effect.runSyncExit(
          Effect.try({
            try: refusedTree,
            catch: (thrown) =>
              Option.getOrElse(
                Option.liftPredicate(thrown, Schema.is(Route.PrerenderAncestorNotEnumerable)),
                () =>
                  Route.PrerenderAncestorNotEnumerable.make({
                    route: "?",
                    leaf: "?",
                    ancestor: "not the refusal",
                    param: String(thrown),
                  }),
              ),
          }),
        );
        expect(Exit.isFailure(refused)).toBe(true);
        const error = Option.getOrThrow(Exit.findErrorOption(refused));
        expect(error).toBeInstanceOf(Route.PrerenderAncestorNotEnumerable);
        expect(error).toMatchObject({
          _tag: "PrerenderAncestorNotEnumerable",
          route: "org-posts",
          leaf: "post",
          ancestor: "org",
          param: "org",
        });
      }),
  );

  platform(
    "a route whose query refuses Anonymous fails the build with PrerenderUnauthorized, and the published tree is untouched",
    () =>
      Effect.gen(function* () {
        const site = yield* workspace();
        const store = yield* storeOf(site.posts);
        yield* buildInto(store, site.out);
        const before = yield* treeOf(site.out);

        const failed = yield* Effect.exit(buildInto(store, site.out, [...routes, DraftRoute]));
        expect(Exit.isFailure(failed)).toBe(true);
        const error = Option.getOrThrow(Exit.findErrorOption(failed));
        expect(error).toMatchObject({
          _tag: "PrerenderUnauthorized",
          route: "drafts",
          href: "/drafts/next-week",
          read: "query",
          contract: "Draft",
        });
        // Nothing was written: the published tree, pointer and all, is as it was.
        expect(yield* treeOf(site.out)).toEqual(before);
        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.readDirectory(`${site.out}/staging`)).toEqual([]);
      }),
  );

  platform(
    "the prerender command exits non-zero on PrerenderUnauthorized and writes nothing",
    () =>
      Effect.gen(function* () {
        const site = yield* workspace();
        const script = new URL("./build-with-draft.ts", import.meta.url).pathname;
        const child = yield* Effect.sync(() =>
          // oxlint-disable-next-line effect/noGlobals -- the command is a real process.
          Bun.spawn(["bun", "--conditions=source", script, site.posts, site.out], {
            stdout: "pipe",
            stderr: "pipe",
          }),
        );
        const [code, stdout, stderr] = yield* Effect.all(
          [
            Effect.promise(() => child.exited),
            // oxlint-disable-next-line effect/noGlobals -- reads the process's own pipes.
            Effect.promise(() => Bun.readableStreamToText(child.stdout)),
            // oxlint-disable-next-line effect/noGlobals -- reads the process's own pipes.
            Effect.promise(() => Bun.readableStreamToText(child.stderr)),
          ],
          { concurrency: "unbounded" },
        );
        const run = { code, output: `${stdout}${stderr}` };
        expect(run.code).not.toBe(0);
        expect(run.output).toContain("PrerenderUnauthorized");
        const fs = yield* FileSystem.FileSystem;
        expect(yield* Effect.orDie(fs.exists(`${site.out}/current.json`))).toBe(false);
        // Only the empty staging directory the build opened remains.
        expect(yield* treeOf(site.out)).toEqual([]);
      }),
    20_000,
  );

  platform(
    "a rebuild over an unchanged store is the same tree but for builtAt and each form's minted identity",
    () =>
      Effect.gen(function* () {
        const site = yield* workspace();
        const store = yield* storeOf(site.posts);
        const first = yield* buildInto(store, site.out).pipe(withClockAt(1_000));
        const firstTree = yield* treeOf(yield* generationOf(site.out));
        const again = yield* buildInto(store, site.out).pipe(withClockAt(1_000));
        const againTree = yield* treeOf(yield* generationOf(site.out));

        // At one instant, only each post's minted heart identity differs.
        expect(againTree.map(([name]) => name)).toEqual(firstTree.map(([name]) => name));
        const pairs = firstTree.map(([name, text], at) => ({
          name,
          text,
          next: Option.getOrElse(Option.fromNullishOr(againTree[at]?.[1]), () => ""),
        }));
        for (const one of pairs) {
          if (one.name.endsWith("index.html")) {
            expect(withoutMinted(one.next)).toBe(withoutMinted(one.text));
          } else if (one.name === "manifest.json") {
            // A post's ETag hashes its bytes, minted identity included.
            expect(withoutEtags(one.next)).toBe(withoutEtags(one.text));
          } else {
            expect(one.next).toBe(one.text);
          }
        }
        const minted = pairs
          .filter((one) => one.name.endsWith("index.html") && one.next !== one.text)
          .map((one) => one.name);
        expect(minted.toSorted()).toEqual(
          published.map((one) => `posts/${one.slug}/index.html`).toSorted(),
        );
        // Those pages' command ids differ: a render mints its own (see the design note).
        const aPost = pairs.find((one) => one.name === minted[0]);
        expect(hiddenValue(aPost?.next ?? "", "heart", "$command")).not.toBe(
          hiddenValue(aPost?.text ?? "", "heart", "$command"),
        );
        expect(again.builtAt).toBe(first.builtAt);

        // At another instant, `builtAt` and the ETags that hash it change too, and nothing else.
        const later = yield* buildInto(store, site.out).pipe(withClockAt(2_000));
        expect(later.builtAt).toBe(2_000);
        const unstamped = (text: string) =>
          withoutEtags(withoutMinted(text)).replaceAll(/"builtAt":\d+/g, "builtAt");
        expect(
          (yield* treeOf(yield* generationOf(site.out))).map(([name, text]) => [
            name,
            unstamped(text),
          ]),
        ).toEqual(firstTree.map(([name, text]) => [name, unstamped(text)]));
      }),
  );

  platform("a build aborted mid-way leaves the previous tree serving, and no staging", () =>
    Effect.gen(function* () {
      const site = yield* workspace();
      const store = yield* storeOf(site.posts);
      yield* buildInto(store, site.out);
      const previous = yield* treeOf(site.out);

      // The posts change, and the next build stops before it publishes:
      // every page is written, and the bundle never answers.
      yield* writePost(site.posts, { ...firstPost, title: "Changed" });
      const held = yield* Deferred.make<string>();
      const building = yield* Effect.forkChild(
        buildInto(store, site.out, routes, Deferred.await(held)),
      );
      const fs = yield* FileSystem.FileSystem;
      yield* Effect.repeat(Effect.sleep("10 millis"), {
        until: () =>
          Effect.map(
            Effect.orElseSucceed(fs.readDirectory(`${site.out}/staging`), () => []),
            (names) => names.length > 0,
          ),
        times: 200,
      });
      yield* Fiber.interrupt(building);
      const exit = yield* Fiber.await(building);
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);

      expect(yield* treeOf(site.out)).toEqual(previous);
      expect(yield* fs.readDirectory(`${site.out}/staging`)).toEqual([]);
      expect(yield* builtPage(site.out, "/posts")).not.toContain("Changed");
    }),
  );
});
