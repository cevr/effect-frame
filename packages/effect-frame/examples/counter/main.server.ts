// #region main
// oxlint-disable effect/noGlobals -- the process edge: Bun builds the bundle and serves the router's web handler.
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { host } from "./counter.server.js";
import { actors, answerPage } from "./page.server.js";

// The browser bundle, built once when the router is built.
const bundle = Effect.promise(() =>
  Bun.build({ entrypoints: ["./client.tsx"], target: "browser" }),
).pipe(
  Effect.flatMap((built) =>
    Effect.forEach(built.outputs, (out) => Effect.promise(() => out.text())),
  ),
  Effect.map((parts) => parts.join("\n")),
);

// One router serves the actor routes, the bundle, and every page.
const app = Layer.mergeAll(
  actors,
  Layer.unwrap(
    Effect.map(bundle, (text) =>
      HttpRouter.add(
        "GET",
        "/client.js",
        HttpServerResponse.text(text, { contentType: "text/javascript" }),
      ),
    ),
  ),
  HttpRouter.add("GET", "/*", answerPage),
);

// The platform boundary: the host layer under the router holds the actors,
// and `toWebHandler` is the `fetch` Bun serves.
const { handler } = HttpRouter.toWebHandler(Layer.provideMerge(app, host), { disableLogger: true });
Bun.serve({ port: 3000, fetch: (request) => handler(request) });
// #endregion main
