import type { Layer } from "effect";
import { HttpServer } from "effect-frame/actor";
import type { ActorTransport } from "effect-frame/actor/client";
import { Anonymous, Authenticated, CurrentPrincipal, Principal } from "effect-frame/actor/client";
import { renderDocument } from "effect-frame/router";
import type { DocumentOutcome, DocumentTimedOut } from "effect-frame/router";
import type { Html } from "effect-frame/view";
import { Effect, Exit, ManagedRuntime, Option, Scope, Stream } from "effect";
import { demoTenant } from "./contract.js";
import { inProcess } from "./host.server.js";
import { routes } from "./routes.js";
import { NotFound } from "./views.js";

/**
 * The platform boundary. Everything that touches Bun, the process
 * environment, or the network lives in this file.
 *
 * Routes:
 *   GET  /client.js    the browser bundle, built once at start
 *   *    /actors/*     the actor transport, as the client's `baseUrl`
 *   GET  anything else the route tree's document, streamed
 *
 * Who is asking comes from one fixture header, `x-dashboard-member`: the
 * tenants a member belongs to, comma separated. It is read here and only
 * here, for the page and for the actors alike (#25 §4). No header is
 * `Anonymous`, and `tenantMember` refuses it.
 */

const actorPrefix = "/actors";

/** The fixture header that names a member's tenants. */
export const memberHeader = "x-dashboard-member";

/** The principal a request's fixture header names. */
export const principalOf = (request: Request): Principal =>
  Option.match(Option.fromNullishOr(request.headers.get(memberHeader)), {
    onNone: (): Principal => Anonymous.make({}),
    onSome: (tenants): Principal =>
      Authenticated.make({
        subject: `member:${tenants}`,
        claims: { tenants: tenants.split(",").filter((tenant) => tenant.length > 0) },
      }),
  });

/** Build the browser bundle once, at start, and keep it in memory. */
const buildClient = Effect.fn("Dashboard.buildClient")(function* () {
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

/** The document around the routed markup. */
export const dashboardDocument: Html.Document = {
  head: '<!doctype html><html><head><meta charset="utf-8"><title>Dashboard</title></head><body><main id="app">',
  tail: "</main>",
  bootstrap: '<script type="module" src="/client.js"></script>',
  end: "</body></html>",
};

/** How long a streamed document may take to finish. */
export const pageLimit: Effect.Effect<void> = Effect.sleep("10 seconds");

/**
 * Render one URL through the route tree, in the caller's request Scope and
 * under the caller's principal. The tree's constructor picks the mode.
 */
export const renderPage = Effect.fn("Dashboard.renderPage")(function* (
  url: URL,
  closeWhen: Effect.Effect<void> = pageLimit,
) {
  return yield* renderDocument({
    routes,
    notFound: NotFound,
    url,
    document: dashboardDocument,
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

/** How a page is drawn for one URL, in the request Scope it is given. */
export type PageRenderer<R> = (
  url: URL,
) => Effect.Effect<DocumentOutcome<unknown>, DocumentTimedOut, R | Scope.Scope>;

/**
 * Answer one page request through `render`, in a request Scope of its own.
 * The Scope outlives this Effect only for a returned body, and closes when
 * that body ends. Every other exit closes it before the answer leaves: a
 * redirect, a timeout, a failure or a defect in the drawing or in making
 * the response, and an interruption. A defect answers 500.
 */
export const answerWith =
  <R>(render: PageRenderer<R>) =>
  (request: Request): Effect.Effect<Response, never, Exclude<R, Scope.Scope>> =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const close = Scope.close(scope, Exit.void);
      return yield* render(new URL(request.url)).pipe(
        Scope.provide(scope),
        Effect.flatMap((outcome) => respond(outcome, close)),
        Effect.onExit((exit) => {
          if (Exit.isSuccess(exit)) {
            return Effect.void;
          }
          return close;
        }),
        Effect.catchTag("DocumentTimedOut", () =>
          Effect.succeed(new Response("the page took too long", { status: 504 })),
        ),
        Effect.catchCause((cause) =>
          Effect.as(
            Effect.logError("[dashboard] page failed", cause),
            new Response("the page failed", { status: 500 }),
          ),
        ),
        Effect.provideService(CurrentPrincipal, principalOf(request)),
      );
    });

/** Answer one page request through the route tree. */
const answerPage = answerWith((url) => renderPage(url));

/** A built transport. The page render and the actor routes share it. */
export type DashboardRuntime = ManagedRuntime.ManagedRuntime<ActorTransport, never>;

export const makeRuntime = (transport: Layer.Layer<ActorTransport>): DashboardRuntime =>
  ManagedRuntime.make(transport);

export interface ServerOptions {
  readonly port: number;
  readonly runtime: DashboardRuntime;
  /**
   * The member a request with no fixture header is served as. The demo
   * sets it, so a browser can open the page; a test leaves it out and names
   * the member on each request, or none.
   */
  readonly member?: string;
}

export interface RunningServer {
  readonly url: string;
  readonly port: number;
  /** Stops listening. The runtime, and so the actors, outlive this call. */
  readonly stop: () => Promise<void>;
}

/** The request with the default member stamped on it, when it names none. */
const stamped = (request: Request, member: Option.Option<string>): Request => {
  if (Option.isNone(member) || request.headers.has(memberHeader)) {
    return request;
  }
  const headers = new Headers(request.headers);
  headers.set(memberHeader, member.value);
  return new Request(request, { headers });
};

/**
 * Start the example on one port over one runtime. Stopping the server does
 * not stop the actors: the caller owns the runtime and disposes it.
 */
export const makeServer = async (options: ServerOptions): Promise<RunningServer> => {
  const runtime = options.runtime;
  const member = Option.fromNullishOr(options.member);
  const actors = await runtime.runPromise(
    HttpServer.make({
      principal: (request) => Effect.succeed(Principal.constant(principalOf(request))),
    }),
  );
  const client = await runtime.runPromise(buildClient());

  // oxlint-disable-next-line effect/noGlobals -- Bun.serve is the platform boundary.
  const server = Bun.serve({
    port: options.port,
    fetch: (incoming: Request): Response | Promise<Response> => {
      const request = stamped(incoming, member);
      const url = new URL(request.url);
      if (url.pathname.startsWith(actorPrefix)) {
        const stripped = new URL(request.url);
        stripped.pathname = url.pathname.slice(actorPrefix.length);
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

const main = async (): Promise<void> => {
  // oxlint-disable-next-line node/no-process-env -- the boundary reads the environment once.
  const port = Number(process.env["PORT"] ?? 3000);
  const server = await makeServer({ port, runtime: makeRuntime(inProcess), member: demoTenant });
  console.log(`dashboard: ${server.url}`);
};

if (import.meta.main) {
  await main();
}
