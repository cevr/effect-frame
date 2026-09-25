// #region server-half
import {
  ActorHost,
  Policies,
  Policy,
  implementQuery,
  implementTransparent,
} from "effect-frame/actor";
import { Effect, Layer } from "effect";
import { Counter, CounterNames, counterBehavior } from "./contract.js";

// A `.server.ts` file runs only on a server: `bun run boundary` fails a
// browser entry that reaches it.
export const CounterLive = implementTransparent(Counter, { behavior: counterBehavior });

export const CounterNamesLive = implementQuery(CounterNames, {
  run: () => Effect.succeed(["home", "work"]),
});

// Every policy name a contract or query declares has a rule here. There is
// no default: allow-all is written by name.
export const policies = Layer.succeed(Policies, Policies.of({ public: Policy.allowAll }));

// The host runs the actors. `store` says where their mailboxes live; the
// memory store keeps nothing across a restart.
export const host = ActorHost.layer({
  implementations: [CounterLive],
  queries: [CounterNamesLive],
  store: ActorHost.memoryStore,
}).pipe(Layer.provide(policies), Layer.orDie);
// #endregion server-half
