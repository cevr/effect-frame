import { platformFetch } from "./dom-setup.js";

import type { QueryKey, TransportService } from "effect-frame/actor/client";
import { ActorTransport, CommandId, ref, QueryCache } from "effect-frame/actor/client";
import { Location } from "effect-frame/router";
import type { LocationService } from "effect-frame/router";
import * as Prerender from "effect-frame/router/prerender";
import {
  Clock,
  Context,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
  Stream,
} from "effect";
import { hydrateApp } from "../src/app.js";
import type { Slug } from "../src/contract.js";
import { Reactions } from "../src/contract.js";
import type { SiteRoute } from "../src/prerender.server.js";
import { buildSite } from "../src/prerender.server.js";
import type { PostSourceService } from "../src/posts.server.js";
import { PostSource, fromDirectory } from "../src/posts.server.js";
import { siteOver } from "../src/reactions.server.js";
import { routes } from "../src/routes.js";
import { makeRuntime, makeServer } from "../src/server.js";

/**
 * What the Blog tests share. A site is the real host over Markdown files
 * in a temporary directory: the posts, the build, the server, and the
 * client all run the app's own code. A test counts reads by wrapping the
 * post source or the client's transport; nothing else is replaced.
 */

export const origin = "http://blog.test";

/** One post file as the tests write it. */
export interface PostFile {
  readonly slug: string;
  readonly title: string;
  readonly date: string;
  readonly draft?: boolean;
  readonly body: string;
}

/** The posts every test starts from: three published, one draft. */
export const fixturePosts: ReadonlyArray<PostFile> = [
  {
    slug: "first-light",
    title: "First light",
    date: "2026-09-01",
    body: "# Dawn\n\nThe first post.",
  },
  { slug: "second-wind", title: "Second wind", date: "2026-09-05", body: "The second post." },
  { slug: "third-time", title: "Third time", date: "2026-09-10", body: "The third post." },
  {
    slug: "next-week",
    title: "Next week",
    date: "2026-09-20",
    draft: true,
    body: "Not published.",
  },
];

export const published = fixturePosts.filter((post) => post.draft !== true);

export const markdownOf = (post: PostFile): string =>
  [
    "---",
    `title: ${post.title}`,
    `date: ${post.date}`,
    `draft: ${String(post.draft === true)}`,
    "---",
    post.body,
    "",
  ].join("\n");

/** Write one post file into `directory`. */
export const writePost = (directory: string, post: PostFile) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(path.join(directory, `${post.slug}.md`), markdownOf(post));
  }).pipe(Effect.orDie);

/** A fresh directory for one test, removed when its scope closes. */
export const tempDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "effect-frame-blog-" });
}).pipe(Effect.orDie);

/** A directory of posts and an empty place for the build's output. */
export const workspace = (posts: ReadonlyArray<PostFile> = fixturePosts) =>
  Effect.gen(function* () {
    const directory = yield* tempDirectory;
    const path = yield* Path.Path;
    const postsDirectory = path.join(directory, "posts");
    const fs = yield* FileSystem.FileSystem;
    yield* Effect.orDie(fs.makeDirectory(postsDirectory));
    yield* Effect.forEach(posts, (post) => writePost(postsDirectory, post));
    return { posts: postsDirectory, out: path.join(directory, "dist", "prerender") };
  });

/** How often the host read the posts: `all` is `PostIndex`, `one` is one post. */
export interface Reads {
  index: number;
  bodies: Array<string>;
}

export const makeReads = (): Reads => ({ index: 0, bodies: [] });

/** The directory's posts, counted. */
export const countedPosts = (directory: string, reads: Reads) =>
  Layer.effect(
    PostSource,
    Effect.gen(function* () {
      const real = yield* PostSource;
      const counted: PostSourceService = {
        all: Effect.andThen(
          Effect.sync(() => {
            reads.index += 1;
          }),
          real.all,
        ),
        one: (slug) =>
          Effect.andThen(
            Effect.sync(() => {
              reads.bodies.push(slug);
            }),
            real.one(slug),
          ),
      };
      return counted;
    }),
  ).pipe(Layer.provide(fromDirectory(directory)));

/** The app's site layer over `directory`, with its reads counted. */
export const testSite = (directory: string, reads: Reads = makeReads()) =>
  siteOver(countedPosts(directory, reads));

/** A built store: the site's services, living as long as the test. */
export const storeOf = (directory: string, reads: Reads = makeReads()) =>
  Layer.build(testSite(directory, reads));

