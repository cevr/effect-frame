import type { Layer } from "effect";
import { HttpServer } from "effect-frame/actor";
import type { ActorTransport } from "effect-frame/actor/client";
import { ref, resumeCodec } from "effect-frame/actor/client";
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
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8"><title>Notes</title></head><body>',
    `<main id="app">${body}</main>`,
    Html.jsonScript(resumeScriptId, payload),
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
  const actors = await runtime.runPromise(HttpServer.make);
  const client = await runtime.runPromise(buildClient());

  // oxlint-disable-next-line effect/noGlobals -- Bun.serve is the platform boundary.
  const server = Bun.serve({
    port: options.port,
    fetch: (request: Request): Response | Promise<Response> => {
      const url = new URL(request.url);
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
