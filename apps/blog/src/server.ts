import { HttpServer } from "effect-frame/actor";
import type { ActorTransport, Principal } from "effect-frame/actor/client";
import { Anonymous, CurrentPrincipal } from "effect-frame/actor/client";
import { renderDocument, respondDocument } from "effect-frame/router";
import * as Prerender from "effect-frame/router/prerender";
import type { Crypto, FileSystem, Layer, Path } from "effect";
import { Effect, Exit, ManagedRuntime, Option, Schema, Scope, Stream } from "effect";
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { Reactions } from "./contract.js";
import { blogDocument } from "./document.js";
import { bundleClient, defaultOut, defaultPosts } from "./prerender.server.js";
import { site } from "./reactions.server.js";
import { routes } from "./routes.js";
import { NotFound } from "./views.js";

/**
 * The platform boundary. Everything that touches Bun, the environment, or
 * the network lives here.
 *
 * A request is answered in this order (#23 §5):
 *   *    /actors/*     the actor transport, and the plain form post
 *   GET  a built page  its file, before the router runs, with a strong ETag
 *   GET  /client.js    the built bundle, or the one built at start
 *   GET  anything else the route tree, in the mode its tree names: a
 *                      prerender route with no file renders in AwaitAll,
 *                      the same document without `builtAt`
 */

const actorPrefix = "/actors";

/** How long a page may take to render on request. */
const pageLimit: Effect.Effect<void> = Effect.sleep("10 seconds");

/** What the server and the build run on: the host, the posts, and the platform. */
export type BlogServices = ActorTransport | FileSystem.FileSystem | Path.Path | Crypto.Crypto;

export type BlogRuntime = ManagedRuntime.ManagedRuntime<BlogServices, never>;

export const makeRuntime = (layer: Layer.Layer<BlogServices>): BlogRuntime =>
  ManagedRuntime.make(layer);

/** Render one URL through the route tree, in the caller's Scope, under the caller's principal. */
export const renderPage = Effect.fn("Blog.renderPage")(function* (url: URL, principal: Principal) {
  return yield* renderDocument({
    routes,
    notFound: NotFound,
    url,
    document: { ...blogDocument, bootstrap: Prerender.clientScript },
    closeWhen: pageLimit,
    principal,
  });
});

/** Blog has no sessions: every page is drawn for nobody in particular, and that is a written line. */
const nobody: Principal = Anonymous.make({});

/** Answer one page through the router. Its Scope lives until the body is written. */
const answerPage = respondDocument((url) => renderPage(url, nobody), {
  onTimeout: () =>
    Effect.succeed(HttpServerResponse.text("the page took too long", { status: 504 })),
});

class PageRedirected extends Schema.TaggedError<PageRedirected>()("PageRedirected", {
  location: Schema.String,
}) {}

/** The page a refused post draws again, as one string, for the principal that posted. */
const drawAgain = (path: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const principal = yield* CurrentPrincipal;
      const outcome = yield* renderPage(new URL(path, "http://blog.invalid"), principal);
      if (outcome._tag === "Redirect") {
        return yield* PageRedirected.make({ location: outcome.location.pathname });
      }
      const chunks = yield* Stream.runCollect(outcome.body);
      return Array.from(chunks).join("");
    }),
  );

/** The server could not start listening, for example on a port already taken. */
export class ServerNotStarted extends Schema.TaggedError<ServerNotStarted>()("ServerNotStarted", {
  port: Schema.Finite,
  reason: Schema.String,
}) {
  override get message(): string {
    return `the blog could not listen on port ${String(this.port)}: ${this.reason}`;
  }
}

export interface ServerOptions {
  readonly port: number;
  readonly runtime: BlogRuntime;
  /** The prerender output. Its published generation is served before the router. */
  readonly out: string;
}

export interface RunningServer {
  readonly url: string;
  readonly port: number;
  readonly stop: () => Promise<void>;
}

/**
 * Start the blog on one port over one runtime. It loads the published
 * generation of `out` once, at start, and holds it until `stop`: no
 * generation, no built pages, and every page renders on request.
 */
export const makeServer = async (options: ServerOptions): Promise<RunningServer> => {
  const runtime = options.runtime;
  // Blog has no sessions: every request is anonymous, and that is a written line.
  const actors = await runtime.runPromise(
    HttpServer.make({
      prefix: actorPrefix,
      principal: HttpServer.anonymous,
      maxBodyBytes: HttpServer.defaultMaxBodyBytes,
      form: Option.some({
        contracts: [Reactions],
        login: Option.none(),
        render: drawAgain,
        commitWithin: HttpServer.defaultCommitWithin,
      }),
    }),
  );
  const bundle = await runtime.runPromise(bundleClient);
  // The router runs in the runtime's context, captured once, so the handler needs nothing.
  const context = await runtime.runPromise(Effect.context<ActorTransport>());
  const router = Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
    if (request.url === "/client.js") {
      return Effect.succeed(
        HttpServerResponse.text(bundle, { contentType: "text/javascript; charset=utf-8" }),
      );
    }
    return Effect.provideContext(answerPage, context);
  });
  const web = HttpEffect.toWebHandlerWith<ActorTransport, HttpServerRequest.HttpServerRequest>(
    context,
  );
  const actorsWeb = web(actors);
  const fetch =
    (
      pages: Effect.Effect<
        HttpServerResponse.HttpServerResponse,
        never,
        HttpServerRequest.HttpServerRequest
      >,
    ): ((request: Request) => Response | Promise<Response>) =>
    (request) => {
      const url = new URL(request.url);
      if (url.pathname.startsWith(`${actorPrefix}/`)) {
        return actorsWeb(request);
      }
      return web(pages)(request);
    };
  // The loaded generation is held for as long as the server runs: a rebuild
  // meanwhile does not remove its files. A start that fails, such as a port
  // already taken, releases it; so does `stop`, however the stop ends.
  const held = await runtime.runPromise(Scope.make());
  const server = await runtime.runPromise(
    Effect.gen(function* () {
      const loaded = yield* Scope.provide(Effect.orDie(Prerender.load(options.out)), held);
      const pages = yield* Prerender.serve(loaded, router);
      return yield* Effect.try({
        try: () => Bun.serve({ port: options.port, fetch: fetch(pages) }),
        catch: (cause) => ServerNotStarted.make({ port: options.port, reason: String(cause) }),
      });
    }).pipe(Effect.onError(() => Scope.close(held, Exit.void))),
  );

  const bound = Option.getOrElse(Option.fromNullishOr(server.port), () => options.port);
  return {
    url: `http://127.0.0.1:${String(bound)}`,
    port: bound,
    stop: (): Promise<void> =>
      runtime.runPromise(
        Effect.promise(() => server.stop(true)).pipe(Effect.ensuring(Scope.close(held, Exit.void))),
      ),
  };
};

const main = async (): Promise<void> => {
  // oxlint-disable-next-line node/no-process-env -- the boundary reads the environment once.
  const env = process.env;
  const runtime = makeRuntime(site(env["BLOG_POSTS"] ?? defaultPosts));
  const server = await makeServer({
    port: Number(env["PORT"] ?? 3000),
    runtime,
    out: env["BLOG_OUT"] ?? defaultOut,
  });
  console.log(`blog: ${server.url}`);
};

if (import.meta.main) {
  await main();
}
