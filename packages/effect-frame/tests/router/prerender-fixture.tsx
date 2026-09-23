/* oxlint-disable effect/noGlobals -- the serving proofs build web-standard Requests and read Responses, the boundary under test. */
import { Streaming, runQuery, useQuery } from "effect-frame/actor";
import type { ActorTransport, QueryCache, QueryFailure, QueryState } from "effect-frame/actor";
import { Route, renderDocument } from "effect-frame/router";
import type { AnyRoute, NotFoundProps } from "effect-frame/router";
import * as Prerender from "effect-frame/router/prerender";
import { View } from "effect-frame/view";
import type { Context, Scope } from "effect";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { Label, collect, frame } from "../view/streaming-fixture.js";

/**
 * Shared by the prerender build, serve, and resume proofs (#23, #86): a
 * blog whose post pages come from an index query, the build's options, and
 * the helpers that read what the build wrote.
 */

export const origin = "http://site.test";

type Labelled = QueryState<{ readonly label: string }, QueryFailure>;

export const labelOf = (state: Labelled): string => {
  if (state._tag === "Ready") {
    return state.value.label;
  }
  return state._tag;
};

export const NotFound = (_props: NotFoundProps) => Effect.succeed(<p id="missing">missing</p>);

const Nothing = Schema.Struct({});

/** The slugs the index names. `a/b` proves a segment is percent-encoded once. */
export const slugs = ["a/b", "first", "second"];

/** The index query's value, as the store answers it: the slugs, comma-separated. */
export const indexLabel = slugs.join(",");

/** The index page: one query, and a link to every post. */
export const indexRoute = Route.prerender("index", {
  path: "/blog",
  params: Nothing,
  search: Route.search(Nothing),
  view: () =>
    Effect.gen(function* () {
      const index = yield* useQuery(Label, { id: "index" });
      return (
        <section>
          <h1 id="index">{View.bind(index.state, labelOf)}</h1>
          {slugs.map((slug) => (
            <a href={`/blog/${encodeURIComponent(slug)}`}>{slug}</a>
          ))}
        </section>
      );
    }),
  inputs: Effect.succeed([{}]),
});

export const postSegment = Route.segment("post", {
  path: "/blog/:slug",
  params: Schema.Struct({ slug: Schema.String }),
  data: ({ params }) => ({ post: Route.query(Label, { id: `post-${params.slug}` }) }),
});

/** The posts the index names, read through the query cache the build shares. */
export const readIndex = Effect.map(runQuery(Label, { id: "index" }), (index) =>
  index.label.split(",").map((slug) => ({ slug })),
);

export const postsRoute = Route.prerender(
  "posts",
  Route.leaf(postSegment, (props) =>
    Effect.succeed(
      <article id="post">
        <p id="body">{View.bind(props.data.post.state, labelOf)}</p>
        <a href="/blog">index</a>
      </article>,
    ),
  ),
  { inputs: [Route.inputs(postSegment, readIndex)] },
);

/** The labels the store holds for the blog: the index and one per post. */
export const blogLabels: Readonly<Record<string, string>> = Object.fromEntries([
  ["index", indexLabel],
  ...slugs.map((slug) => [`post-${slug}`, `body of ${slug}`]),
]);

export const blogRoutes = [indexRoute, postsRoute];

/** The document around each page: the streaming fixture's frame, without its bootstrap. */
export const pageDocument = (_page: Prerender.Page) =>
  Effect.succeed({ head: frame.head, tail: frame.tail, end: frame.end });

export const clientBundle = 'console.log("client");';

/** Build `routes` into `out` over `side`, with a generous limit. */
export const buildInto = <Routes extends AnyRoute<unknown>, S>(
  side: Context.Context<S>,
  routes: ReadonlyArray<Routes>,
  out: string,
) =>
  Prerender.build({
    routes,
    notFound: NotFound,
    document: pageDocument,
    client: Effect.succeed(clientBundle),
    out,
    timeLimit: "5 seconds",
  }).pipe(Effect.provideContext(side));

/** A fresh directory for one test, removed when its scope closes. */
export const tempDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "effect-frame-prerender-" });
});

/** Every file under `directory`, relative to it, with its text, in path order. */
export const treeOf = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const exists = yield* fs.exists(directory);
    if (!exists) {
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
  });

/** The generation `out` publishes: the directory a loaded site reads. */
export const generationOf = (out: string) =>
  Effect.flatMap(Effect.orDie(Prerender.load(out)), (site) =>
    Option.match(site.generation, {
      onNone: () => Effect.die(`nothing is published in ${out}`),
      onSome: Effect.succeed,
    }),
  );

/** Every file of the published generation, relative to it. */
export const servedTree = (out: string) => Effect.flatMap(generationOf(out), treeOf);

/** The names directly in `directory`. */
export const namesIn = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return (yield* fs.readDirectory(directory)).toSorted();
  });

export const readText = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(file);
  });

/** The AwaitAll seed a document holds. */
export const seedIn = (html: string): ReadonlyArray<Streaming.Patch> =>
  Option.match(
    Option.fromNullishOr(
      new RegExp(`<script type="application/json" id="${Streaming.seedId}">(.*?)</script>`).exec(
        html,
      ),
    ),
    {
      onNone: () => [],
      onSome: (found) =>
        Schema.decodeUnknownSync(Streaming.SeedJson)(
          Option.getOrElse(Option.fromNullishOr(found[1]), () => "[]"),
        ),
    },
  );

/** Every `href` attribute a document holds. */
export const linksIn = (html: string): ReadonlyArray<string> =>
  Array.from(html.matchAll(/<a href="([^"]*)"/g), (match) =>
    Option.getOrElse(Option.fromNullishOr(match[1]), () => ""),
  );

/**
 * The router as the fallback handler: render the request through
 * `renderDocument`, over `side`, and count every call.
 */
export const routerFallback = (
  side: Context.Context<QueryCache | ActorTransport>,
  routes: ReadonlyArray<AnyRoute<QueryCache | ActorTransport | Scope.Scope>>,
  calls: Array<string>,
): Prerender.WebHandler => {
  const handler: Prerender.WebHandler = (request) =>
    Effect.gen(function* () {
      calls.push(new URL(request.url).pathname);
      const outcome = yield* renderDocument({
        routes,
        notFound: NotFound,
        url: new URL(request.url),
        document: { ...frame, bootstrap: Prerender.clientScript },
        closeWhen: Effect.sleep("5 seconds"),
      });
      if (outcome._tag === "Redirect") {
        return new Response("", { status: 302 });
      }
      const html = (yield* collect(outcome.body)).join("");
      return new Response(html, {
        status: outcome.status,
        headers: { "x-mode": outcome.mode },
      });
    }).pipe(Effect.scoped, Effect.provideContext(side), Effect.orDie);
  return handler;
};

export const textOfResponse = (response: Response) => Effect.promise(() => response.text());
