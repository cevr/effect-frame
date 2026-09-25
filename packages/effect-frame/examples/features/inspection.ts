import { HttpTransport, QueryCache } from "effect-frame/actor/client";
import * as Frame from "effect-frame/frame";
import { attachGateway, defaultOpenTimeout, defaultRetry } from "effect-frame/inspection";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

const transport = HttpTransport.layer({
  baseUrl: "http://localhost:3000/actors",
  reconnect: HttpTransport.defaultReconnect,
}).pipe(Layer.provide(FetchHttpClient.layer));

// #region frame-layer
// One Frame layer per application root, provided into the query cache, so
// the cache registers its entries in that root. Without it, the cache
// registers nothing.
export const appLayer = Layer.mergeAll(
  transport,
  QueryCache.layer.pipe(Layer.provideMerge(Frame.layer({ name: "counter" }))),
);
// #endregion frame-layer

// #region attach
// Development entry only: a production entry imports nothing from
// effect-frame/inspection. It needs the root's `Frame.Service`, returns at
// once, and retries in the background.
export const attach = (attachToken: string) =>
  Effect.gen(function* () {
    const attachment = yield* attachGateway({
      url: "ws://127.0.0.1:4318",
      token: attachToken,
      retry: defaultRetry,
      openTimeout: defaultOpenTimeout,
    });
    return attachment.status; // a Stream: the current status, then each change
  });
// #endregion attach