export type Store = Effect.Success<ReturnType<typeof storeOf>>;

/** The bundle a test build writes: the real one is not needed to prove the build. */
export const stubClient = 'console.log("blog");';

/** Build `tree` into `out` over `store`. */
export const buildInto = (
  store: Store,
  out: string,
  tree: ReadonlyArray<SiteRoute> = routes,
  client: Effect.Effect<string> = Effect.succeed(stubClient),
) => buildSite({ out, routes: tree, client }).pipe(Effect.provideContext(store));

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

export const withClockAt =
  (at: number) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(fixedAt(at), (clock) => Effect.provideService(effect, Clock.Clock, clock));

/** The generation `out` publishes. Its lease is released at once. */
export const generationOf = (out: string) =>
  Effect.scoped(
    Effect.flatMap(Effect.orDie(Prerender.load(out)), (site) =>
      Option.match(site.generation, {
        onNone: () => Effect.die(`nothing is published in ${out}`),
        onSome: Effect.succeed,
      }),
    ),
  );

export const readText = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* Effect.orDie(fs.readFileString(file));
  });

/** Every file under `directory`, relative to it, with its text, in path order. */
export const treeOf = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* fs.exists(directory))) {
      return [];
    }
    const names = yield* fs.readDirectory(directory, { recursive: true });
    const files: Array<readonly [string, string]> = [];
    for (const name of names.toSorted()) {
      const full = path.join(directory, name);
      const info = yield* fs.stat(full);
      if (info.type === "File") {
        files.push([name, yield* fs.readFileString(full)]);
      }
    }
    return files;
  }).pipe(Effect.orDie);

/** The page the published generation holds for `href`. */
export const builtPage = (out: string, href: string) =>
  Effect.flatMap(generationOf(out), (generation) => readText(`${generation}${href}/index.html`));

/** Every `href` attribute of an `<a>` in a document. */
export const linksIn = (html: string): ReadonlyArray<string> =>
  Array.from(html.matchAll(/<a\b[^>]*?\shref="([^"]*)"/g), (match) =>
    Option.getOrElse(Option.fromNullishOr(match[1]), () => ""),
  );

/** The hidden inputs of the form `id`, in document order. */
export const hiddenOf = (html: string, id: string): ReadonlyArray<readonly [string, string]> => {
  const start = html.indexOf(`<form id="${id}"`);
  const form = html.slice(start, html.indexOf("</form>", start));
  return Array.from(
    form.matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g),
    (match): readonly [string, string] => [
      String(match[1]),
      String(match[2]).replaceAll("&amp;", "&"),
    ],
  );
};

export const hiddenValue = (html: string, form: string, name: string): string =>
  Option.getOrElse(
    Option.map(
      Option.fromNullishOr(hiddenOf(html, form).find(([field]) => field === name)),
      ([, value]) => value,
    ),
    () => "",
  );

/**
 * A document with the values one render mints masked: the heart form's
 * command id and the heart id drawn beside it. Two renders of one page
 * differ in these and nothing else (see `docs/design/blog-example.md`).
 */
export const withoutMinted = (html: string): string =>
  html
    .replace(/(name="\$command" value=")[^"]*"/g, '$1<minted>"')
    .replace(/(name="id" value=")[^"]*"/g, '$1<minted>"');

/** A document with every `builtAt` stamp removed. */
export const withoutBuiltAt = (html: string): string => html.replace(/,"builtAt":\d+/g, "");

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/**
 * Put a document into happy-dom the way a parser would leave it: the body,
 * without the module script, which the test runs by hand instead.
 */
export const install = (html: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const body = html.slice(
        html.indexOf("<body>") + "<body>".length,
        html.lastIndexOf("</body>"),
      );
      document.body.innerHTML = body.replace(Prerender.clientScript, "");
      return Option.getOrThrow(
        Option.filter(
          Option.fromNullishOr(document.getElementById("app")),
          (found): found is HTMLElement => found instanceof HTMLElement,
        ),
      );
    }),
    () => Effect.sync(() => void (document.body.innerHTML = "")),
  );

/** A Location that stays where it is put, and moves when the router moves it. */
export const locationAt = (href: string): Effect.Effect<LocationService> =>
  Effect.map(Ref.make(new URL(href, origin)), (current) => ({
    current: Ref.get(current),
    push: (url) => Ref.set(current, url),
    replace: (url) => Ref.set(current, url),
    pops: Stream.never,
  }));

/** A query read as the tests name it: `PostBody{"slug":"first-light"}`. */
export const keyText = (key: QueryKey): string => `${key.query}${key.args}`;

