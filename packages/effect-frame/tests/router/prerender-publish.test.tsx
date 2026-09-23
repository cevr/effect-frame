/* oxlint-disable effect/noGlobals -- the serving proofs build web-standard Requests and read Responses, the boundary under test. */
import { registerDom } from "./dom-setup.js";

registerDom();

import { ActorTransport, QueryFailed } from "effect-frame/actor";
import type { QueryKey } from "effect-frame/actor";
import { Route } from "effect-frame/router";
import * as Prerender from "effect-frame/router/prerender";
import { BunServices } from "@effect/platform-bun";
import {
  Cause,
  Context,
  Crypto,
  Deferred,
  Effect,
  Encoding,
  Exit,
  Fiber,
  FileSystem,
  Option,
  Schema,
  SchemaGetter,
} from "effect";
import * as PlatformError from "effect/PlatformError";
import { describe, expect, it } from "effect-bun-test";
import { eventually, makeControl, release, sideOf } from "../view/streaming-fixture.js";
import {
  NotFound,
  blogLabels,
  blogRoutes,
  buildInto,
  generationOf,
  namesIn,
  origin,
  readText,
  routerFallback,
  servedTree,
  tempDirectory,
  textOfResponse,
} from "./prerender-fixture.js";

/**
 * Publishing a prerender build, and serving what was published (#86 round
 * 1): a build writes an immutable generation and moves one pointer; a
 * loaded site reads one generation; the build refuses pages that could not
 * be served as they were written. See `docs/design/prerender.md`.
 */

/** Every proof here reads and writes real files. */
const platform = it.scopedLive.layer(BunServices.layer);

/** The blog after an edit: a build over it writes other bytes. */
const changedLabels = { ...blogLabels, "post-first": "changed body" };

/** A generation's directory name. */
const nameOf = (directory: string) => directory.slice(directory.lastIndexOf("/") + 1);

const request = (path: string, init: RequestInit = {}) => new Request(`${origin}${path}`, init);

const injected = (method: string, path: string) =>
  PlatformError.systemError({
    _tag: "Busy",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
    description: "an injected fault",
  });

interface Faults {
  readonly rename?: (from: string, to: string) => boolean;
  readonly remove?: (path: string) => boolean;
  readonly readDirectory?: (path: string) => boolean;
  readonly makeTempDirectory?: (directory: string) => boolean;
}

/** The platform file system, failing the calls `faults` names. */
const faulty = (fs: FileSystem.FileSystem, faults: Faults): FileSystem.FileSystem => ({
  ...fs,
  rename: (from, to) => {
    if (faults.rename?.(from, to) === true) {
      return Effect.fail(injected("rename", to));
    }
    return fs.rename(from, to);
  },
  remove: (path, options) => {
    if (faults.remove?.(path) === true) {
      return Effect.fail(injected("remove", path));
    }
    return fs.remove(path, options);
  },
  readDirectory: (path, options) => {
    if (faults.readDirectory?.(path) === true) {
      return Effect.fail(injected("readDirectory", path));
    }
    return fs.readDirectory(path, options);
  },
  makeTempDirectory: (options) => {
    const directory = options?.directory ?? "";
    if (faults.makeTempDirectory?.(directory) === true) {
      return Effect.fail(injected("makeTempDirectory", directory));
    }
    return fs.makeTempDirectory(options);
  },
});

const etagOfText = (text: string) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(text));
    return `"${Encoding.encodeBase64Url(digest)}"`;
  });

