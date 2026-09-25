import type { Layer } from "effect";
import { HttpServer } from "effect-frame/actor";
import type { ActorTransport } from "effect-frame/actor/client";
import { Form, Wire } from "effect-frame/actor/client";
import { renderDocument } from "effect-frame/router";
import type { DocumentOutcome } from "effect-frame/router";
import { Html } from "effect-frame/view";
import { Effect, Exit, ManagedRuntime, Option, Schema, Scope, Stream } from "effect";
import { Notes } from "./contract.js";
import { inProcess, upstream } from "./notes.server.js";
import { routes } from "./routes.js";
import { NotFound } from "./views.js";

/**
 * The platform boundary. Everything that touches Bun, the process
 * environment, or the network lives in this file. The route tree, the
 * views, and the actor never see them.
 *
 * Routes:
 *   GET  /client.js    the browser bundle, built once at start
 *   POST /actors/form  a plain form post, for a page with no script (#21)
 *   *    /actors/*     the actor transport, as the client's `baseUrl`
 *   GET  anything else the route tree's document, in the mode its tree names
 */

const actorPrefix = "/actors";

/** Build the browser bundle once, at start, and keep it in memory. */
const buildClient = Effect.fn("Notes.buildClient")(function* () {
  const result = yield* Effect.promise(() =>
    Bun.build({
      entrypoints: [new URL("./client.tsx", import.meta.url).pathname],
      target: "browser",
      format: "esm",
      minify: false,
      // The package scripts pass --conditions=source; an in-process build
      // must say so itself, or it resolves the package through dist.
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

/** The document around the routed markup. A refused post adds its issues. */
export const notesDocument = (issues = ""): Html.Document => ({
  head: '<!doctype html><html><head><meta charset="utf-8"><title>Notes</title></head><body><main id="app">',
  tail: `</main>${issues}`,
  bootstrap: '<script type="module" src="/client.js"></script>',
  end: "</body></html>",
});

/** How long a document may take to prepare, and a streamed one to finish. */
export const pageLimit: Effect.Effect<void> = Effect.sleep("10 seconds");

/**
 * Render one URL through the route tree, in the caller's request Scope.
 * The tree's constructor picks the mode: nothing here names one.
 */
export const renderPage = Effect.fn("Notes.renderPage")(function* (
  url: URL,
  closeWhen: Effect.Effect<void> = pageLimit,
) {
  // A refused post's page carries its issues, so the client draws the same form.
  const refusal = yield* Effect.serviceOption(Form.FormContext);
  const issues = yield* Option.match(refusal, {
    onNone: () => Effect.succeed(""),
    onSome: (found) =>
      Effect.map(Form.encodeIssues(found), (json) => Html.jsonScript(Form.issuesScriptId, json)),
  });
  return yield* renderDocument({
    routes,
    notFound: NotFound,
    url,
    document: notesDocument(issues),
    closeWhen,
  });
});

/** A document answer: 303 for a redirect, else the body in the status the tree chose. */
const respond = (outcome: DocumentOutcome<unknown>, close: Effect.Effect<void>) =>
  Effect.gen(function* () {
    if (outcome._tag === "Redirect") {
      yield* close;
      return new Response("", { status: 303, headers: { location: outcome.location.pathname } });
    }
    const context = yield* Effect.context<never>();
    // The request Scope holds a streamed drawing: it closes when the body ends.
    const body = Stream.encodeText(outcome.body).pipe(Stream.ensuring(close));
    return new Response(Stream.toReadableStreamWith(body, context), {
      status: outcome.status,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  });

/** Answer one page request. Its Scope lives until the body is written. */
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

/** The page a refused post draws again, as one string. */
class PageRedirected extends Schema.TaggedError<PageRedirected>()("PageRedirected", {
  location: Schema.String,
}) {}

const drawAgain = (path: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const outcome = yield* renderPage(new URL(path, "http://notes.invalid"));
      if (outcome._tag === "Redirect") {
        return yield* PageRedirected.make({ location: outcome.location.pathname });
      }
      const chunks = yield* Stream.runCollect(outcome.body);
      return Array.from(chunks).join("");
    }),
  );

/**
 * A built transport. One runtime holds one set of actors, so the page render
 * and the actor routes must share it, and a test that restarts the server
 * keeps its actors by keeping this value.
 */
export type NotesRuntime = ManagedRuntime.ManagedRuntime<ActorTransport, never>;

export const makeRuntime = (transport: Layer.Layer<ActorTransport>): NotesRuntime =>
  ManagedRuntime.make(transport);

export interface ServerOptions {
  readonly port: number;
  readonly runtime: NotesRuntime;
}

export interface RunningServer {
  readonly url: string;
  readonly port: number;
  /** Stops listening. The runtime, and so the actors, outlive this call. */
  readonly stop: () => Promise<void>;
}

/**
 * Start the example on one port over one runtime. Stopping the server does
 * not stop the actors: the caller owns the runtime and disposes it.
 */
export const makeServer = async (options: ServerOptions): Promise<RunningServer> => {
  const runtime = options.runtime;
  // Notes has no sessions: every request is anonymous, and that is a written line.
  const actors = await runtime.runPromise(HttpServer.make({ principal: HttpServer.anonymous }));
  // A refused post re-renders the page it came from, with its issues.
  const forms = await runtime.runPromise(
    HttpServer.form({
      contracts: [Notes],
      principal: HttpServer.anonymous,
      // No sign-in route: `public` never refuses, and a refusal would be a 403.
      login: Option.none(),
      render: drawAgain,
    }),
  );
  const client = await runtime.runPromise(buildClient());

  const server = Bun.serve({
    port: options.port,
    fetch: (request: Request): Response | Promise<Response> => {
      const url = new URL(request.url);
      if (url.pathname === `${actorPrefix}${Wire.paths.form}`) {
        return runtime.runPromise(forms(request));
      }
      if (url.pathname.startsWith(actorPrefix)) {
        const rest = url.pathname.slice(actorPrefix.length);
        const stripped = new URL(request.url);
        stripped.pathname = rest;
        return runtime.runPromise(actors(new Request(stripped, request)));
      }
      if (url.pathname === "/client.js") {
        return new Response(client, {
          headers: { "content-type": "text/javascript; charset=utf-8" },
        });
      }
      return runtime.runPromise(answerPage(request));
    },
  });

  const bound = Option.getOrElse(Option.fromNullishOr(server.port), () => options.port);
  return {
    url: `http://127.0.0.1:${String(bound)}`,
    port: bound,
    stop: (): Promise<void> => server.stop(true),
  };
};

/** The transport this process serves: its own actors, or an upstream host. */
const transportFromEnv = (): Layer.Layer<ActorTransport> =>
  // oxlint-disable-next-line node/no-process-env -- the boundary reads the environment once.
  Option.match(Option.fromNullishOr(process.env["NOTES_UPSTREAM"]), {
    onNone: () => inProcess,
    onSome: upstream,
  });

const main = async (): Promise<void> => {
  // oxlint-disable-next-line node/no-process-env -- the boundary reads the environment once.
  const port = Number(process.env["PORT"] ?? 3000);
  const server = await makeServer({ port, runtime: makeRuntime(transportFromEnv()) });
  console.log(`notes: ${server.url}`);
};

if (import.meta.main) {
  await main();
}
