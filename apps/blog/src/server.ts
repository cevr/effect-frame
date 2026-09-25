import { HttpServer } from "effect-frame/actor";
import type { ActorTransport, Principal } from "effect-frame/actor/client";
import { Anonymous } from "effect-frame/actor/client";
import { redrawDocument, renderDocument, respondDocument } from "effect-frame/router";
import * as Prerender from "effect-frame/router/prerender";
import type { Crypto, FileSystem, Path } from "effect";
import { Config, Console, Effect, Exit, Layer, Option, Schema, Scope } from "effect";
import {
  HttpEffect,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { Reactions } from "./contract.js";
import { actorPrefix, blogDocument } from "./document.js";
import { bundleClient, defaultOut, defaultPosts } from "./prerender.server.js";
import { site } from "./reactions.server.js";
import { routes } from "./routes.js";
import { NotFound } from "./views.js";

/**
 * The platform boundary. Everything that touches Bun, the environment, or
 * the network lives here.
 *
 * A request is answered in this order (#23 §5), on one `HttpRouter`:
 *   *    /actors/*     the actor transport, and the plain form post
 *   GET  a built page  its file, before the router runs, with a strong ETag
 *   GET  /client.js    the built bundle, or the one built at start
 *   GET  anything else the route tree, in the mode its tree names: a
 *                      prerender route with no file renders in AwaitAll,
 *                      the same document without `builtAt`
 */

/** How long a page may take to render on request. */
const pageLimit: Effect.Effect<void> = Effect.sleep("10 seconds");

/** What the server and the build run on: the host, the posts, and the platform. */
export type BlogServices = ActorTransport | FileSystem.FileSystem | Path.Path | Crypto.Crypto;

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

/** The server could not start listening, for example on a port already taken. */
export class ServerNotStarted extends Schema.TaggedError<ServerNotStarted>()("ServerNotStarted", {
  port: Schema.Finite,
  reason: Schema.String,
}) {
  override get message(): string {
    return `the blog could not listen on port ${String(this.port)}: ${this.reason}`;
  }
}

export interface ServeOptions {
  readonly port: number;
  /** The prerender output. Its published generation is served before the router. */
  readonly out: string;
}

export interface RunningServer {
  readonly url: string;
  readonly port: number;
}

/**
 * Serve the blog on one port over the `BlogServices` in context, until the
 * calling Scope closes. It loads the published generation of `out` once, at
 * start, and holds it until the Scope closes: no generation, no built pages,
 * and every page renders on request.
 */
export const serve = Effect.fn("Blog.serve")(function* (options: ServeOptions) {
  const bundle = yield* bundleClient;
  // The loaded generation is held for as long as the server runs: a rebuild
  // meanwhile does not remove its files. A start that fails, such as a port
  // already taken, releases it at once, not when the caller's Scope closes.
  const held = yield* Scope.fork(yield* Effect.scope);
  const started = Effect.gen(function* () {
    const loaded = yield* Effect.orDie(Prerender.load(options.out));
    const fallback = Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
      if (request.url === "/client.js") {
        return Effect.succeed(
          HttpServerResponse.text(bundle, { contentType: "text/javascript; charset=utf-8" }),
        );
      }
      return answerPage;
    });
    const context = yield* Effect.context<BlogServices>();
    const pages = yield* Prerender.serve(loaded, Effect.provideContext(fallback, context));
    const table = Layer.mergeAll(
      // Blog has no sessions: every request is anonymous, and that is a written line.
      HttpServer.layer({
        prefix: actorPrefix,
        principal: HttpServer.anonymous,
        maxBodyBytes: HttpServer.defaultMaxBodyBytes,
        form: Option.some({
          contracts: [Reactions],
          login: Option.none(),
          render: redrawDocument(renderPage),
          commitWithin: HttpServer.defaultCommitWithin,
        }),
      }),
      HttpRouter.add("*", "/*", pages),
    );
    const app = yield* HttpRouter.toHttpEffect(table);
    const fetch = HttpEffect.toWebHandlerWith<
      BlogServices,
      BlogServices | HttpServerRequest.HttpServerRequest | Scope.Scope
    >(context)(app);
    return yield* Effect.acquireRelease(
      Effect.try({
        // oxlint-disable-next-line effect/noGlobals -- the platform boundary: Bun listens and hands each request to the router.
        try: () => Bun.serve({ port: options.port, fetch: (request) => fetch(request) }),
        catch: (cause) => ServerNotStarted.make({ port: options.port, reason: String(cause) }),
      }),
      (running) => Effect.promise(() => running.stop(true)),
    );
  });
  const server = yield* Scope.provide(started, held).pipe(
    Effect.onError(() => Scope.close(held, Exit.void)),
  );
  const bound = Option.getOrElse(Option.fromNullishOr(server.port), () => options.port);
  const running: RunningServer = { url: `http://127.0.0.1:${String(bound)}`, port: bound };
  return running;
});

const main = Effect.gen(function* () {
  const port = yield* Config.withDefault(Config.Port("PORT"), 3000);
  const out = yield* Config.withDefault(Config.String("BLOG_OUT"), defaultOut);
  const server = yield* serve({ port, out });
  yield* Console.log(`blog: ${server.url}`);
  return yield* Effect.never;
});

/** The site this process serves: the posts in `BLOG_POSTS`, or the bundled ones. */
const siteFromEnv = Layer.unwrap(
  Effect.map(Config.withDefault(Config.String("BLOG_POSTS"), defaultPosts), site),
);

if (import.meta.main) {
  // The process entry point: the one place the site layer is provided.
  // @effect-diagnostics-next-line strictEffectProvide:off
  Effect.runFork(Effect.scoped(Effect.provide(main, siteFromEnv)));
}
