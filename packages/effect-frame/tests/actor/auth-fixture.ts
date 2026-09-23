/* oxlint-disable effect/noGlobals -- Bun.serve and fetch are the platform boundary of the wire tests that share this fixture: a real socket on a free port. */
import { Clock, Duration, Effect, Layer, Option, Ref, Schema, Stream } from "effect";
import type { Scope } from "effect";
import { Event, Machine, State } from "effect-machine";
import type { PolicyTable, Subject } from "effect-frame/actor";
import {
  ActorHost,
  Behavior,
  HttpServer,
  Policies,
  Policy,
  implementQuery,
  implementTransparent,
} from "effect-frame/actor";
import type { Address, TransportService } from "effect-frame/actor/client";
import {
  ActorTransport,
  Anonymous,
  Authenticated,
  Claims,
  HttpTransport,
  Principal,
  contract,
  query,
  ref,
} from "effect-frame/actor/client";

/**
 * The shared shape of the authorization and revocation tests (#20, #30).
 *
 * A session is an actor. Its key is the opaque id a cookie carries; its
 * snapshot is what one sign-in published. Its machine sleeps until
 * `expiresAt` and then commits `Empty`, so expiry is a revision like a
 * sign-out. The principal of a request is derived from it, and nothing
 * else. Effect Frame ships no session store: this fixture is the example's.
 */

// ---------------------------------------------------------------------------
// The session actor
// ---------------------------------------------------------------------------

export const SessionState = State({
  Empty: {},
  Active: { subject: Schema.String, claims: Claims, expiresAt: Schema.Finite },
});

export const SessionEvent = Event({
  SignIn: { subject: Schema.String, claims: Claims, expiresAt: Schema.Finite },
  SignOut: {},
  Touch: { expiresAt: Schema.Finite },
  Expire: {},
});

/** Sleeps until `expiresAt` on the host's clock. The only timer a session has. */
const untilExpiry = (expiresAt: number) =>
  Effect.flatMap(Clock.currentTimeMillis, (now) =>
    Effect.sleep(Duration.millis(Math.max(0, expiresAt - now))),
  );

export const sessionMachine = Machine.make({
  state: SessionState,
  event: SessionEvent,
  initial: SessionState.Empty,
})
  .on(SessionState.Empty, SessionEvent.SignIn, ({ event }) =>
    SessionState.Active({
      subject: event.subject,
      claims: event.claims,
      expiresAt: event.expiresAt,
    }),
  )
  // A second sign-in on one session re-enters Active, which restarts expiry.
  .reenter(SessionState.Active, SessionEvent.SignIn, ({ event }) =>
    SessionState.Active({
      subject: event.subject,
      claims: event.claims,
      expiresAt: event.expiresAt,
    }),
  )
  // A heartbeat slides expiry and changes nothing a principal carries.
  .reenter(SessionState.Active, SessionEvent.Touch, ({ state, event }) =>
    SessionState.Active({
      subject: state.subject,
      claims: state.claims,
      expiresAt: event.expiresAt,
    }),
  )
  .on(SessionState.Active, SessionEvent.SignOut, () => SessionState.Empty)
  .on(SessionState.Active, SessionEvent.Expire, () => SessionState.Empty)
  .task(SessionState.Active, ({ state }) => untilExpiry(state.expiresAt), {
    onSuccess: () => SessionEvent.Expire,
    onFailure: () => SessionEvent.Expire,
  });

export const Session = contract("Session", {
  version: 1,
  // Knowing the key is the capability: the key is the secret the cookie
  // carries, and the derivation reads the session before any principal exists.
  policy: "session",
  key: Schema.Struct({ sessionId: Schema.String }),
  snapshot: sessionMachine.stateSchema,
  message: sessionMachine.eventSchema,
});

/** The session implementation, counting how many instances the host opened. */
export const sessionLive = (opened: Ref.Ref<number>) => {
  const machine = Behavior.machine(sessionMachine);
  return implementTransparent<typeof Session, never>(Session, {
    initial: machine.initial,
    open: (state) => Effect.tap(machine.open(state), () => Ref.update(opened, (n) => n + 1)),
  });
};

