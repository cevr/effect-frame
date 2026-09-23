import { HttpServer } from "effect-frame/actor";
import type { ActorTransport } from "effect-frame/actor/client";
import { Wire } from "effect-frame/actor/client";
import { renderDocument } from "effect-frame/router";
import type { DocumentOutcome } from "effect-frame/router";
import * as Prerender from "effect-frame/router/prerender";
import type { Crypto, FileSystem, Layer, Path } from "effect";
import { Effect, Exit, ManagedRuntime, Option, Schema, Scope, Stream } from "effect";
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

/** Render one URL through the route tree, in the caller's Scope. */
export const renderPage = Effect.fn("Blog.renderPage")(function* (url: URL) {
  return yield* renderDocument({
    routes,
    notFound: NotFound,
    url,
    document: { ...blogDocument, bootstrap: Prerender.clientScript },
    closeWhen: pageLimit,
  });
});

const respond = (outcome: DocumentOutcome<unknown>, close: Effect.Effect<void>) =>
  Effect.gen(function* () {
    if (outcome._tag === "Redirect") {
      yield* close;
      return new Response("", { status: 303, headers: { location: outcome.location.pathname } });
    }
    const context = yield* Effect.context<never>();
    const body = Stream.encodeText(outcome.body).pipe(Stream.ensuring(close));
    return new Response(Stream.toReadableStreamWith(body, context), {
      status: outcome.status,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  });

/** Answer one page through the router. Its Scope lives until the body is written. */
const answerPage = (request: Request): Effect.Effect<Response, never, ActorTransport> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const close = Scope.close(scope, Exit.void);
    return yield* renderPage(new URL(request.url)).pipe(
      Scope.provide(scope),
      Effect.flatMap((outcome) => respond(outcome, close)),
      Effect.catchTag("DocumentTimedOut", () =>
        Effect.as(close, new Response("the page took too long", { status: 504 })),
      ),
      Effect.onInterrupt(() => close),
    );
  });

class PageRedirected extends Schema.TaggedError<PageRedirected>()("PageRedirected", {
  location: Schema.String,
}) {}

/** The page a refused post draws again, as one string. */
const drawAgain = (path: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const outcome = yield* renderPage(new URL(path, "http://blog.invalid"));
      if (outcome._tag === "Redirect") {
        return yield* PageRedirected.make({ location: outcome.location.pathname });
      }
      const chunks = yield* Stream.runCollect(outcome.body);
      return Array.from(chunks).join("");
    }),
  );

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
 * generation of `out` once, at start: no generation, no built pages, and
 * every page renders on request.
 */
export const makeServer = async (options: ServerOptions): Promise<RunningServer> => {
  const runtime = options.runtime;
  // Blog has no sessions: every request is anonymous, and that is a written line.
  const actors = await runtime.runPromise(HttpServer.make({ principal: HttpServer.anonymous }));
  const forms = await runtime.runPromise(
    HttpServer.form({
      contracts: [Reactions],
      principal: HttpServer.anonymous,
      login: Option.none(),
      render: drawAgain,
    }),
  );
  const bundle = await runtime.runPromise(bundleClient);
  // The router runs in the runtime's context, captured once, so the handler needs nothing.
  const context = await runtime.runPromise(Effect.context<ActorTransport>());
  const router: Prerender.WebHandler = (request) => {
    if (new URL(request.url).pathname === "/client.js") {
      return Effect.succeed(
        new Response(bundle, { headers: { "content-type": "text/javascript; charset=utf-8" } }),
      );
    }
    return Effect.provideContext(answerPage(request), context);
  };
  const loaded = await runtime.runPromise(Effect.orDie(Prerender.load(options.out)));
  const pages = await runtime.runPromise(Prerender.serve(loaded, router));

  // oxlint-disable-next-line effect/noGlobals -- Bun.serve is the platform boundary.
  const server = Bun.serve({
    port: options.port,
    fetch: (request: Request): Response | Promise<Response> => {
      const url = new URL(request.url);
      if (url.pathname === `${actorPrefix}${Wire.paths.form}`) {
        return runtime.runPromise(forms(request));
      }
      if (url.pathname.startsWith(actorPrefix)) {
        const stripped = new URL(request.url);
        stripped.pathname = url.pathname.slice(actorPrefix.length);
        return runtime.runPromise(actors(new Request(stripped, request)));
      }
      return runtime.runPromise(pages(request));
    },
  });

  const bound = Option.getOrElse(Option.fromNullishOr(server.port), () => options.port);
  return {
    url: `http://127.0.0.1:${String(bound)}`,
    port: bound,
    stop: (): Promise<void> => server.stop(true),
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
