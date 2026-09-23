import type { Layer } from "effect";
import { HttpServer } from "effect-frame/actor";
import type { ActorTransport } from "effect-frame/actor/client";
import { Form, Wire, ref, resumeCodec } from "effect-frame/actor/client";
import { Html } from "effect-frame/view";
import { Effect, ManagedRuntime, Option, Schema } from "effect";
import { Notes, demoKey, resumeScriptId } from "./contract.js";
import { inProcess, upstream } from "./notes.server.js";
import { NotesPage } from "./page.js";

/**
 * The platform boundary. Everything that touches Bun, the process
 * environment, or the network lives in this file. The page, the view, and
 * the actor never see them.
 *
 * Routes:
 *   GET  /           the server-rendered page plus its resume payload
 *   GET  /client.js  the browser bundle, built once at start
 *   POST /actors/form  a plain form post, for a page with no script (#21)
 *   *    /actors/*   the actor transport, as the client's `baseUrl`
 */

const actorPrefix = "/actors";
const Resume = resumeCodec(Notes);

/** Build the browser bundle once, at start, and keep it in memory. */
const buildClient = Effect.fn("Notes.buildClient")(function* () {
  const result = yield* Effect.promise(() =>
    // oxlint-disable-next-line effect/noGlobals -- Bun.build is the platform boundary.
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

/** Render the page and the snapshot it rendered from, as one document. */
const document = Effect.fn("Notes.document")(function* () {
  const body = yield* Html.renderToString(NotesPage, { key: demoKey, resume: Option.none() });
  const notes = yield* ref(Notes, demoKey);
  const applied = yield* notes.applied.get;
  const payload = yield* Effect.orDie(Schema.encodeEffect(Resume)(applied));
  // A refused post's page carries its issues, so the client draws the same form.
  const refusal = yield* Effect.serviceOption(Form.FormContext);
  const issues = yield* Option.match(refusal, {
    onNone: () => Effect.succeed(""),
    onSome: (found) =>
      Effect.map(Form.encodeIssues(found), (json) => Html.jsonScript(Form.issuesScriptId, json)),
  });
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8"><title>Notes</title></head><body>',
    `<main id="app">${body}</main>`,
    Html.jsonScript(resumeScriptId, payload),
    issues,
    '<script type="module" src="/client.js"></script>',
    "</body></html>",
  ].join("");
});

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
  // A refused post re-renders this same document with its issues.
  const forms = await runtime.runPromise(
    HttpServer.form({
      contracts: [Notes],
      principal: HttpServer.anonymous,
      // No sign-in route: `public` never refuses, and a refusal would be a 403.
      login: Option.none(),
      render: () => Effect.scoped(document()),
    }),
  );
  const client = await runtime.runPromise(buildClient());

  // oxlint-disable-next-line effect/noGlobals -- Bun.serve is the platform boundary.
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
      if (url.pathname === "/") {
        return runtime
          .runPromise(Effect.scoped(document()))
          .then(
            (html) =>
              new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
          );
      }
      return new Response("not found", { status: 404 });
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