// ---------------------------------------------------------------------------
// A tenant-scoped actor behind a policy that reads the principal
// ---------------------------------------------------------------------------

export const Entry = Schema.TaggedStruct("Entry", { text: Schema.String });
export type Entry = Schema.Schema.Type<typeof Entry>;

export const Ledger = contract("Ledger", {
  version: 1,
  policy: "tenantMember",
  key: Schema.Struct({ tenant: Schema.String, id: Schema.String }),
  snapshot: Schema.Finite,
  message: Schema.Union([Entry]),
});

export const LedgerLive = implementTransparent(
  Ledger,
  Behavior.reducer<number, Entry>({ initial: 0, reduce: (count) => count + 1 }),
);

/** How many entries a tenant's ledgers hold. A read, behind the same rule. */
export const LedgerCount = query("LedgerCount", {
  args: Schema.Struct({ tenant: Schema.String }),
  result: Schema.Finite,
  policy: "tenantMember",
  depends: [Ledger],
});

/** The entries in the tenant's book, read through the host under the caller's principal. */
export const LedgerCountLive = implementQuery(LedgerCount, (args) =>
  Effect.flatMap(ref(Ledger, { tenant: args.tenant, id: "book" }), (book) => book.state.get),
);

const decodeLedgerKey = Schema.decodeUnknownOption(Ledger.key);
const decodeCountArgs = Schema.decodeUnknownOption(LedgerCount.args);

/** The tenant a subject names: a ledger's key, or a count's arguments. */
const tenantOf = (subject: Subject): Option.Option<string> => {
  if (subject._tag === "Actor") {
    return Option.map(decodeLedgerKey(subject.address.key), (key) => key.tenant);
  }
  if (subject.key.query === LedgerCount.name) {
    return Option.map(decodeCountArgs(subject.key.args), (args) => args.tenant);
  }
  return Option.none();
};

/** The tenants a session published about its subject. */
const Tenants = Schema.Array(Schema.String);
const decodeTenants = Schema.decodeUnknownOption(Tenants);

const tenantsOf = (who: Authenticated): ReadonlyArray<string> =>
  Option.getOrElse(decodeTenants(who.claims["tenants"]), (): ReadonlyArray<string> => []);

/** A member of the key's tenant may read and send. Anyone else is refused. */
export const tenantMember: Policy = Policy.of(tenantOf, (who, tenant) =>
  Effect.succeed(tenantsOf(who).includes(tenant)),
);

/** The one table these tests serve. Allow-all appears once, by name, for the session. */
export const policies: PolicyTable = {
  session: Policy.allowAll,
  tenantMember,
};

// ---------------------------------------------------------------------------
// Principal derivation: a snapshot read of the session, and its changes
// ---------------------------------------------------------------------------

const sessionCookie = "session=";

export const sessionIdOf = (request: Request): Option.Option<string> =>
  Option.fromNullishOr(request.headers.get("cookie")).pipe(
    Option.flatMap((header) =>
      Option.fromNullishOr(
        header
          .split(";")
          .map((part) => part.trim())
          .find((part) => part.startsWith(sessionCookie)),
      ),
    ),
    Option.map((part) => part.slice(sessionCookie.length)),
  );

const decodeSession = Schema.decodeEffect(Session.snapshot);
const encodeSessionKey = Schema.encodeEffect(Session.key);

export const sessionAddress = (sessionId: string) =>
  Effect.map(Effect.orDie(encodeSessionKey({ sessionId })), (key): Address => ({
    contract: Session.name,
    version: Session.version,
    key,
  }));

const anonymous: Principal = Anonymous.make({});

/**
 * An active, unexpired session is its subject. Anything else is anonymous.
 * The clock comparison is a guard that can only refuse earlier: the
 * authority is the session's own `Empty` revision.
 *
 * `clock` is the host's, passed in rather than read where this runs. The
 * derivation runs on whichever fiber a connection opens it from, and a
 * browser's fiber may keep another clock: read there, an unexpired session
 * could look expired.
 */
