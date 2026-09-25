import { HttpServer } from "effect-frame/actor";
import type { ActorTransport } from "effect-frame/actor/client";
import { Anonymous, Authenticated, Principal } from "effect-frame/actor/client";
import { renderDocument, respondDocument } from "effect-frame/router";
import type { Html } from "effect-frame/view";
import type { Scope } from "effect";
import { Config, Console, Effect, Layer, Option, Schema } from "effect";
import {
  Headers as HttpHeaders,
  HttpEffect,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { demoTenant } from "./contract.js";
import { inProcess } from "./host.server.js";
import { actorPrefix, rootId } from "./document.js";
import { routes } from "./routes.js";
import { NotFound } from "./views.js";

/**
 * The platform boundary. Everything that touches Bun, the process
 * environment, or the network lives in this file.
 *
 * Routes, on one `HttpRouter`:
 *   GET  /client.js    the browser bundle, built once at start
 *   *    /actors/*     the actor transport, as the client's `baseUrl`
 *   GET  anything else the route tree's document, streamed
 *
 * Who is asking comes from one fixture header, `x-dashboard-member`: the
 * tenants a member belongs to, comma separated. It is read here and only
 * here, for the page and for the actors alike (#25 §4). No header is
 * `Anonymous`, and `tenantMember` refuses it.
 */

/** The fixture header that names a member's tenants. */
export const memberHeader = "x-dashboard-member";

/** The principal a request's fixture header names. */
export const principalOf = (request: HttpServerRequest.HttpServerRequest): Principal =>
  Option.match(HttpHeaders.get(request.headers, memberHeader), {
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
const answerPage = respondDocument(
  (url) =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
      renderPage(url, principalOf(request)),
    ),
  {
    onTimeout: () =>
      Effect.succeed(HttpServerResponse.text("the page took too long", { status: 504 })),
  },
);

/** The server could not start listening, for example on a port already taken. */
export class ServerNotStarted extends Schema.TaggedError<ServerNotStarted>()("ServerNotStarted", {
  port: Schema.Finite,
  reason: Schema.String,
}) {
  override get message(): string {
    return `dashboard could not listen on port ${String(this.port)}: ${this.reason}`;
  }
}

export interface ServeOptions {
  readonly port: number;
  /**
   * The member a request with no fixture header is served as. The demo
   * sets it, so a browser can open the page; a test gives none and names
   * the member on each request, or none.
   */
  readonly member: Option.Option<string>;
}

export interface RunningServer {
  readonly url: string;
  readonly port: number;
}

/** The request with the default member stamped on it, when it names none. */
const stamped = (
  request: HttpServerRequest.HttpServerRequest,
  member: Option.Option<string>,
): HttpServerRequest.HttpServerRequest => {
  if (Option.isNone(member) || HttpHeaders.has(request.headers, memberHeader)) {
    return request;
  }
  return request.modify({ headers: HttpHeaders.set(request.headers, memberHeader, member.value) });
};

/**
 * Serve the example on one port over the `ActorTransport` in context,
 * until the calling Scope closes. Closing it stops listening; the actors
 * belong to whoever provided the transport.
 */
export const serve = Effect.fn("Dashboard.serve")(function* (options: ServeOptions) {
  const client = yield* buildClient();
  const table = Layer.mergeAll(
    HttpServer.layer({
      prefix: actorPrefix,
      principal: (request) => Effect.succeed(Principal.constant(principalOf(request))),
      maxBodyBytes: HttpServer.defaultMaxBodyBytes,
      // The dashboard's forms post through the hydrated client only.
      form: Option.none(),
    }),
    HttpRouter.add(
      "GET",
      "/client.js",
      HttpServerResponse.text(client, { contentType: "text/javascript; charset=utf-8" }),
    ),
    HttpRouter.add("*", "/*", answerPage),
  );
  const router = yield* HttpRouter.toHttpEffect(table);
  // Every route, the page and the actors alike, sees the member stamped.
  const app = Effect.updateService(router, HttpServerRequest.HttpServerRequest, (request) =>
    stamped(request, options.member),
  );
  const fetch = HttpEffect.toWebHandlerWith<
    ActorTransport,
    ActorTransport | HttpServerRequest.HttpServerRequest | Scope.Scope
  >(yield* Effect.context<ActorTransport>())(app);
  const server = yield* Effect.acquireRelease(
    Effect.try({
      // oxlint-disable-next-line effect/noGlobals -- the platform boundary: Bun listens and hands each request to the router.
      try: () => Bun.serve({ port: options.port, fetch: (request) => fetch(request) }),
      catch: (cause) => ServerNotStarted.make({ port: options.port, reason: String(cause) }),
    }),
    (running) => Effect.promise(() => running.stop(true)),
  );
  const bound = Option.getOrElse(Option.fromNullishOr(server.port), () => options.port);
  const running: RunningServer = { url: `http://127.0.0.1:${String(bound)}`, port: bound };
  return running;
});

const main = Effect.gen(function* () {
  const port = yield* Config.withDefault(Config.Port("PORT"), 3000);
  const server = yield* serve({ port, member: Option.some(demoTenant) });
  yield* Console.log(`dashboard: ${server.url}`);
  return yield* Effect.never;
});

if (import.meta.main) {
  // The process entry point: the one place the transport layer is provided.
  // @effect-diagnostics-next-line strictEffectProvide:off
  Effect.runFork(Effect.scoped(Effect.provide(main, inProcess)));
}
