import type {
  Address,
  Projection,
  QueryKey,
  Refreshed,
  TransportReadError,
  TransportService,
} from "effect-frame/actor/client";
import {
  ActorTransport,
  Anonymous,
  CurrentPrincipal,
  QueryCache,
  QueryFailure,
  Streaming,
  Unauthorized,
} from "effect-frame/actor/client";
import type { View } from "effect-frame/view";
import type { Duration, Scope } from "effect";
import {
  Cause,
  Clock,
  Crypto,
  Deferred,
  Effect,
  Encoding,
  Exit,
  FileSystem,
  Option,
  Path,
  Schema,
  Stream,
} from "effect";
import type { PlatformError } from "effect/PlatformError";
import type { Document } from "../view/hosts/html.js";
import { awaitAllPage, requestCache } from "../view/hosts/html.js";
import type { AnyRoute } from "./codec.js";
import type { DocumentServices } from "./document.js";
import { agreedInTime, settleAndPrepare } from "./document.js";
import type { Page, PrerenderError, PrerenderServices } from "./prerender.js";
import { enumerate, planOf } from "./prerender.js";
import type { NotFoundProps } from "./router.js";
import { segmentsOf } from "./path.js";
import type { Output, PrerenderBuildLocked } from "./prerender-output.server.js";
import { hold, lock, manifestFile, outputOf, publish, stage } from "./prerender-output.server.js";

export { PrerenderBuildLocked } from "./prerender-output.server.js";

export type { Page } from "./prerender.js";

/**
 * The prerender build and the server that serves what it wrote (#23 §2, §5,
 * #86). A prerendered page is an SSR response computed early and written to
 * a file: every page renders through the router's server document, in
 * `AwaitAll`, as `Anonymous`, over one read of the store for the whole
 * build. The output is a published generation (`prerender-output.server.ts`).
 * See `docs/design/prerender.md`.
 *
 * Server-only: it reads and writes files and answers requests. A browser
 * entry never reaches it (`docs/design/boundary.md`).
 */

/** The module script every prerendered page loads: the app's one browser bundle. */
export const clientScript = '<script type="module" src="/client.js"></script>';

/** Where the bundle and the receipt sit in a generation. */
export const clientFile = "client.js";
export { manifestFile };

/** One written page: exactly as `href` printed it, and its file relative to the manifest. */
export const ManifestPage = Schema.Struct({
  href: Schema.String,
  route: Schema.String,
  file: Schema.String,
  /** A strong validator: the hash of the file's bytes. */
  etag: Schema.String,
});
export type ManifestPage = Schema.Schema.Type<typeof ManifestPage>;

/** The build's receipt. The server reads it at start; no manifest, no prerendered pages. */
export const Manifest = Schema.Struct({
  /** One value for the whole build, in milliseconds since the epoch. */
  builtAt: Schema.Finite,
  client: Schema.String,
  pages: Schema.Array(ManifestPage),
});
export type Manifest = Schema.Schema.Type<typeof Manifest>;

const ManifestJson = Schema.fromJsonString(Manifest);
const encodeManifest = Schema.encodeEffect(ManifestJson);
const decodeManifest = Schema.decodeUnknownEffect(ManifestJson);

// ---------------------------------------------------------------------------
// Failures: a page that is not the page its route promises fails the build
// ---------------------------------------------------------------------------

/**
 * A query or an actor the page reads refused `Anonymous` (#23 §2.3). A
 * prerendered page is one file served to everyone, so the build fails and
 * writes no file. `contract` names the contract, which names its policy;
 * `read` says whether the page read it as a query or as an actor.
 */
export class PrerenderUnauthorized extends Schema.TaggedError<PrerenderUnauthorized>()(
  "PrerenderUnauthorized",
  {
    route: Schema.String,
    href: Schema.String,
    read: Schema.Literals(["query", "actor"]),
    contract: Schema.String,
  },
) {
  override get message(): string {
    return `route "${this.route}" page ${this.href} reached ${this.read} "${this.contract}", whose policy refuses Anonymous. A prerendered page renders as Anonymous. Make the policy admit Anonymous, or mount "${this.route}" with another mode.`;
  }
}

