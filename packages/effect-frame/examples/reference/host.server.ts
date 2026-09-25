import {
  Actor,
  ActorHost,
  Behavior,
  Policies,
  Policy,
  implementBatchedQuery,
  implementQuery,
  implementTransparent,
} from "effect-frame/actor";
import { Effect, Layer, Schema } from "effect";
import { Counter, counterBehavior } from "../counter/contract.js";
import { Rows, Totals } from "./actor.js";

/**
 * The `@example` blocks of the actor host modules' JSDoc, as compiled
 * regions. `bun run docs` holds each block to its region here.
 */

export const policies = Layer.succeed(
  Policies,
  Policies.of({ public: Policy.allowAll, tenantMember: Policy.allowAll }),
);

const totalFor = (tenant: string): number => tenant.length;
const rowFor = (id: string) => ({ id, total: id.length });

// #region implement-transparent
export const CounterLive = implementTransparent(Counter, { behavior: counterBehavior });
// #endregion implement-transparent

// #region implement-query
export const TotalsLive = implementQuery(Totals, {
  run: ({ tenant }) => Effect.succeed(totalFor(tenant)),
});
// #endregion implement-query

// #region implement-batched-query
export const RowsLive = implementBatchedQuery(Rows, {
  resolve: () => Effect.succeed((id: string) => Effect.succeed(rowFor(id))),
});
// #endregion implement-batched-query

// #region memory-store
export const host = ActorHost.layer({
  implementations: [CounterLive],
  store: ActorHost.memoryStore,
}).pipe(Layer.provide(policies));
// #endregion memory-store

const SetMessage = Schema.TaggedStruct("Set", { value: Schema.Finite });

export const durableCounter = Effect.gen(function* () {
  // #region durable
  const counter = yield* Actor.durable({
    behavior: Behavior.value(0),
    state: Schema.fromJsonString(Schema.Finite),
    message: Schema.fromJsonString(SetMessage),
  });
  // #endregion durable
  return counter;
});
