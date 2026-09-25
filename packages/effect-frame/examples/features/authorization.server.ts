import {
  Actor,
  ActorHost,
  HttpServer,
  Policies,
  Policy,
  implementQuery,
  implementTransparent,
} from "effect-frame/actor";
import type { Subject } from "effect-frame/actor";
import { Anonymous, Principal } from "effect-frame/actor/client";
import type { Authenticated } from "effect-frame/actor/client";
import { Effect, Layer, Option, Schema, Stream } from "effect";
import type { HttpServerRequest } from "effect/unstable/http";
import { Headers } from "effect/unstable/http";
import { Ledger, Totals, ledgerBehavior } from "./ledger.js";

const LedgerLive = implementTransparent(Ledger, { behavior: ledgerBehavior });

const TotalsLive = implementQuery(Totals, {
  run: (args) =>
    Effect.flatMap(
      Actor.remote(Ledger, { tenant: args.tenant, id: "book" }),
      (book) => book.state.get,
    ),
});

// #region policy
const decodeLedgerKey = Schema.decodeUnknownOption(Ledger.key);
const decodeTotalsArgs = Schema.decodeUnknownOption(Totals.args);

// The tenant a subject names: a ledger's key, or the totals' arguments.
const tenantOf = (subject: Subject): Option.Option<string> => {
  if (subject._tag === "Actor") {
    return Option.map(decodeLedgerKey(subject.address.key), (key) => key.tenant);
  }
  return Option.map(decodeTotalsArgs(subject.key.args), (args) => args.tenant);
};

const decodeTenants = Schema.decodeUnknownOption(Schema.Array(Schema.String));

// The tenants a session published about its subject.
const tenantsOf = (who: Authenticated): ReadonlyArray<string> =>
  Option.getOrElse(decodeTenants(who.claims["tenants"]), (): ReadonlyArray<string> => []);

// One rule for actors and queries. `Policy.of` refuses Anonymous first.
const tenantMember = Policy.of(tenantOf, (who, tenant) =>
  Effect.succeed(tenantsOf(who).includes(tenant)),
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
