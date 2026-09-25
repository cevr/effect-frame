import {
  Actor,
  Behavior,
  Generated,
  HttpTransport,
  QueryCache,
  batchedQuery,
  contract,
  query,
} from "effect-frame/actor/client";
import { Location, browserNavigation } from "effect-frame/router";
import { Effect, Layer, Option, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { Counter } from "../counter/contract.js";
import { Ledger } from "../features/ledger.js";

/**
 * The `@example` blocks of the actor modules' JSDoc, as compiled regions.
 * `bun run docs` holds each block to its region here.
 */

export const Row = Schema.Struct({ id: Schema.String, total: Schema.Finite });

export const Table = contract("Table", {
  version: 1,
  policy: "public",
  key: Schema.Struct({ name: Schema.String }),
  snapshot: Schema.Array(Row),
  message: Schema.TaggedStruct("Clear", {}),
});

// #region query
export const Totals = query("Totals", {
  version: 1,
  args: Schema.Struct({ tenant: Schema.String }),
  result: Schema.Finite,
  policy: "tenantMember",
  depends: [Ledger],
});
// #endregion query

// #region batched-query
export const Rows = batchedQuery("Rows", {
  version: 1,
  args: Schema.String,
  result: Row,
  policy: "public",
  depends: [Table],
});
// #endregion batched-query

export const placements = Effect.gen(function* () {
  // #region placement
  const draft = yield* Actor.local(Behavior.value(""));
  const counter = yield* Actor.remote(Counter, { name: "main" }, { resume: Option.none() });
  const commands = yield* Actor.remoteCommands(Counter, { name: "main" });
  // #endregion placement
  return { draft, counter, commands };
});

export const generated = Effect.gen(function* () {
  const counter = yield* Actor.remoteCommands(Counter, { name: "main" });
  // #region generated-send
  const handle = yield* Generated.send(counter, { _tag: "Increment", by: 2 });
  // #endregion generated-send
  return handle;
});

export const clientServices = (baseUrl: string) => {
  // #region client-services
  const transport = HttpTransport.layer({
    baseUrl,
    reconnect: HttpTransport.defaultReconnect,
  }).pipe(Layer.provide(FetchHttpClient.layer));
  const client = Layer.mergeAll(
    transport,
    QueryCache.layer,
    Layer.effect(Location, browserNavigation),
  );
  // #endregion client-services
  return client;
};
