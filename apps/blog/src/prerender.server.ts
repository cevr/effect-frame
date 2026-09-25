import type { Route, Router } from "effect-frame/router";
import * as Prerender from "effect-frame/router/prerender";
import type { ActorTransport, QueryCache } from "effect-frame/actor/client";
import { BunRuntime } from "@effect/platform-bun";
import { Effect } from "effect";
import { blogDocument } from "./document.js";
import { site } from "./reactions.server.js";
import { routes as siteRoutes } from "./routes.js";
import { NotFound } from "./views.js";

/**
 * The prerender build (#23 §2): every page of the Blog tree, rendered at
 * build as `Anonymous` in `AwaitAll`, written to `<out>` as a new
 * generation, published with one rename. `bun run prerender` runs it; the
 * gate does not, because it reads the live posts (#23 §2.1). A server
 * module: it bundles and writes files.
 */

/** Where the posts and the output live, unless the environment says otherwise. */
export const defaultPosts = new URL("../posts", import.meta.url).pathname;
export const defaultOut = new URL("../dist/prerender", import.meta.url).pathname;

/** The one browser bundle every page loads, built from `client.tsx`. */
export const bundleClient = Effect.gen(function* () {
  const result = yield* Effect.promise(() =>
    Bun.build({
      entrypoints: [new URL("./client.tsx", import.meta.url).pathname],
      target: "browser",
      format: "esm",
      minify: false,
      // The scripts pass --conditions=source; an in-process build must say so itself.
      conditions: ["source"],
    }),
  );
  if (!result.success) {
    return yield* Effect.die(result.logs.map(String).join("\n"));
  }
  const parts = yield* Effect.forEach(result.outputs, (output) =>
    Effect.promise(() => output.text()),
  );
  return parts.join("\n");
});

export interface BuildOptions<Routes extends Route.AnyRoute<unknown>> {
  readonly out: string;
  /** The routes the server mounts. The prerender ones are built. */
  readonly routes: ReadonlyArray<Routes>;
  /** The browser bundle. The real one is `bundleClient`; a test may pass a stub. */
  readonly client: Effect.Effect<string>;
}

/** Build the site into `out` over the services the server runs on. */
export const buildSite = <Routes extends Route.AnyRoute<unknown>>(options: BuildOptions<Routes>) =>
  Prerender.build({
    routes: options.routes,
    notFound: NotFound,
    document: () => Effect.succeed(blogDocument),
    client: options.client,
    out: options.out,
    timeLimit: "30 seconds",
  });

/** A route the site mounts: what it reads is the host's and the query cache's. */
export type SiteRoute = Route.AnyRoute<QueryCache | ActorTransport | Router>;

/** Build `routes` over `posts` into `out`, and say what it wrote. */
export const main = (routes: ReadonlyArray<SiteRoute>, out: string) =>
  Effect.tap(buildSite({ out, routes, client: bundleClient }), (manifest) =>
    Effect.log(`prerender: ${String(manifest.pages.length)} pages into ${out}`),
  );

export interface CommandOptions {
  readonly routes: ReadonlyArray<SiteRoute>;
  readonly posts: string;
  readonly out: string;
}

/**
 * The command's entry point, and the one place its services are provided.
 * A failure logs its cause and exits non-zero, and publishes nothing.
 */
export const command = (options: CommandOptions) =>
  // @effect-diagnostics-next-line strictEffectProvide:off
  BunRuntime.runMain(Effect.provide(main(options.routes, options.out), site(options.posts)));

if (import.meta.main) {
  // oxlint-disable-next-line node/no-process-env -- the command reads its paths once, here.
  const env = process.env;
  command({
    routes: siteRoutes,
    posts: env["BLOG_POSTS"] ?? defaultPosts,
    out: env["BLOG_OUT"] ?? defaultOut,
  });
}
