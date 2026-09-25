import {
  Actor,
  ActorHost,
  HttpServer,
  Policies,
  Policy,
  implementQuery,
  implementTransparent,
} from "effect-frame/actor";
import { Anonymous, Principal } from "effect-frame/actor/client";
import { Effect, Layer, Option, Schema, Stream } from "effect";
import type { HttpServerRequest } from "effect/unstable/http";
import { Headers } from "effect/unstable/http";
import { Ledger, Totals, ledgerBehavior } from "./ledger.js";

const LedgerLive = implementTransparent(Ledger, { behavior: ledgerBehavior });

// #region query-reads-actor
// A query reads an actor through a reference, as a client does. The host
// gives each run an `ActorTransport` and a `Scope`: the reference closes
// when the read ends, so `run` needs no `Effect.scoped`.
const TotalsLive = implementQuery(Totals, {
  run: (args) =>
    Effect.flatMap(
      Actor.remote(Ledger, { tenant: args.tenant, id: "book" }),
      (book) => book.state.get,
    ),
});
// #endregion query-reads-actor

// #region policy
const decodeTenants = Schema.decodeUnknownOption(Schema.Array(Schema.String));

// The tenants a session published about its subject. Anonymous has none.
const tenantsOf = (who: Principal): ReadonlyArray<string> => {
  if (who._tag === "Anonymous") {
    return [];
  }
  return Option.getOrElse(decodeTenants(who.claims["tenants"]), (): ReadonlyArray<string> => []);
};

// One rule for the ledger and the totals. `forSubjects` decodes the ledger's
// key and the totals' arguments with their own codecs, and refuses any
// subject it does not name.
const tenantMember = Policy.forSubjects({ contracts: [Ledger], queries: [Totals] }, (who, key) =>
  Effect.succeed(tenantsOf(who).includes(key.tenant)),
);

// Every name a contract or query declares has a rule. Allow-all exists
// only by name.
const policies = Layer.succeed(Policies, Policies.of({ tenantMember, public: Policy.allowAll }));

export const host = ActorHost.layer({
  implementations: [LedgerLive],
  queries: [TotalsLive],
  store: ActorHost.memoryStore,
}).pipe(Layer.provide(policies));
// #endregion policy

// An example's stand-ins for a session store and a cookie.
const readSession = (_sessionId: string): Effect.Effect<Principal> =>
  Effect.succeed(Anonymous.make({}));
const followSession = (sessionId: string) => Stream.fromEffect(readSession(sessionId));
const sessionIdOf = (request: HttpServerRequest.HttpServerRequest): Option.Option<string> =>
  Headers.get(request.headers, "x-session");

// #region principal
// The principal is derived once per request, and followed on a connection:
// one subscription per session, shared by every connection on it.
export const handler = Effect.gen(function* () {
  const sessions = yield* HttpServer.shareSessions({
    read: readSession, // (sessionId) => Effect<Principal>
    follow: followSession, // (sessionId) => Stream<Principal>, current first
  });
  const principal: HttpServer.DerivePrincipal = (request) =>
    Effect.succeed(
      Option.match(sessionIdOf(request), { onNone: () => Principal.anonymous, onSome: sessions }),
    );
  return yield* HttpServer.make({
    prefix: "/actors",
    principal,
    maxBodyBytes: HttpServer.defaultMaxBodyBytes,
    form: Option.none(),
  });
});
// #endregion principal