/** A query the page reads failed. A page whose content is an error is not written. */
export class PrerenderQueryFailed extends Schema.TaggedError<PrerenderQueryFailed>()(
  "PrerenderQueryFailed",
  {
    route: Schema.String,
    href: Schema.String,
    query: Schema.String,
    error: QueryFailure,
  },
) {}

/** A check redirected the page's URL: a file cannot answer with a redirect. */
export class PrerenderRedirected extends Schema.TaggedError<PrerenderRedirected>()(
  "PrerenderRedirected",
  {
    route: Schema.String,
    href: Schema.String,
    location: Schema.String,
  },
) {}

/**
 * The page's URL rendered another route, or not-found: a route listed
 * earlier matches it. `rendered` names what it rendered.
 */
export class PrerenderNotMatched extends Schema.TaggedError<PrerenderNotMatched>()(
  "PrerenderNotMatched",
  {
    route: Schema.String,
    href: Schema.String,
    rendered: Schema.String,
  },
) {}

/**
 * The page did not finish before the time limit: its document, a check, a
 * declaration, or a read was still open. One limit covers the whole page,
 * from `document(page)` on. A page with a fallback in it is not written.
 */
export class PrerenderTimedOut extends Schema.TaggedError<PrerenderTimedOut>()(
  "PrerenderTimedOut",
  {
    route: Schema.String,
    href: Schema.String,
    /** `document`: the page's `document(page)` had not answered. */
    phase: Schema.Literals(["document", "settle", "draw", "agree", "settled"]),
  },
) {}

/** The manifest on disk does not decode. */
export class PrerenderManifestInvalid extends Schema.TaggedError<PrerenderManifestInvalid>()(
  "PrerenderManifestInvalid",
  { path: Schema.String },
) {}

/**
 * A page's `href` has a search part. A file answers a pathname, and the
 * server looks up the pathname only, so such a page could never be served.
 */
export class PrerenderSearchRejected extends Schema.TaggedError<PrerenderSearchRejected>()(
  "PrerenderSearchRejected",
  { route: Schema.String, href: Schema.String },
) {
  override get message(): string {
    return `route "${this.route}" printed ${this.href}, which has a search part. A prerendered page is a pathname: give the route a search codec that prints nothing for its empty value.`;
  }
}

/**
 * Two pages would be one file on a file system that folds case or Unicode
 * form, as macOS and Windows do. Paths are compared in NFC, lower-cased.
 */
export class PrerenderPathCollision extends Schema.TaggedError<PrerenderPathCollision>()(
  "PrerenderPathCollision",
  { first: Schema.String, second: Schema.String },
) {
  override get message(): string {
    return `${this.first} and ${this.second} would write the same file where names fold case. Give them hrefs that differ by more than case.`;
  }
}

/**
 * A page links to a URL that a prerender route matches, but that URL was
 * not built: the link would answer through the router, or not at all.
 */
export class PrerenderBrokenLink extends Schema.TaggedError<PrerenderBrokenLink>()(
  "PrerenderBrokenLink",
  { route: Schema.String, href: Schema.String, link: Schema.String, target: Schema.String },
) {
  override get message(): string {
    return `page ${this.href} links to ${this.link}, which route "${this.target}" matches, but its inputs did not list it.`;
  }
}

export type PrerenderFailure =
  | PrerenderBuildLocked
  | PrerenderSearchRejected
  | PrerenderPathCollision
  | PrerenderBrokenLink
  | PrerenderUnauthorized
  | PrerenderQueryFailed
  | PrerenderRedirected
  | PrerenderNotMatched
  | PrerenderTimedOut;

// ---------------------------------------------------------------------------
// The build (#23 §2)
// ---------------------------------------------------------------------------

/** The document around one page. The build writes `clientScript` as its bootstrap. */
export type PageDocument = Omit<Document, "bootstrap">;