describe("publishing a generation (#86)", () => {
  platform(
    "a fault at each publishing step leaves a whole generation served",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* tempDirectory;
        const out = `${directory}/out`;
        yield* buildInto(yield* sideOf(makeControl(blogLabels)), blogRoutes, out);
        const first = yield* generationOf(out);
        const firstTree = yield* servedTree(out);
        const changed = yield* sideOf(makeControl(changedLabels));
        const buildWith = (faults: Faults) =>
          Effect.exit(
            buildInto(changed, blogRoutes, out).pipe(
              Effect.provideService(FileSystem.FileSystem, faulty(fs, faults)),
            ),
          );

        // After staging: the finished build cannot move into generations.
        const staged = yield* buildWith({ rename: (from) => from.includes("/staging/") });
        expect(Exit.isFailure(staged)).toBe(true);
        expect(yield* generationOf(out)).toBe(first);
        expect(yield* servedTree(out)).toEqual(firstTree);
        expect(yield* namesIn(`${out}/staging`)).toEqual([]);
        expect(yield* namesIn(`${out}/generations`)).toHaveLength(1);

        // At the pointer: the new generation is whole, but the pointer cannot move.
        const pointed = yield* buildWith({ rename: (_from, to) => to.endsWith("current.json") });
        expect(Exit.isFailure(pointed)).toBe(true);
        expect(yield* generationOf(out)).toBe(first);
        expect(yield* servedTree(out)).toEqual(firstTree);
        expect(yield* namesIn(`${out}/generations`)).toHaveLength(1);
        expect(yield* namesIn(out)).toEqual(["current.json", "generations", "leases", "staging"]);

        // Before clean-up: the pointer moved, and removing the older generation fails.
        yield* buildInto(yield* sideOf(makeControl(blogLabels)), blogRoutes, out);
        // No site holds the first generation: the build removed it.
        expect(yield* namesIn(`${out}/generations`)).toHaveLength(1);
        const cleaned = yield* buildWith({ remove: (path) => path.includes("/generations/") });
        expect(Exit.isSuccess(cleaned)).toBe(true);
        const next = yield* generationOf(out);
        expect(next).not.toBe(first);
        expect(yield* readText(`${next}/blog/first/index.html`)).toContain("changed body");
        // The older generation is still there: clean-up waits for the next build.
        expect(yield* namesIn(`${out}/generations`)).toHaveLength(2);
      }),
    15_000,
  );

  platform(
    "after a crash, the pointer wins, else the newest whole generation, and staging is never served",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* tempDirectory;
        const out = `${directory}/out`;
        yield* buildInto(yield* sideOf(makeControl(blogLabels)), blogRoutes, out);
        const published = yield* generationOf(out);

        // What a crash at each step leaves: a half-written staging directory,
        // a whole generation it never published, and a pointer never renamed.
        yield* fs.makeDirectory(`${out}/staging/crashed/blog`, { recursive: true });
        yield* fs.writeFileString(
          `${out}/staging/crashed/manifest.json`,
          '{"builtAt":9999999999999}',
        );
        const unpublished = `${out}/generations/unpublished`;
        yield* fs.copy(published, unpublished);
        const manifest = yield* readText(`${unpublished}/manifest.json`);
        yield* fs.writeFileString(
          `${unpublished}/manifest.json`,
          manifest.replace(/"builtAt":\d+/, '"builtAt":9999999999999'),
        );
        yield* fs.writeFileString(`${out}/current.json.crashed.tmp`, '{"gener');
        expect(yield* generationOf(out)).toBe(published);

        // A generation a crash left without its manifest, first by name.
        yield* fs.copy(published, `${out}/generations/0-partial`);
        yield* fs.remove(`${out}/generations/0-partial/manifest.json`);

        // The pointer is gone: the newest whole generation wins.
        yield* fs.remove(`${out}/current.json`);
        expect(yield* generationOf(out)).toBe(unpublished);
        // The pointer names a generation that is gone: the same.
        yield* fs.writeFileString(`${out}/current.json`, '{"generation":"gone"}');
        expect(yield* generationOf(out)).toBe(unpublished);
        // A generation with no manifest is not whole.
        yield* fs.remove(`${unpublished}/manifest.json`);
        expect(yield* generationOf(out)).toBe(published);

        // The next build publishes, and removes what the crash left.
        yield* buildInto(yield* sideOf(makeControl(changedLabels)), blogRoutes, out);
        expect(yield* namesIn(`${out}/staging`)).toEqual([]);
        expect(yield* namesIn(out)).toEqual(["current.json", "generations", "leases", "staging"]);
        expect(yield* namesIn(`${out}/generations`)).toHaveLength(1);
      }),
    15_000,
  );

  platform("an interruption after the pointer rename leaves the new generation published", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* tempDirectory;
      const out = `${directory}/out`;
      const renamed = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      // The rename of the pointer is done on disk, and its Effect has not resumed.
      const slow: FileSystem.FileSystem = {
        ...fs,
        rename: (from, to) => {
          if (to.endsWith("current.json")) {
            return fs
              .rename(from, to)
              .pipe(
                Effect.andThen(Deferred.succeed(renamed, void 0)),
                Effect.andThen(Deferred.await(resume)),
              );
          }
          return fs.rename(from, to);
        },
      };
      const build = yield* Effect.forkChild(
        buildInto(yield* sideOf(makeControl(blogLabels)), blogRoutes, out).pipe(
          Effect.provideService(FileSystem.FileSystem, slow),
        ),
      );
      yield* Deferred.await(renamed);
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(build));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(resume, void 0);
      yield* Fiber.join(interrupting);
      // The first build committed: its generation is served, whole.
      const served = yield* generationOf(out);
      expect(yield* readText(`${served}/blog/first/index.html`)).toContain("body of first");
      expect(yield* namesIn(`${out}/generations`)).toHaveLength(1);
    }),
  );

  platform("one build writes an output at a time: another fails with PrerenderBuildLocked", () =>
    Effect.gen(function* () {
      const directory = yield* tempDirectory;
      const out = `${directory}/out`;
      const held = makeControl(blogLabels, ["post-second"]);
      const first = yield* Effect.forkChild(buildInto(yield* sideOf(held), blogRoutes, out));
      yield* eventually("the first build is rendering", () => held.calls.includes("post-second"));
      const refused = yield* Effect.flip(
        buildInto(yield* sideOf(makeControl(blogLabels)), blogRoutes, out),
      );
      expect(refused).toEqual(
        Prerender.PrerenderBuildLocked.make({ out, lock: `${out}/build.lock` }),
      );
      yield* release(held, "post-second");
      yield* Fiber.join(first);
      // The lock went with the build that held it.
      yield* buildInto(yield* sideOf(makeControl(blogLabels)), blogRoutes, out);
      expect(yield* namesIn(out)).toEqual(["current.json", "generations", "leases", "staging"]);
    }),
  );
});

