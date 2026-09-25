// #region main
// oxlint-disable effect/noAsyncFunction, effect/noGlobals -- the process edge: Bun builds the bundle and serves, and each request enters the runtime through runPromise.
import { ManagedRuntime } from "effect";
import { host } from "./counter.server.js";
import { actorHandler, answerPage } from "./page.server.js";

// The platform boundary: one runtime holds the actors, and both the pages
// and the actor handler run in it.
const runtime = ManagedRuntime.make(host);
const actors = await runtime.runPromise(actorHandler);
const client = await Bun.build({ entrypoints: ["./client.tsx"], target: "browser" });
const bundle = await client.outputs[0]?.text();

Bun.serve({
  port: 3000,
  fetch: (request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/actors/")) {
      return runtime.runPromise(actors(request));
    }
    if (url.pathname === "/client.js") {
      return new Response(bundle, { headers: { "content-type": "text/javascript" } });
    }
    return runtime.runPromise(answerPage(request));
  },
});
// #endregion main