export interface BuildOptions<Routes extends AnyRoute<unknown>, N, DE, DR, CE, CR> {
  /** Every route, in the order the server mounts them. The prerender ones are built. */
  readonly routes: ReadonlyArray<Routes>;
  readonly notFound: View.View<NotFoundProps, never, N>;
  /** The document around one page. It runs in the build, once per page. */
  readonly document: (page: Page) => Effect.Effect<PageDocument, DE, DR>;
  /** The app's browser bundle, written once as `client.js` and loaded by every page. */
  readonly client: Effect.Effect<string, CE, CR>;
  /**
   * The output directory, for example `dist/prerender`. A build publishes a
   * new generation in it with one pointer change; see `load`.
   */
  readonly out: string;
  /**
   * How long one page may take, from `document(page)` to its last read. A
   * page past it fails the build.
   */
  readonly timeLimit: Duration.Input;
  /** How many pages render at once. Default 8: a build must not take a whole pool. */
  readonly concurrency?: number;
}

type RouteServices<Route> = Route extends AnyRoute<infer R> ? R : never;

/** The routes as the router holds them: each one's services, as one union. */
const servicesOf = <Routes extends AnyRoute<unknown>>(
  routes: ReadonlyArray<Routes>,
): ReadonlyArray<AnyRoute<RouteServices<Routes>>> =>
  // oxlint-disable-next-line effect/noAs, typescript/no-unsafe-type-assertion -- AnyRoute is covariant in R, so each route is an AnyRoute of the union of every route's services.
  routes as ReadonlyArray<AnyRoute<RouteServices<Routes>>>;

/** What a build needs: the routes' and inputs' services, a transport, and the platform. */
export type BuildServices<Routes, N, DR, CR> =
  | DocumentServices<RouteServices<Routes>>
  | DocumentServices<N>
  | Exclude<Exclude<Exclude<PrerenderServices<Routes>, QueryCache>, ActorTransport>, Scope.Scope>
  | Exclude<DR | CR, Scope.Scope>
  | ActorTransport
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto;

/** What a build fails with: its own refusals, the inputs', the document's, the bundle's, and the disk's. */
export type BuildError<Routes, DE, CE> =
  | PrerenderFailure
  | PrerenderError<Routes>
  | DE
  | CE
  | PlatformError;

const origin = "http://prerender.invalid";

const settledPhase = "settled";

/** The route a page rendered, as a failure names it. */
const renderedName = <R>(
  route: { readonly _tag: "Matched"; readonly route: AnyRoute<R> } | { readonly _tag: "NotFound" },
): string => {
  if (route._tag === "NotFound") {
    return "not-found";
  }
  return route.route.name;
};

const isUnauthorized = Schema.is(Unauthorized);

/** The first failure a baked seed holds. A page with a failed query is not written. */
const seedFailure = (
  page: Page,
  seed: ReadonlyArray<Streaming.Patch>,
): Option.Option<PrerenderUnauthorized | PrerenderQueryFailed> => {
  for (const patch of seed) {
    if (patch.outcome._tag === "Error") {
      const error = patch.outcome.error;
      if (error._tag === "Unauthorized") {
        return Option.some(
          PrerenderUnauthorized.make({
            route: page.route,
            href: page.href,
            read: "query",
            contract: error.contract,
          }),
        );
      }
      return Option.some(
        PrerenderQueryFailed.make({ route: page.route, href: page.href, query: patch.id, error }),
      );
    }
  }
  return Option.none();
};

/** Case and Unicode form folded, as a case-insensitive file system compares names. */
const folded = (file: string): string => file.normalize("NFC").toLowerCase();

/** The local link targets an HTML document holds: `<a href="/...">`, as pathnames. */
const localLinks = (html: string): ReadonlyArray<string> =>
  Array.from(html.matchAll(/<a\b[^>]*?\shref="(\/(?!\/)[^"]*)"/g), (match) =>
    Option.getOrElse(Option.fromNullishOr(match[1]), () => "/").replaceAll("&amp;", "&"),
  ).map((href) => new URL(href, origin).pathname);

/**
 * Build every prerender route among `routes` into a new generation of
 * `out`, and publish it. It enumerates each route's inputs, renders each
 * page through the router's server document at the URL `href` printed,
 * writes `<href>/index.html`, `client.js`, and `manifest.json`, then moves
 * the pointer. A build that fails at any step before that leaves the
 * previous generation published; one build writes `out` at a time.
 *
 * Everything runs as `Anonymous`, whatever the caller provides, over one
 * read of the store: a query key or an actor snapshot that two pages, or a
 * page and an inputs Effect, read is read once, and an actor does not move
 * while the build runs. Two inputs that print the same href are one page.
 */