describe("serving a loaded generation (#86)", () => {
  platform("a loaded site serves the bytes its ETag names, after a rebuild too", () =>
    Effect.gen(function* () {
      const directory = yield* tempDirectory;
      const out = `${directory}/out`;
      const server = yield* sideOf(makeControl(blogLabels));
      yield* buildInto(server, blogRoutes, out);
      const loaded = yield* Prerender.load(out);
      const routed: Array<string> = [];
      const before = yield* Prerender.serve(loaded, routerFallback(server, blogRoutes, routed));
      yield* buildInto(yield* sideOf(makeControl(changedLabels)), blogRoutes, out);

      const stale = yield* before(request("/blog/first"));
      const body = yield* textOfResponse(stale);
      expect(body).toContain("body of first");
      expect(stale.headers.get("etag")).toBe(yield* etagOfText(body));

      const after = yield* Prerender.serve(
        yield* Prerender.load(out),
        routerFallback(server, blogRoutes, routed),
      );
      const fresh = yield* after(request("/blog/first"));
      const freshBody = yield* textOfResponse(fresh);
      expect(freshBody).toContain("changed body");
      expect(fresh.headers.get("etag")).toBe(yield* etagOfText(freshBody));
      expect(routed).toEqual([]);
    }),
  );

  platform(
    "a loaded site keeps its generation across two rebuilds, and releases it when its scope closes",
    () =>
      Effect.gen(function* () {
        const directory = yield* tempDirectory;
        const out = `${directory}/out`;
        const server = yield* sideOf(makeControl(blogLabels));
        yield* buildInto(server, blogRoutes, out);
        const loadedFrom = yield* generationOf(out);
        const routed: Array<string> = [];
        yield* Effect.scoped(
          Effect.gen(function* () {
            const handler = yield* Prerender.serve(
              yield* Prerender.load(out),
              routerFallback(server, blogRoutes, routed),
            );
            // Two rebuilds: the loaded generation is two behind the pointer.
            for (const labels of [changedLabels, blogLabels]) {
              yield* buildInto(yield* sideOf(makeControl(labels)), blogRoutes, out);
            }
            expect(yield* generationOf(out)).not.toBe(loadedFrom);
            const answer = yield* handler(request("/blog/first"));
            const body = yield* textOfResponse(answer);
            expect(body).toContain("body of first");
            expect(answer.headers.get("etag")).toBe(yield* etagOfText(body));
            // A hit from the file it loaded, not a render through the router.
            expect(routed).toEqual([]);
            expect(yield* namesIn(`${out}/generations`)).toContain(nameOf(loadedFrom));
          }),
        );
        // Released: the next build removes it, and keeps only what it published.
        yield* buildInto(yield* sideOf(makeControl(changedLabels)), blogRoutes, out);
        expect(yield* namesIn(`${out}/generations`)).toEqual([nameOf(yield* generationOf(out))]);
        expect(yield* namesIn(`${out}/leases`)).toEqual([]);
      }),
    15_000,
  );

  platform(
    "a build that cannot read the leases keeps every generation: clean-up waits for the next build",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* tempDirectory;
        const out = `${directory}/out`;
        const server = yield* sideOf(makeControl(blogLabels));
        yield* buildInto(server, blogRoutes, out);
        const loadedFrom = yield* generationOf(out);
        const routed: Array<string> = [];
        const handler = yield* Prerender.serve(
          yield* Prerender.load(out),
          routerFallback(server, blogRoutes, routed),
        );
        // The leases cannot be read: "no leases" is not what that means.
        const unreadable = yield* Effect.exit(
          buildInto(yield* sideOf(makeControl(changedLabels)), blogRoutes, out).pipe(
            Effect.provideService(
              FileSystem.FileSystem,
              faulty(fs, { readDirectory: (path) => path.endsWith("/leases") }),
            ),
          ),
        );
        // The build published: clean-up is best effort, and it was skipped.
        expect(Exit.isSuccess(unreadable)).toBe(true);
        expect(yield* generationOf(out)).not.toBe(loadedFrom);
        expect(yield* namesIn(`${out}/generations`)).toContain(nameOf(loadedFrom));
        const answer = yield* handler(request("/blog/first"));
        expect(yield* textOfResponse(answer)).toContain("body of first");
        expect(routed).toEqual([]);
      }),
    15_000,
  );

  platform("a matching If-None-Match for a file that is gone renders through the router", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* tempDirectory;
      const out = `${directory}/out`;
      const server = yield* sideOf(makeControl(blogLabels));
      const manifest = yield* buildInto(server, blogRoutes, out);
      const site = yield* Prerender.load(out);
      const etag = Option.getOrThrow(
        Option.fromNullishOr(manifest.pages.find((page) => page.href === "/blog/first")),
      ).etag;
      yield* fs.remove(`${yield* generationOf(out)}/blog/first/index.html`);
      const routed: Array<string> = [];
      const handler = yield* Prerender.serve(site, routerFallback(server, blogRoutes, routed));
      const answer = yield* handler(request("/blog/first", { headers: { "if-none-match": etag } }));
      expect(answer.status).toBe(200);
      expect(routed).toEqual(["/blog/first"]);
      expect(yield* textOfResponse(answer)).toContain("body of first");
    }),
  );

  platform("HEAD answers with the GET's status and headers, and no body", () =>
    Effect.gen(function* () {
      const directory = yield* tempDirectory;
      const out = `${directory}/out`;
      const server = yield* sideOf(makeControl(blogLabels));
      yield* buildInto(server, blogRoutes, out);
      const routed: Array<string> = [];
      const handler = yield* Prerender.serve(
        yield* Prerender.load(out),
        routerFallback(server, blogRoutes, routed),
      );
      for (const path of ["/blog/first", "/client.js"]) {
        const get = yield* handler(request(path));
        const head = yield* handler(request(path, { method: "HEAD" }));
        expect(head.status).toBe(get.status);
        expect(Array.from(head.headers.entries())).toEqual(Array.from(get.headers.entries()));
        expect((yield* textOfResponse(get)).length).toBeGreaterThan(0);
        expect(yield* textOfResponse(head)).toBe("");
      }
      expect(routed).toEqual([]);
    }),
  );
});

