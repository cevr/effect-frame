import type { Layer } from "effect";
import { HttpServer } from "effect-frame/actor";
import type { ActorTransport } from "effect-frame/actor/client";
import { Anonymous, Authenticated, Principal } from "effect-frame/actor/client";
import { renderDocument, respondDocument } from "effect-frame/router";
import type { Html } from "effect-frame/view";
import { Effect, ManagedRuntime, Option } from "effect";
import { demoTenant } from "./contract.js";
import { inProcess } from "./host.server.js";
import { rootId } from "./document.js";
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
  head: '<!doctype html><html><head><meta charset="utf-8"><title>Dashboard</title></head><body>',
  rootId,
  tail: "",
  bootstrap: '<script type="module" src="/client.js"></script>',
  end: "</body></html>",
};

/** How long a streamed document may take to finish. */
export const pageLimit: Effect.Effect<void> = Effect.sleep("10 seconds");

/**
 * Render one URL through the route tree, in the caller's request Scope and
 * under the principal the caller names. The tree's constructor picks the mode.
 */
export const renderPage = Effect.fn("Dashboard.renderPage")(function* (
  url: URL,
  principal: Principal,
  closeWhen: Effect.Effect<void> = pageLimit,
) {
  return yield* renderDocument({
    routes,
    notFound: NotFound,
    url,
    document: dashboardDocument,
    closeWhen,
    principal,
  });
});

/**
 * Answer one page request under the principal its fixture header names.
 * `respondDocument` owns the request Scope: it outlives the answer only for
 * a returned body, and a defect answers 500.
 */
const answerPage = (request: Request): Effect.Effect<Response, never, ActorTransport> =>
  respondDocument(renderPage(new URL(request.url), principalOf(request)), {
    onTimeout: () => Effect.succeed(new Response("the page took too long", { status: 504 })),
  });

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
      prefix: actorPrefix,
      principal: (request) => Effect.succeed(Principal.constant(principalOf(request))),
      maxBodyBytes: HttpServer.defaultMaxBodyBytes,
      // The dashboard's forms post through the hydrated client only.
      form: Option.none(),
    }),
  );
  const client = await runtime.runPromise(buildClient());

  const server = Bun.serve({
    port: options.port,
    fetch: (incoming: Request): Response | Promise<Response> => {
      const request = stamped(incoming, member);
      const url = new URL(request.url);
      if (url.pathname.startsWith(`${actorPrefix}/`)) {
        return runtime.runPromise(actors(request));
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