export const build = <Routes extends AnyRoute<unknown>, N, DE, DR, CE, CR>(
  options: BuildOptions<Routes, N, DE, DR, CE, CR>,
): Effect.Effect<Manifest, BuildError<Routes, DE, CE>, BuildServices<Routes, N, DR, CR>> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const output = outputOf(path, options.out);
    yield* lock(fs, output);
    const builtAt = yield* Clock.currentTimeMillis;
    const routes = servicesOf(options.routes);
    const concurrency = Option.getOrElse(Option.fromNullishOr(options.concurrency), () => 8);
    const shared = oneInstant(yield* ActorTransport);
    const withShared = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.provideService(effect, ActorTransport, shared);
    const cache = yield* withShared(requestCache);

    // Enumerate first, over the build's own cache: its reads go through the
    // shared transport too.
    const targets = routes.flatMap((route) =>
      Option.toArray(Option.map(planOf(route), (plan) => ({ route, plan }))),
    );
    const found = yield* Effect.forEach(targets, (target) =>
      Effect.map(
        enumerate<PrerenderError<Routes>, PrerenderServices<Routes>>(target.plan),
        (pages) => pages.map((page) => ({ route: target.route, page })),
      ),
    ).pipe(Effect.provideService(QueryCache, cache), withShared);
    // Duplicates collapse: the first input that printed an href is its page.
    const byHref = new Map<string, (typeof found)[number][number]>();
    for (const one of found.flat()) {
      if (!byHref.has(one.page.href)) {
        byHref.set(one.page.href, one);
      }
    }
    const pages = Array.from(byHref.values()).toSorted((a, b) =>
      a.page.href.localeCompare(b.page.href),
    );
    // Every page must be a file the server can find, and its own file.
    const byFile = new Map<string, string>();
    for (const { page } of pages) {
      if (page.href.includes("?")) {
        return yield* PrerenderSearchRejected.make({ route: page.route, href: page.href });
      }
      const key = folded(fileOf(path, page.href));
      const first = Option.fromNullishOr(byFile.get(key));
      if (Option.isSome(first)) {
        return yield* PrerenderPathCollision.make({ first: first.value, second: page.href });
      }
      byFile.set(key, page.href);
    }

    const staging = yield* stage(fs, output, builtAt);
    const brokenLink = (page: Page, html: string): Option.Option<PrerenderBrokenLink> => {
      for (const link of localLinks(html)) {
        if (!byHref.has(link)) {
          const url = new URL(link, origin);
          // The route the server would answer this link with, if it is a prerender one.
          const target = Option.filter(
            Option.fromNullishOr(routes.find((candidate) => Option.isSome(candidate.enter(url)))),
            (matched) => Option.isSome(planOf(matched)),
          );
          if (Option.isSome(target)) {
            return Option.some(
              PrerenderBrokenLink.make({
                route: page.route,
                href: page.href,
                link,
                target: target.value.name,
              }),
            );
          }
        }
      }
      return Option.none();
    };

    const renderOne = (one: (typeof pages)[number]) =>
      Effect.scoped(
        Effect.gen(function* () {
          const { page, route } = one;
          // One limit for the whole page, started before its document.
          const expired = yield* Deferred.make<void>();
          yield* Effect.forkScoped(
            Effect.andThen(Effect.sleep(options.timeLimit), Deferred.succeed(expired, void 0)),
          );
          const timedOut = (phase: PrerenderTimedOut["phase"]) =>
            PrerenderTimedOut.make({ route: page.route, href: page.href, phase });
          const around = yield* Effect.raceFirst(
            options.document(page),
            Effect.andThen(Deferred.await(expired), Effect.fail(timedOut("document"))),
          );
          const document: Document = { ...around, bootstrap: clientScript };
          const outcome = yield* settleAndPrepare(
            {
              routes,
              notFound: options.notFound,
              url: new URL(page.href, origin),
              document,
              closeWhen: Deferred.await(expired),
            },
            requestCache,
            (_mode, pipelines) =>
              agreedInTime(
                awaitAllPage(
                  pipelines.routed,
                  document,
                  { closeWhen: pipelines.closeWhen },
                  pipelines.shared,
                  Option.some(builtAt),
                ),
              ),
          ).pipe(
            Effect.catchTag("DocumentTimedOut", (failed) => Effect.fail(timedOut(failed.phase))),
          );
          if (outcome._tag === "Redirect") {
            return yield* PrerenderRedirected.make({
              route: page.route,
              href: page.href,
              location: outcome.location.href,
            });
          }
          if (outcome.route._tag !== "Matched" || outcome.route.route !== route) {
            return yield* PrerenderNotMatched.make({
              route: page.route,
              href: page.href,
              rendered: renderedName(outcome.route),
            });
          }
          const failure = seedFailure(page, outcome.body.seed);
          if (Option.isSome(failure)) {
            return yield* failure.value;
          }
          if (!outcome.body.complete) {
            return yield* timedOut(settledPhase);
          }
          const broken = brokenLink(page, outcome.body.html);
          if (Option.isSome(broken)) {
            return yield* broken.value;
          }
          const file = fileOf(path, page.href);
          const target = path.join(staging, file);
          yield* fs.makeDirectory(path.dirname(target), { recursive: true });
          yield* fs.writeFileString(target, outcome.body.html);
          const etag = yield* etagOf(crypto, yield* fs.readFile(target));
          const written: ManifestPage = { href: page.href, route: page.route, file, etag };
          return written;
        }),
      ).pipe(
        // An actor snapshot that refuses `Anonymous` does not reach the
        // seed: the router fails the mount with the transport's
        // `Unauthorized` as a defect. The build names it like a query's.
        Effect.catchDefect((defect) =>
          Option.match(Option.liftPredicate(defect, isUnauthorized), {
            onNone: () => Effect.die(defect),
            onSome: (refused) =>
              Effect.fail(
                PrerenderUnauthorized.make({
                  route: one.page.route,
                  href: one.page.href,
                  read: "actor",
                  contract: refused.contract,
                }),
              ),
          }),
        ),
        withShared,
      );

    const written = yield* Effect.forEach(pages, renderOne, { concurrency });
    yield* fs.writeFileString(path.join(staging, clientFile), yield* options.client);
    const manifest: Manifest = { builtAt, client: clientFile, pages: written };
    // The receipt is written last, from the list just rendered.
    yield* fs.writeFileString(
      path.join(staging, manifestFile),
      yield* Effect.orDie(encodeManifest(manifest)),
    );
    yield* publish(fs, path, output, staging);
    return manifest;
  }).pipe(
    Effect.scoped,
    // A prerendered page is served to everyone: it renders as the one
    // principal every requester is entitled to be, and no option changes it.
    Effect.provideService(CurrentPrincipal, Anonymous.make({})),
  );