const principalOf = (clock: Clock.Clock, encoded: string): Effect.Effect<Principal> =>
  Effect.gen(function* () {
    const snapshot = yield* Effect.orDie(decodeSession(encoded));
    const now = yield* clock.currentTimeMillis;
    if (snapshot._tag === "Active" && snapshot.expiresAt > now) {
      return Authenticated.make({ subject: snapshot.subject, claims: snapshot.claims });
    }
    console.error(
      "[expiry] anonymous:",
      snapshot._tag,
      "expiresAt" in snapshot ? snapshot.expiresAt : "-",
      "now",
      now,
    );
    return anonymous;
  });

/** How many session subscriptions the derivation holds now, and has ever opened. */
export interface Follows {
  readonly active: Ref.Ref<number>;
  readonly opened: Ref.Ref<number>;
}

/** The session's principal over time, counted while it is followed. */
const follow = (
  transport: TransportService,
  clock: Clock.Clock,
  sessionId: string,
  follows: Follows,
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const address = yield* sessionAddress(sessionId);
      yield* Effect.acquireRelease(
        Effect.andThen(
          Ref.update(follows.active, (n) => n + 1),
          Ref.update(follows.opened, (n) => n + 1),
        ),
        () => Ref.update(follows.active, (n) => n - 1),
      );
      return transport.changes(address, -1).pipe(
        Stream.mapEffect((projection) => principalOf(clock, projection.snapshot)),
        Stream.catch((error) =>
          Stream.fromEffect(
            Effect.sync(() => {
              console.error("[expiry] follow failed:", JSON.stringify(error));
              return anonymous;
            }),
          ),
        ),
      );
    }),
  );

/** One request's principal: a snapshot read of the session. */
const read = (transport: TransportService, clock: Clock.Clock, sessionId: string) =>
  Effect.flatMap(sessionAddress(sessionId), (address) =>
    transport.snapshot(address).pipe(
      Effect.flatMap((projection) => principalOf(clock, projection.snapshot)),
      Effect.catch((error) =>
        Effect.sync(() => {
          console.error("[expiry] read failed:", JSON.stringify(error));
          return anonymous;
        }),
      ),
    ),
  );

/**
 * The host's derivation. A request reads the session once; a connection
 * follows the session's own change stream. An unreachable session is not
 * an authenticated caller.
 */
export const sessionPrincipal = (
  follows: Follows,
): Effect.Effect<HttpServer.DerivePrincipal, never, ActorTransport | Scope.Scope> =>
  Effect.gen(function* () {
    const transport = yield* ActorTransport;
    // The host's clock, taken where the host is built.
    const clock = yield* Clock.Clock;
    // One subscription per session, however many connections follow it.
    const sessions = yield* HttpServer.shareSessions({
      read: (sessionId: string) => read(transport, clock, sessionId),
      follow: (sessionId: string) => follow(transport, clock, sessionId, follows),
    });
    const derive: HttpServer.DerivePrincipal = (request) =>
      Effect.succeed(
        Option.match(sessionIdOf(request), {
          onNone: () => Principal.anonymous,
          onSome: sessions,
        }),
      );
    return derive;
  });

/**
 * A derivation with no live follow: each request reads the session once,
 * through the host it is served by. It needs `ActorTransport` from the
 * adapter that runs it.
 */
export const snapshotPrincipal: HttpServer.DerivePrincipal<ActorTransport> = (request) =>
  Option.match(sessionIdOf(request), {
    onNone: () => Effect.succeed(Principal.anonymous),
    onSome: (sessionId) =>
      Effect.gen(function* () {
        const transport = yield* ActorTransport;
        // Built per request, inside the adapter that serves it.
        const clock = yield* Clock.Clock;
        return Principal.constant(yield* read(transport, clock, sessionId));
      }),
  });

/**
 * `snapshotPrincipal` in the shape `serveHost` takes: every request reads
 * the session once, and a connection is never ended by a change.
 */
export const requestPrincipal: MakePrincipal = (_follows) =>
  Effect.map(
    Effect.context<ActorTransport>(),
    (context): HttpServer.DerivePrincipal =>
      (request) =>
        // The server is the boundary: each request reads through the host it is served by.
        // oxlint-disable-next-line effect/noInlineProvide
        Effect.provideContext(snapshotPrincipal(request), context),
  );

