import { HttpServer } from "effect-frame/actor";
import type { ActorTransport, Principal } from "effect-frame/actor/client";
import { Anonymous, CurrentPrincipal, Form } from "effect-frame/actor/client";
import { renderDocument, respondDocument } from "effect-frame/router";
import { Html } from "effect-frame/view";
import type { Scope } from "effect";
import { Config, Console, Effect, Layer, Option, Schema, Stream } from "effect";
import type { HttpServerRequest } from "effect/unstable/http";
import { HttpEffect, HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { Notes } from "./contract.js";
import { inProcess, upstream } from "./notes.server.js";
import { rootId } from "./document.js";
import { routes } from "./routes.js";
import { NotFound } from "./views.js";

/**
 * The platform boundary. Everything that touches Bun, the process
 * environment, or the network lives in this file. The route tree, the
 * views, and the actor never see them.
 *
 * Routes, on one `HttpRouter`:
 *   GET  /client.js    the browser bundle, built once at start
 *   *    /actors/*     the actor transport, as the client's `baseUrl`, and
 *                      POST /actors/form, a plain form post for a page with
 *                      no script (#21)
 *   *    anything else the route tree's document, in the mode its tree names
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
  head: '<!doctype html><html><head><meta charset="utf-8"><title>Notes</title></head><body>',
  rootId,
  tail: issues,
  bootstrap: '<script type="module" src="/client.js"></script>',
  end: "</body></html>",
});

/** How long a document may take to prepare, and a streamed one to finish. */
export const pageLimit: Effect.Effect<void> = Effect.sleep("10 seconds");

/**
 * Render one URL through the route tree, in the caller's request Scope,
 * under the principal the caller names. The tree's constructor picks the
 * mode: nothing here names one.
 */
export const renderPage = Effect.fn("Notes.renderPage")(function* (
  url: URL,
  principal: Principal,
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
    principal,
  });
});

/** Notes has no sessions: every page is drawn for nobody in particular, and that is a written line. */
const nobody: Principal = Anonymous.make({});

/** Answer one page request. Its Scope lives until the body is written. */
const answerPage = respondDocument((url) => renderPage(url, nobody), {
  onTimeout: () =>
    Effect.succeed(HttpServerResponse.text("the page took too long", { status: 504 })),
});

/** The page a refused post draws again, as one string. */
class PageRedirected extends Schema.TaggedError<PageRedirected>()("PageRedirected", {
  location: Schema.String,
}) {}

const drawAgain = (path: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      // Drawn for the principal that posted, which the form route provides.
      const principal = yield* CurrentPrincipal;
      const outcome = yield* renderPage(new URL(path, "http://notes.invalid"), principal);
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
    return `notes could not listen on port ${String(this.port)}: ${this.reason}`;
  }
}

export interface RunningServer {
  readonly url: string;
  readonly port: number;
}

/**
 * Serve Notes on one port over the `ActorTransport` in context, until the
 * calling Scope closes. Closing it stops listening; the actors belong to
 * whoever provided the transport, so a second server over the same context
 * serves the same actors.
 */
export const serve = Effect.fn("Notes.serve")(function* (port: number) {
  const client = yield* buildClient();
  const table = Layer.mergeAll(
    // Notes has no sessions: every request is anonymous, and that is a written line.
    // A refused post re-renders the page it came from, with its issues.
    HttpServer.layer({
      prefix: actorPrefix,
      principal: HttpServer.anonymous,
      maxBodyBytes: HttpServer.defaultMaxBodyBytes,
      form: Option.some({
        contracts: [Notes],
        // No sign-in route: `public` never refuses, and a refusal would be a 403.
        login: Option.none(),
        render: drawAgain,
        commitWithin: HttpServer.defaultCommitWithin,
      }),
    }),
    HttpRouter.add(
      "GET",
      "/client.js",
      HttpServerResponse.text(client, { contentType: "text/javascript; charset=utf-8" }),
    ),
    HttpRouter.add("*", "/*", answerPage),
  );
  const app = yield* HttpRouter.toHttpEffect(table);
  const fetch = HttpEffect.toWebHandlerWith<
    ActorTransport,
    ActorTransport | HttpServerRequest.HttpServerRequest | Scope.Scope
  >(yield* Effect.context<ActorTransport>())(app);
  const server = yield* Effect.acquireRelease(
    Effect.try({
      // oxlint-disable-next-line effect/noGlobals -- the platform boundary: Bun listens and hands each request to the router.
      try: () => Bun.serve({ port, fetch: (request) => fetch(request) }),
      catch: (cause) => ServerNotStarted.make({ port, reason: String(cause) }),
    }),
    (running) => Effect.promise(() => running.stop(true)),
  );
  const bound = Option.getOrElse(Option.fromNullishOr(server.port), () => port);
  const running: RunningServer = { url: `http://127.0.0.1:${String(bound)}`, port: bound };
  return running;
});

/** The transport this process serves: its own actors, or the upstream host `NOTES_UPSTREAM` names. */
const transportFromEnv = Layer.unwrap(
  Effect.map(
    Config.option(Config.String("NOTES_UPSTREAM")),
    Option.match({ onNone: () => inProcess, onSome: upstream }),
  ),
);

const main = Effect.gen(function* () {
  const port = yield* Config.withDefault(Config.Port("PORT"), 3000);
  const server = yield* serve(port);
  yield* Console.log(`notes: ${server.url}`);
  return yield* Effect.never;
});

if (import.meta.main) {
  // The process entry point: the one place the transport layer is provided.
  // @effect-diagnostics-next-line strictEffectProvide:off
  Effect.runFork(Effect.scoped(Effect.provide(main, transportFromEnv)));
}