/**
 * `href` percent-encodes each segment once, so a segment is one directory,
 * spelled exactly as the URL spells it (#23 §2.4).
 */
const fileOf = (path: Path.Path, href: string): string =>
  path.join(...segmentsOf(href), "index.html");

/**
 * Complete a Deferred another reader may wait on before it is forgotten, so
 * every reader gets the failure, or the interruption, the owner got.
 */
const settleAll = <A, E>(
  owned: ReadonlyArray<{ readonly id: string; readonly made: Deferred.Deferred<A, E> }>,
  table: Map<string, Deferred.Deferred<A, E>>,
  cause: Cause.Cause<E>,
) =>
  Effect.forEach(
    owned,
    (one) =>
      Effect.andThen(
        Deferred.failCause(one.made, cause),
        Effect.sync(() => table.delete(one.id)),
      ),
    { discard: true },
  );

/**
 * One read, whoever asks first: later asks for `id` wait for it. A failed
 * or interrupted read completes every waiter with its failure.
 */
const once = <A, E>(
  table: Map<string, Deferred.Deferred<A, E>>,
  id: string,
  read: Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.suspend(() =>
    Option.match(Option.fromNullishOr(table.get(id)), {
      onSome: Deferred.await,
      onNone: () => {
        const made = Deferred.makeUnsafe<A, E>();
        table.set(id, made);
        return Effect.flatMap(Effect.exit(read), (exit) =>
          Effect.andThen(Deferred.done(made, exit), exit),
        ).pipe(
          Effect.onInterrupt(() =>
            Effect.andThen(
              Deferred.interrupt(made),
              Effect.sync(() => table.delete(id)),
            ),
          ),
        );
      },
    }),
  );

const addressId = (address: Address): string =>
  `${address.contract}@${String(address.version)}/${address.key}`;

/**
 * The build's transport: one instant of one store, read as one principal.
 * Each query key and each actor snapshot is read once, whoever asks first,
 * and every later ask gets the same answer, so a page's resume script and
 * its view see one revision. An actor does not move while the build runs:
 * its change stream is empty until the page closes it. Commands pass
 * through.
 */
export const oneInstant = (transport: TransportService): TransportService => {
  const reads = new Map<string, Deferred.Deferred<string, QueryFailure>>();
  const batched = new Map<string, Deferred.Deferred<Refreshed, QueryFailure>>();
  const snapshots = new Map<string, Deferred.Deferred<Projection, TransportReadError>>();
  const batchOnce = (keys: ReadonlyArray<QueryKey>) =>
    Effect.suspend(() => {
      const missing = keys.filter((key) => !batched.has(Streaming.recordId(key)));
      const mine = missing.map((key) => {
        const made = Deferred.makeUnsafe<Refreshed, QueryFailure>();
        batched.set(Streaming.recordId(key), made);
        return { id: Streaming.recordId(key), made };
      });
      const fill: Effect.Effect<void, QueryFailure> = Effect.flatMap(
        Effect.exit(transport.queryBatch(missing)),
        (exit) =>
          Exit.match(exit, {
            // Every key this batch owned fails as it failed, for every waiter.
            onFailure: (cause) =>
              Effect.andThen(settleAll(mine, batched, cause), Effect.failCause(cause)),
            onSuccess: (results) =>
              Effect.forEach(
                mine,
                (one) =>
                  Option.match(
                    Option.fromNullishOr(
                      results.find((result) => Streaming.recordId(result.key) === one.id),
                    ),
                    {
                      onNone: () =>
                        Deferred.die(one.made, `the batch answered no result for ${one.id}`),
                      onSome: (result) => Deferred.succeed(one.made, result),
                    },
                  ),
                { discard: true },
              ),
          }),
      ).pipe(Effect.onInterrupt(() => settleAll(mine, batched, Cause.interrupt())));
      const filled = Effect.when(
        fill,
        Effect.sync(() => mine.length > 0),
      ).pipe(Effect.asVoid);
      return Effect.andThen(
        filled,
        Effect.forEach(keys, (key) =>
          Option.match(Option.fromNullishOr(batched.get(Streaming.recordId(key))), {
            onNone: () => Effect.die(`no read for ${Streaming.recordId(key)}`),
            onSome: Deferred.await,
          }),
        ),
      );
    });
  return {
    ...transport,
    query: (key) => once(reads, Streaming.recordId(key), transport.query(key)),
    queryBatch: batchOnce,
    snapshot: (address) => once(snapshots, addressId(address), transport.snapshot(address)),
    changes: () => Stream.never,
  };
};

/** A strong validator: the SHA-256 of the file's bytes, base64url. */
const etagOf = (crypto: Crypto.Crypto, bytes: Uint8Array) =>
  Effect.map(crypto.digest("SHA-256", bytes), (digest) => `"${Encoding.encodeBase64Url(digest)}"`);

// ---------------------------------------------------------------------------
// Serving (#23 §5): before the router, as a manifest lookup
// ---------------------------------------------------------------------------

/** One prerendered page as the server holds it. */
export interface SitePage {
  readonly href: string;
  readonly route: string;
  /** The file's absolute path, inside the loaded generation. */
  readonly file: string;
  readonly etag: string;
}

/**
 * What `load` read: one generation. A generation is never written again, so
 * each page's bytes and its `etag` agree for as long as the file is there.
 * No generation: no pages, and every request renders.
 */
export interface Site {
  /** The generation's absolute path. */
  readonly generation: Option.Option<string>;
  readonly pages: ReadonlyMap<string, SitePage>;
  /** The bundle's absolute path, when the manifest names one. */
  readonly client: Option.Option<string>;
}

const emptySite: Site = { generation: Option.none(), pages: new Map(), client: Option.none() };

/**
 * Read the published generation of an output directory: the one its pointer
 * names, or, when the pointer is missing or names nothing whole, the newest
 * complete generation. An output with none serves nothing.
 *
 * The generation is held for the calling scope: a build removes no
 * generation a loaded site holds, so the site's files stay for as long as
 * the scope is open, however many builds publish meanwhile. Load in the
 * scope the server lives in; when it closes, the next build removes the
 * generation.
 */
export const load = Effect.fn("Prerender.load")(function* (out: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const output: Output = outputOf(path, out);
  const found = yield* hold(output);
  if (Option.isNone(found)) {
    return emptySite;
  }
  const directory = found.value;
  const manifestPath = path.join(directory, manifestFile);
  const manifest = yield* Effect.mapError(
    Effect.flatMap(fs.readFileString(manifestPath), decodeManifest),
    () => PrerenderManifestInvalid.make({ path: manifestPath }),
  );
  const site: Site = {
    generation: Option.some(directory),
    pages: new Map(
      manifest.pages.map((page) => [
        page.href,
        {
          href: page.href,
          route: page.route,
          file: path.join(directory, page.file),
          etag: page.etag,
        },
      ]),
    ),
    client: Option.some(path.join(directory, manifest.client)),
  };
  return site;
});

/** The page a raw request pathname names, if it was built. A map lookup, nothing else. */
export const lookup = (site: Site, pathname: string): Option.Option<SitePage> =>
  Option.fromNullishOr(site.pages.get(pathname));

/** A web-standard handler: `Request` in, `Response` out. */
export type WebHandler = (request: Request) => Effect.Effect<Response>;

/** Whether `If-None-Match` names this validator, weakly compared as HTTP says. */
const notModified = (request: Request, etag: string): boolean =>
  Option.match(Option.fromNullishOr(request.headers.get("if-none-match")), {
    onNone: () => false,
    onSome: (header) =>
      header
        .split(",")
        .map((tag) => tag.trim().replace(/^W\//, ""))
        .some((tag) => tag === "*" || tag === etag),
  });

const pageHeaders = (etag: string) => ({
  "content-type": "text/html; charset=utf-8",
  // The URL is not content-addressed: every request revalidates (#23 §5.2).
  "cache-control": "public, max-age=0, must-revalidate",
  etag,
});

/** A GET answers with the body; a HEAD with the same status and headers, and none. */
const answer = (request: Request, body: string, init: ResponseInit): Response => {
  if (request.method === "HEAD") {
    // oxlint-disable-next-line effect/noNullish -- a HEAD response has no body, and null is how the Response constructor says so.
    return new Response(null, init);
  }
  return new Response(body, init);
};

/**
 * Serve a loaded generation before the router. A built page is read from
 * its file first; only then is `If-None-Match` compared with its `ETag`,
 * and a match answers 304. A page whose file is gone, and anything else,
 * goes to `fallback`, which renders through the router: a miss is a slower
 * answer, never a different one. A HEAD answers as its GET would, with no
 * body.
 */
export const serve = Effect.fn("Prerender.serve")(function* (site: Site, fallback: WebHandler) {
  const fs = yield* FileSystem.FileSystem;
  const handler: WebHandler = (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return fallback(request);
    }
    const pathname = new URL(request.url).pathname;
    if (pathname === `/${clientFile}` && Option.isSome(site.client)) {
      return fs.readFileString(site.client.value).pipe(
        Effect.map((text) =>
          answer(request, text, {
            headers: { "content-type": "text/javascript; charset=utf-8" },
          }),
        ),
        Effect.catch(() => fallback(request)),
      );
    }
    return Option.match(lookup(site, pathname), {
      onNone: () => fallback(request),
      onSome: (page) =>
        fs.readFileString(page.file).pipe(
          Effect.map((html) => {
            if (notModified(request, page.etag)) {
              // oxlint-disable-next-line effect/noNullish -- a 304 has no body, and the Response constructor refuses any body but null for it.
              return new Response(null, { status: 304, headers: pageHeaders(page.etag) });
            }
            return answer(request, html, { headers: pageHeaders(page.etag) });
          }),
          // The file is gone: the page renders per request instead (#23 §4).
          Effect.catch(() => fallback(request)),
        ),
    });
  };
  return handler;
});