/** A derivation that ignores sessions, in the shape `serveHost` takes. */
export const anonymousPrincipal: MakePrincipal = (_follows) => Effect.succeed(HttpServer.anonymous);

// ---------------------------------------------------------------------------
// One host, one socket
// ---------------------------------------------------------------------------

/** Where the form route is mounted, and where a refused anonymous post is sent. */
export const formPath = "/form";
export const loginPath = "/login";

export interface Served {
  readonly baseUrl: string;
  /** The host itself, for driving sessions the way a sign-in route would. */
  readonly host: TransportService;
  /** How many session instances the host opened. */
  readonly sessionsOpened: Ref.Ref<number>;
  /** The session subscriptions the derivation holds. */
  readonly follows: Follows;
}

/** Builds the derivation once, against the host it will read sessions through. */
export type MakePrincipal = (
  follows: Follows,
) => Effect.Effect<HttpServer.DerivePrincipal, never, ActorTransport | Scope.Scope>;

/**
 * Builds the host in the caller's context (so a `TestClock` reaches the
 * session machine), and serves the JSON handler on a free port.
 */
export const serveHost = (makePrincipal: MakePrincipal) =>
  Effect.gen(function* () {
    const sessionsOpened = yield* Ref.make(0);
    const follows: Follows = { active: yield* Ref.make(0), opened: yield* Ref.make(0) };
    const host = yield* ActorHost.make({
      implementations: [sessionLive(sessionsOpened), LedgerLive],
      queries: [LedgerCountLive],
    }).pipe(Effect.provideService(Policies, policies));
    const principal = yield* makePrincipal(follows).pipe(
      Effect.provideService(ActorTransport, host),
    );
    const handler = yield* HttpServer.make({ principal }).pipe(
      Effect.provideService(ActorTransport, host),
    );
    // The plain-form route derives the same principal from the same cookie.
    // A refused anonymous post goes to `/login`; a refused member gets the page.
    const forms = yield* HttpServer.form({
      contracts: [Ledger],
      principal,
      login: Option.some(loginPath),
      render: (path) => Effect.succeed(`<main>refused: ${path}</main>`),
    }).pipe(Effect.provideService(ActorTransport, host));
    const context = yield* Effect.context<never>();
    const run = Effect.runPromiseWith(context);
    const route = (request: Request) => {
      if (new URL(request.url).pathname === formPath) {
        return forms(request);
      }
      return handler(request);
    };
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => Bun.serve({ port: 0, fetch: (request) => run(route(request)) })),
      (running) => Effect.promise(() => running.stop(true)),
    );
    const port = Option.getOrElse(Option.fromNullishOr(server.port), () => 0);
    const served: Served = {
      baseUrl: `http://127.0.0.1:${String(port)}`,
      host,
      sessionsOpened,
      follows,
    };
    return served;
  });

/** A browser that carries one cookie on every request, or none. */
export const browserFetch =
  (cookie: Option.Option<string>): HttpTransport.FetchLike =>
  (input, init) => {
    const headers = new Headers(
      Option.getOrElse(
        Option.flatMap(Option.fromNullishOr(init), (given) => Option.fromNullishOr(given.headers)),
        (): HeadersInit => [],
      ),
    );
    Option.map(cookie, (value) => headers.set("cookie", `${sessionCookie}${value}`));
    return fetch(input, { ...init, headers });
  };

/** The client transport of one browser against one served host. */
export const browser = (
  served: Served,
  cookie: Option.Option<string>,
  reconnect: HttpTransport.HttpClientOptions["reconnect"],
) =>
  HttpTransport.layer({ baseUrl: served.baseUrl, reconnect }).pipe(
    Layer.provide(Layer.succeed(HttpTransport.Fetch, browserFetch(cookie))),
  );

/** Runs `effect` as one browser: its own transport, its own cookie. */
export const asBrowser =
  (served: Served, cookie: Option.Option<string>, reconnect = HttpTransport.defaultReconnect) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(effect, browser(served, cookie, reconnect));