// ---------------------------------------------------------------------------
// Pages the build refuses to write
// ---------------------------------------------------------------------------

const tagSegment = Route.segment("tag", {
  path: "/tags/:tag",
  params: Schema.Struct({ tag: Schema.String }),
});

const tagsOf = (tags: ReadonlyArray<string>, links: ReadonlyArray<string> = []) =>
  Route.prerender(
    "tags",
    Route.leaf(tagSegment, () =>
      Effect.succeed(
        <nav>
          {links.map((link) => (
            <a href={link}>{link}</a>
          ))}
        </nav>,
      ),
    ),
    { inputs: [Route.inputs(tagSegment, Effect.succeed(tags.map((tag) => ({ tag }))))] },
  );

const appRoute = Route.ssr("app", {
  path: "/app/:id",
  params: Schema.Struct({ id: Schema.String }),
  search: Route.search(Schema.Struct({})),
  view: () => Effect.succeed(<p>app</p>),
});

describe("pages a build refuses (#86)", () => {
  platform("two hrefs that differ only in case fail with PrerenderPathCollision", () =>
    Effect.gen(function* () {
      const directory = yield* tempDirectory;
      const refused = yield* Effect.flip(
        buildInto(yield* sideOf(makeControl({})), [tagsOf(["A", "a"])], `${directory}/out`),
      );
      expect(refused).toEqual(
        Prerender.PrerenderPathCollision.make({ first: "/tags/a", second: "/tags/A" }),
      );
    }),
  );

  platform("a page whose href has a search part fails with PrerenderSearchRejected", () =>
    Effect.gen(function* () {
      const always = Route.SearchRecord.pipe(
        Schema.decodeTo(Schema.Struct({ q: Schema.String }), {
          decode: SchemaGetter.transform(() => ({ q: "x" })),
          encode: SchemaGetter.transform((value) => ({ q: [value.q] })),
        }),
      );
      const searched = Route.prerender("searched", {
        path: "/searched",
        params: Schema.Struct({}),
        search: always,
        searchKeys: ["q"],
        view: () => Effect.succeed(<p>searched</p>),
        inputs: Effect.succeed([{}]),
      });
      const directory = yield* tempDirectory;
      const refused = yield* Effect.flip(
        buildInto(yield* sideOf(makeControl({})), [searched], `${directory}/out`),
      );
      expect(refused).toEqual(
        Prerender.PrerenderSearchRejected.make({ route: "searched", href: "/searched?q=x" }),
      );
    }),
  );

  platform(
    "a link a prerender route matches but no input listed fails with PrerenderBrokenLink",
    () =>
      Effect.gen(function* () {
        const directory = yield* tempDirectory;
        const server = yield* sideOf(makeControl({}));
        // Links to a built page, to a route that renders per request, and to no route at all pass.
        const whole = tagsOf(["a", "b"], ["/tags/b", "/app/1", "/favicon.ico"]);
        const built = yield* buildInto(server, [whole, appRoute], `${directory}/whole`);
        expect(built.pages.map((page) => page.href)).toEqual(["/tags/a", "/tags/b"]);

        const broken = tagsOf(["a"], ["/tags/b"]);
        const refused = yield* Effect.flip(
          buildInto(server, [broken, appRoute], `${directory}/broken`),
        );
        expect(refused).toEqual(
          Prerender.PrerenderBrokenLink.make({
            route: "tags",
            href: "/tags/a",
            link: "/tags/b",
            target: "tags",
          }),
        );
      }),
  );

  platform(
    "one limit covers a page from its document on: a document that never answers times out",
    () =>
      Effect.gen(function* () {
        const directory = yield* tempDirectory;
        const refused = yield* Effect.flip(
          Prerender.build({
            routes: [tagsOf(["a"])],
            notFound: NotFound,
            document: () => Effect.never,
            client: Effect.succeed(""),
            out: `${directory}/out`,
            timeLimit: "100 millis",
          }).pipe(Effect.provideContext(yield* sideOf(makeControl({})))),
        );
        expect(refused).toEqual(
          Prerender.PrerenderTimedOut.make({ route: "tags", href: "/tags/a", phase: "document" }),
        );
      }),
  );
});