/**
 * The client's transport: the store's, with every query read and `changes`
 * cursor recorded, and the reads of `held` queries waiting for `release`.
 */
export const watched = (inner: TransportService, held: ReadonlyArray<string> = []) => {
  const reads: Array<string> = [];
  const afters: Array<number> = [];
  const gates = new Map(held.map((name) => [name, Deferred.makeUnsafe<void>()]));
  const pass = (key: QueryKey) =>
    Option.match(Option.fromNullishOr(gates.get(key.query)), {
      onNone: () => Effect.void,
      onSome: Deferred.await,
    });
  const transport: TransportService = {
    ...inner,
    query: (key) =>
      Effect.andThen(
        Effect.sync(() => void reads.push(keyText(key))),
        Effect.andThen(pass(key), inner.query(key)),
      ),
    queryBatch: (keys) =>
      Effect.andThen(
        Effect.forEach(keys, (key) =>
          Effect.andThen(
            Effect.sync(() => void reads.push(keyText(key))),
            pass(key),
          ),
        ),
        inner.queryBatch(keys),
      ),
    changes: (address, after) => {
      afters.push(after);
      return inner.changes(address, after);
    },
  };
  const release = (name: string) =>
    Option.match(Option.fromNullishOr(gates.get(name)), {
      onNone: () => Effect.void,
      onSome: (gate) => Effect.asVoid(Deferred.succeed(gate, void 0)),
    });
  return { transport, reads, afters, release };
};

/** A client over `transport`: its own query cache. */
export const clientOver = (transport: TransportService) =>
  Effect.map(Layer.build(QueryCache.layer), (cache) =>
    Context.add(cache, ActorTransport, transport),
  );

export type Client = Effect.Success<ReturnType<typeof clientOver>>;

/** Install `html`, and hydrate the app over it at `href`, as `client.tsx` does. */
export const hydrateAt = (client: Client, html: string, href: string) =>
  Effect.gen(function* () {
    const root = yield* install(html);
    const location = yield* locationAt(href);
    return yield* hydrateApp(root).pipe(
      Effect.provideService(Location, location),
      Effect.provideContext(client),
    );
  });

export const textOf = (selector: string): string =>
  Option.getOrElse(
    Option.flatMap(Option.fromNullishOr(document.querySelector(selector)), (node) =>
      Option.fromNullishOr(node.textContent),
    ),
    () => "",
  );

export const present = (selector: string): boolean =>
  Option.isSome(Option.fromNullishOr(document.querySelector(selector)));

/** Poll a condition with the real clock, for at most two seconds. */
export const eventually = (label: string, check: Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (yield* check) {
        return;
      }
      yield* Effect.sleep("5 millis");
    }
    return yield* Effect.die(`timed out waiting for ${label}`);
  });

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

const commandId = Schema.decodeSync(CommandId);

/** One heart on `slug`, committed before this returns. */
export const heart = (store: Context.Context<ActorTransport>, slug: Slug, id: string) =>
  Effect.gen(function* () {
    const reactions = yield* ref(Reactions, { slug });
    return yield* reactions.call(
      { _tag: "Heart", id },
      { commandId: commandId(`heart-${id}`), timeout: "2 seconds" },
    );
  }).pipe(Effect.orDie, Effect.scoped, Effect.provideContext(store));

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

export const fetchPage = (url: string, init: RequestInit = {}) =>
  Effect.gen(function* () {
    const response = yield* Effect.promise(() =>
      platformFetch(url, { redirect: "manual", ...init }),
    );
    const text = yield* Effect.promise(() => response.text());
    return { status: response.status, headers: response.headers, text };
  });

/** Ports other runs on this machine hold; a test server never takes them. */
export const reservedPorts: ReadonlyArray<number> = [3102, 3187];

/**
 * The real server over `store` on a free port, serving the prerender output
 * in `out`, stopped when the scope closes. `extra` adds services to its
 * runtime, such as a tracer.
 */
export const serverOver = (store: Store, out: string, extra: Layer.Layer<never> = Layer.empty) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const runtime = makeRuntime(Layer.merge(Layer.succeedContext(store), extra));
      const server = yield* Effect.promise(() => makeServer({ port: 0, runtime, out }));
      return { server, runtime };
    }),
    ({ server, runtime }) =>
      Effect.andThen(
        Effect.promise(() => server.stop()),
        Effect.promise(() => runtime.dispose()),
      ),
  ).pipe(Effect.map(({ server }) => server));