// ---------------------------------------------------------------------------
// One instant of the store
// ---------------------------------------------------------------------------

const keyOf = (id: string): QueryKey => ({
  query: "Batched",
  version: 1,
  args: JSON.stringify({ id }),
});

describe("the build's one-read transport (#86)", () => {
  it.scopedLive("a failed batch fails every reader of its keys at once", () =>
    Effect.gen(function* () {
      const side = yield* sideOf(makeControl({}));
      const gate = yield* Deferred.make<void>();
      const failure = QueryFailed.make({ query: "Batched", detail: "the store is down" });
      const base = Context.get(side, ActorTransport);
      const shared = Prerender.oneInstant({
        ...base,
        queryBatch: () => Effect.andThen(Deferred.await(gate), Effect.fail(failure)),
      });
      const owner = yield* Effect.forkChild(shared.queryBatch([keyOf("a")]));
      yield* Effect.yieldNow;
      // A second reader of the same key waits on the owner's read.
      const waiter = yield* Effect.forkChild(shared.queryBatch([keyOf("a")]));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(gate, void 0);
      const outcomes = yield* Effect.all([Fiber.await(owner), Fiber.await(waiter)]).pipe(
        Effect.timeoutOption("1 second"),
      );
      expect(Option.map(outcomes, (both) => both.map(Exit.isFailure))).toEqual(
        Option.some([true, true]),
      );
      expect(
        Option.map(outcomes, (both) =>
          both.map((exit) =>
            Exit.match(exit, {
              onFailure: (cause) => Cause.squash(cause) === failure,
              onSuccess: () => false,
            }),
          ),
        ),
      ).toEqual(Option.some([true, true]));
    }),
  );
});
