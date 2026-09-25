/* oxlint-disable effect/noGlobals -- fetch and crypto are this test's platform boundary: a browser on a real socket. */
import {
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
  Schedule,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect";
import type { Scope } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "effect-bun-test";
import { Actor, ActorHost, HttpServer, Policies } from "effect-frame/actor";
import type {
  Address,
  Principal,
  PrincipalRevision,
  PrincipalSource,
  QueryEntry,
  TransportReadError,
  TransportService,
} from "effect-frame/actor/client";
import {
  ActorTransport,
  Anonymous,
  Authenticated,
  CommandId,
  CurrentPrincipal,
  Form,
  HttpTransport,
  Principal as Principals,
  QueryState,
  followQuery,
  QueryCache,
} from "effect-frame/actor/client";
import type { Served } from "./auth-fixture.js";
import {
  Entry,
  Ledger,
  LedgerCount,
  LedgerLive,
  Session,
  SessionEvent,
  anonymousPrincipal,
  asBrowser,
  browser,
  formPath,
  loginPath,
  policies,
  serveHost,
  sessionAddress,
  sessionLive,
  requestPrincipal,
  sessionPrincipal,
  snapshotPrincipal,
} from "./auth-fixture.js";

/**
 * Revocation on a live connection (#30). Every test runs a real Bun server
 * on a free port. A browser is the HTTP client transport with a fetch that
 * carries one session cookie. The session is an actor: every sign-out,
 * second sign-in, heartbeat, and expiry is a revision of it.
 */

const decodeCommandId = Schema.decodeEffect(CommandId);
const freshId = Effect.flatMap(
  Effect.sync(() => crypto.randomUUID()),
  (raw) => Effect.orDie(decodeCommandId(raw)),
);
const encodeSessionEvent = Schema.encodeEffect(Session.message);
const encodeLedgerKey = Schema.encodeEffect(Ledger.key);
const encodeEntry = Schema.encodeEffect(Ledger.message);

const book = { tenant: "acme", id: "book" };

const ledgerAddress = Effect.map(Effect.orDie(encodeLedgerKey(book)), (key): Address => ({
  contract: Ledger.name,
  version: Ledger.version,
  key,
}));

type SessionMessage = Schema.Schema.Type<typeof Session.message>;

/** One session command, sent the way a sign-in route sends it: through the host. */
const command = (served: Served, sessionId: string, event: SessionMessage) =>
  Effect.gen(function* () {
    const address = yield* sessionAddress(sessionId);
    const payload = yield* Effect.orDie(encodeSessionEvent(event));
    const commandId = yield* freshId;
    return yield* served.host.call(address, commandId, payload, "1 second", []);
  });

const signIn = (
  served: Served,
  sessionId: string,
  subject: string,
  tenants: ReadonlyArray<string>,
  expiresAt: number,
) => command(served, sessionId, SessionEvent.SignIn({ subject, claims: { tenants }, expiresAt }));

/** An expiry far past any test's clock. */
const never = 4_102_444_800_000;

/** The session's own clock: its committed revision. */
const sessionRevision = (served: Served, sessionId: string) =>
  Effect.flatMap(sessionAddress(sessionId), (address) =>
    Effect.map(served.host.snapshot(address), (projection) => projection.revision),
  );

const alice = Authenticated.make({ subject: "alice", claims: { tenants: ["acme"] } });

/** One ledger entry, sent under a principal the policy admits. */
const append = (served: Served, principal: Principal) =>
  Effect.gen(function* () {
    const address = yield* ledgerAddress;
    const payload = yield* Effect.orDie(encodeEntry({ _tag: "Entry", text: "line" }));
    const commandId = yield* freshId;
    return yield* served.host
      .call(address, commandId, payload, "1 second", [])
      .pipe(Effect.provideService(CurrentPrincipal, principal));
  });

interface Watcher {
  /** Succeeds with the failure that ended the stream. It never ends otherwise. */
  readonly ended: Fiber.Fiber<TransportReadError, void>;
  /** Every revision the browser received. */
  readonly revisions: Queue.Queue<number>;
}

const quickReconnect: Schedule.Schedule<unknown> = Schedule.spaced("20 millis");

/**
 * One browser watching the ledger. It returns once the first projection
 * arrived: the connection is open and was authorized.
 */
const watchWith = (
  served: Served,
  cookie: Option.Option<string>,
  reconnect: Schedule.Schedule<unknown>,
): Effect.Effect<Watcher, never, Scope.Scope> =>
  asBrowser(
    served,
    cookie,
    reconnect,
  )(
    Effect.gen(function* () {
      const transport = yield* ActorTransport;
      const address = yield* ledgerAddress;
      const revisions = yield* Queue.unbounded<number>();
      const ended = yield* Effect.forkScoped(
        Effect.flip(
          Stream.runForEach(transport.changes(address, -1), (projection) =>
            Queue.offer(revisions, projection.revision),
          ),
        ),
      );
      yield* Queue.take(revisions);
      const watcher: Watcher = { ended, revisions };
      return watcher;
    }),
  );

const watch = (served: Served, cookie: string) =>
  watchWith(served, Option.some(cookie), quickReconnect);

/** The failure a watcher ended with, by tag. */
const endedWith = (watcher: Watcher) =>
  Effect.map(Fiber.join(watcher.ended), (error) => error._tag);

/**
 * Moves the test clock one second at a time until `done` holds, and
 * answers how many seconds that took. Dies past `limit` seconds.
 */
const stepUntil = <E>(done: Effect.Effect<boolean, E>, limit: number): Effect.Effect<number, E> =>
  Effect.gen(function* () {
    for (let seconds = 0; seconds <= limit; seconds += 1) {
      // The commit runs on its own fiber after the move: give it live time.
      yield* TestClock.withLive(Effect.sleep("5 millis"));
      if (yield* done) {
        return seconds;
      }
      yield* TestClock.adjust("1 second");
    }
    return yield* Effect.die(`not done after ${String(limit)} test-clock seconds`);
  });

/** True while the watcher's stream is still open. */
const isOpen = (watcher: Watcher) =>
  Effect.sync(() => Option.isNone(Option.fromNullishOr(watcher.ended.pollUnsafe())));

describe("revocation on a live connection", () => {
  it.scopedLive(
    "a sign-out on the session actor ends the open changes stream with Unauthorized",
    () =>
      Effect.gen(function* () {
        const served = yield* serveHost(sessionPrincipal);
        yield* signIn(served, "s1", "alice", ["acme"], never);
        const laptop = yield* watch(served, "s1");
        const phone = yield* watch(served, "s1");

        yield* command(served, "s1", SessionEvent.SignOut);

        expect(yield* endedWith(laptop)).toBe("Unauthorized");
        expect(yield* endedWith(phone)).toBe("Unauthorized");
      }),
  );

  it.scopedLive(
    "a session that changes subject ends the stream rather than re-authorizing it",
    () =>
      Effect.gen(function* () {
        const served = yield* serveHost(sessionPrincipal);
        yield* signIn(served, "s1", "alice", ["acme"], never);
        const open = yield* watch(served, "s1");

        // Bob may read this ledger too. The stream still ends: it was
        // authorized for alice, and nobody authorized it for bob.
        yield* signIn(served, "s1", "bob", ["acme"], never);
        expect(yield* endedWith(open)).toBe("Unauthorized");

        // Bob's own connection is authorized afresh, through the same door.
        const fresh = yield* watch(served, "s1");
        expect(yield* isOpen(fresh)).toBe(true);
      }),
  );

  it.scopedLive("a Touch that only slides expiresAt publishes a revision and ends no stream", () =>
    Effect.gen(function* () {
      const served = yield* serveHost(sessionPrincipal);
      yield* signIn(served, "s1", "alice", ["acme"], never - 1);
      const first = yield* watch(served, "s1");
      const second = yield* watch(served, "s1");
      const before = yield* sessionRevision(served, "s1");

      yield* command(served, "s1", SessionEvent.Touch({ expiresAt: never }));

      expect(yield* sessionRevision(served, "s1")).toBe(before + 1);
      // Both connections still carry the ledger's next revision.
      const applied = yield* append(served, alice);
      expect(yield* Queue.take(first.revisions)).toBe(applied.projection.revision);
      expect(yield* Queue.take(second.revisions)).toBe(applied.projection.revision);
      expect(yield* isOpen(first)).toBe(true);
      expect(yield* isOpen(second)).toBe(true);
    }),
  );

  it.scoped("a session machine commits Empty at expiresAt and the watching stream ends", () =>
    Effect.gen(function* () {
      // The test clock reaches the host: the session machine's sleep is the
      // only timer on it, and it moves only when the test moves the clock.
      // The browsers keep the live clock, so a dropped connection's
      // reconnect delay still passes.
      const served = yield* serveHost(sessionPrincipal);
      yield* signIn(served, "s1", "alice", ["acme"], 60_000);
      const first = yield* TestClock.withLive(watch(served, "s1"));
      const second = yield* TestClock.withLive(watch(served, "s1"));
      const signedIn = yield* sessionRevision(served, "s1");

      yield* TestClock.adjust("59 seconds");
      expect(yield* sessionRevision(served, "s1")).toBe(signedIn);
      expect(yield* isOpen(first)).toBe(true);
      expect(yield* isOpen(second)).toBe(true);

      // The machine's timer reads the clock, then registers its sleep one
      // step later. A move that lands between the two registers the sleep
      // past the move, so it wakes late; it never wakes early (the 59-second
      // check above). Step the clock until the session commits, within the
      // time the test already moved it (59 + 1 seconds) and the steps taken
      // while the sleep was not yet registered.
      yield* TestClock.adjust("1 second");
      yield* stepUntil(
        Effect.map(sessionRevision(served, "s1"), (revision) => revision > signedIn),
        120,
      );
      expect(yield* endedWith(first)).toBe("Unauthorized");
      expect(yield* endedWith(second)).toBe("Unauthorized");
      // One revision, Empty, committed by the session's own machine.
      expect(yield* sessionRevision(served, "s1")).toBe(signedIn + 1);
    }),
  );

  it.scopedLive("ten connections on one session hold one session subscription", () =>
    Effect.gen(function* () {
      const served = yield* serveHost(sessionPrincipal);
      yield* signIn(served, "s1", "alice", ["acme"], never);

      yield* Effect.scoped(
        Effect.gen(function* () {
          // Ten browsers connect at once, not one after another.
          const watchers = yield* Effect.forEach(
            Array.from({ length: 10 }),
            () => watch(served, "s1"),
            { concurrency: 10 },
          );
          expect(yield* Ref.get(served.follows.opened)).toBe(1);
          expect(yield* Ref.get(served.follows.active)).toBe(1);
          expect(yield* Ref.get(served.sessionsOpened)).toBe(1);
          const open = yield* Effect.forEach(watchers, isOpen);
          expect(open).toEqual(Array.from({ length: 10 }, () => true));
        }),
      );

      // The last connection closed, so the shared subscription is released.
      yield* Effect.repeat(Ref.get(served.follows.active), {
        until: (active) => active === 0,
        schedule: Schedule.spaced("10 millis"),
        times: 300,
      });
      expect(yield* Ref.get(served.follows.active)).toBe(0);

      // One sign-out still ends every connection on the session.
      const again = yield* Effect.forEach(Array.from({ length: 3 }), () => watch(served, "s1"), {
        concurrency: 3,
      });
      yield* command(served, "s1", SessionEvent.SignOut);
      const ended = yield* Effect.forEach(again, endedWith);
      expect(ended).toEqual(["Unauthorized", "Unauthorized", "Unauthorized"]);
      expect(yield* Ref.get(served.sessionsOpened)).toBe(1);
    }),
  );

  it.scopedLive("a change and a change back before the watch starts still ends the stream", () =>
    Effect.gen(function* () {
      // The session goes alice -> bob -> alice at the moment the connection
      // first learns who it serves. A watch that subscribes after that read
      // sees alice again and nothing else; one continuous subscription sees
      // bob in between, and ends.
      const bob = Authenticated.make({ subject: "bob", claims: { tenants: ["acme"] } });
      const current = yield* SubscriptionRef.make<Principal>(alice);
      const flipped = yield* Ref.make(false);
      const flip = Effect.flatMap(Ref.getAndSet(flipped, true), (done) => {
        if (done) {
          return Effect.void;
        }
        return Effect.andThen(
          SubscriptionRef.set(current, bob),
          SubscriptionRef.set(current, alice),
        );
      });
      const source: PrincipalSource = Principals.fromSource({
        get: Effect.tap(SubscriptionRef.get(current), () => flip),
        changes: Stream.tap(SubscriptionRef.changes(current), () => flip),
      });
      const served = yield* serveHost(() => Effect.succeed(() => Effect.succeed(source)));

      const ended = yield* asBrowser(
        served,
        Option.none(),
        quickReconnect,
      )(
        Effect.flatMap(ActorTransport, (transport) =>
          Effect.flatMap(ledgerAddress, (address) =>
            Effect.timeoutOption(
              Effect.flip(Stream.runDrain(transport.changes(address, -1))),
              "3 seconds",
            ),
          ),
        ),
      );
      expect(Option.map(ended, (error) => error._tag)).toEqual(Option.some("Unauthorized"));
    }),
  );

  it.scopedLive(
    "`HttpServer.anonymous` opens no session subscription and never ends a stream",
    () =>
      Effect.gen(function* () {
        // The anonymous source is its one value and then the end: nothing to follow.
        const followed = yield* Stream.runCollect(Principals.anonymous.changes);
        expect(followed).toEqual([{ principal: Anonymous.make({}), revision: 0 }]);

        const served = yield* serveHost(anonymousPrincipal);
        yield* signIn(served, "watched", "alice", ["acme"], never);
        const opened = yield* Ref.get(served.sessionsOpened);

        // A browser that carries a session cookie, served by a host that
        // derives nobody from it. It watches a session it may read.
        const revisions = yield* asBrowser(
          served,
          Option.some("s-cookie"),
          quickReconnect,
        )(
          Effect.gen(function* () {
            const transport = yield* ActorTransport;
            const address = yield* sessionAddress("watched");
            const seen = yield* Queue.unbounded<number>();
            yield* Effect.forkScoped(
              Stream.runForEach(transport.changes(address, -1), (projection) =>
                Queue.offer(seen, projection.revision),
              ),
            );
            yield* Queue.take(seen);
            return seen;
          }),
        );

        for (let turn = 0; turn < 3; turn += 1) {
          yield* command(served, "watched", SessionEvent.SignOut);
          yield* signIn(served, "watched", "alice", ["acme"], never);
        }
        const received = yield* Effect.forEach(Array.from({ length: 6 }), () =>
          Queue.take(revisions),
        );
        expect(received).toHaveLength(6);
        // The cookie's session was never opened: nothing derived a principal from it.
        expect(yield* Ref.get(served.sessionsOpened)).toBe(opened);
      }),
  );

  it.scopedLive(
    "the client fails fast on Unauthorized rather than exhausting the reconnect schedule",
    () =>
      Effect.gen(function* () {
        const served = yield* serveHost(sessionPrincipal);
        yield* signIn(served, "s1", "alice", ["acme"], never);
        // A schedule whose first retry waits an hour. Entering it once would
        // hold the failure far past the bound below.
        const patient = Schedule.spaced("1 hour");
        const open = yield* watchWith(served, Option.some("s1"), patient);

        yield* command(served, "s1", SessionEvent.SignOut);

        const ended = yield* Effect.timeoutOption(endedWith(open), "3 seconds");
        expect(ended).toEqual(Option.some("Unauthorized"));

        // Connecting again with the revoked cookie is refused at once, too.
        const again = yield* asBrowser(
          served,
          Option.some("s1"),
          patient,
        )(
          Effect.flatMap(ActorTransport, (transport) =>
            Effect.flatMap(ledgerAddress, (address) =>
              Effect.timeoutOption(
                Effect.flip(Stream.runDrain(transport.changes(address, -1))),
                "3 seconds",
              ),
            ),
          ),
        );
        expect(Option.map(again, (error) => error._tag)).toEqual(Option.some("Unauthorized"));
      }),
  );
});

/** Holds a connection's first revision until `gate` opens, so it falls behind. */
const fallBehind = (
  source: PrincipalSource,
  holding: Deferred.Deferred<void>,
  gate: Deferred.Deferred<void>,
): PrincipalSource => ({
  get: source.get,
  changes: Stream.tap(source.changes, (current) => {
    if (current.revision === 0) {
      return Effect.andThen(Deferred.succeed(holding, void 0), Deferred.await(gate));
    }
    return Effect.void;
  }),
});

/** A fast follower of one shared session: it returns once it saw `revision`. */
const seenBy = (source: PrincipalSource) =>
  Effect.gen(function* () {
    const seen = yield* Queue.unbounded<PrincipalRevision>();
    yield* Effect.forkScoped(Stream.runForEach(source.changes, (next) => Queue.offer(seen, next)));
    yield* Queue.take(seen);
    return (revision: number) =>
      Effect.repeat(Queue.take(seen), { until: (next) => next.revision >= revision });
  });

const signedIn = (subject: string): Principal =>
  Authenticated.make({ subject, claims: { tenants: ["acme"] } });

describe("a shared session subscription is bounded", () => {
  it.scopedLive("a connection that falls behind holds the latest revision, not a queue", () =>
    Effect.gen(function* () {
      const current = yield* SubscriptionRef.make<Principal>(signedIn("user-0"));
      const sessions = yield* HttpServer.shareSessions({
        read: (_key: string) => SubscriptionRef.get(current),
        follow: (_key: string) => SubscriptionRef.changes(current),
      });
      const fast = yield* seenBy(sessions("s1"));
      const holding = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const slow = yield* Effect.forkScoped(
        fallBehind(sessions("s1"), holding, gate).changes.pipe(
          Stream.takeUntil((next) => next.revision === 100),
          Stream.runCollect,
        ),
      );
      yield* Deferred.await(holding);

      // A hundred changes while the slow connection holds its first revision.
      for (let turn = 1; turn <= 100; turn += 1) {
        yield* SubscriptionRef.set(current, signedIn(`user-${String(turn)}`));
      }
      yield* fast(100);
      yield* Deferred.succeed(gate, void 0);

      // It kept one pending revision, the newest, and dropped the rest.
      const seen = yield* Effect.timeoutOption(Fiber.join(slow), "3 seconds");
      expect(Option.map(seen, (all) => all.map((next) => next.revision))).toEqual(
        Option.some([0, 100]),
      );
    }),
  );

  it.scopedLive("A, B, A through a connection that skipped B still ends the stream", () =>
    Effect.gen(function* () {
      const current = yield* SubscriptionRef.make<Principal>(alice);
      const sessions = yield* HttpServer.shareSessions({
        read: (_key: string) => SubscriptionRef.get(current),
        follow: (_key: string) => SubscriptionRef.changes(current),
      });
      const fast = yield* seenBy(sessions("s1"));
      const holding = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const slow = fallBehind(sessions("s1"), holding, gate);
      const served = yield* serveHost(() => Effect.succeed(() => Effect.succeed(slow)));

      const ended = yield* asBrowser(
        served,
        Option.none(),
        quickReconnect,
      )(
        Effect.gen(function* () {
          const transport = yield* ActorTransport;
          const address = yield* ledgerAddress;
          const watching = yield* Effect.forkScoped(
            Effect.timeoutOption(
              Effect.flip(Stream.runDrain(transport.changes(address, -1))),
              "3 seconds",
            ),
          );
          // The server read alice and holds her revision; bob comes and goes
          // before the connection reads again, and the buffer keeps only the
          // newest revision: alice, numbered 2.
          yield* Deferred.await(holding);
          yield* SubscriptionRef.set(current, signedIn("bob"));
          yield* SubscriptionRef.set(current, alice);
          yield* fast(2);
          yield* Deferred.succeed(gate, void 0);
          return yield* Fiber.join(watching);
        }),
      );
      expect(Option.map(ended, (error) => error._tag)).toEqual(Option.some("Unauthorized"));
    }),
  );
});

/** A browser with no script: a form post, redirects left unfollowed. */
const postForm = (served: Served, cookie: string) =>
  Effect.gen(function* () {
    const commandId = yield* freshId;
    const key = yield* Form.encodeKey(Ledger, book);
    const body = Form.toBody(
      Form.fromEntries([
        ["$command", commandId],
        ["$contract", Ledger.name],
        ["$version", String(Ledger.version)],
        ["$key", key],
        ["$return", "/ledger"],
        ["$form", "Entry"],
        ["_tag", "Entry"],
        ["text", "hello"],
      ]),
    );
    const response = yield* Effect.promise(() =>
      fetch(`${served.baseUrl}${formPath}`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `session=${cookie}`,
        },
        body,
        redirect: "manual",
      }),
    );
    const text = yield* Effect.promise(() => response.text());
    return {
      status: response.status,
      location: Option.getOrElse(Option.fromNullishOr(response.headers.get("location")), () => ""),
      text,
    };
  });

describe("a refused navigation", () => {
  it.scopedLive("a revoked navigation lands on login, a refused one does not", () =>
    Effect.gen(function* () {
      const served = yield* serveHost(sessionPrincipal);
      yield* signIn(served, "alice-session", "alice", ["acme"], never);
      yield* signIn(served, "carol-session", "carol", ["other"], never);

      const allowed = yield* postForm(served, "alice-session");
      expect(allowed.status).toBe(303);
      expect(allowed.location).toBe("/ledger");

      // Alice signs out. Her cookie now derives Anonymous: signing in again
      // would change the answer, so the post goes to the login route.
      yield* command(served, "alice-session", SessionEvent.SignOut);
      const revoked = yield* postForm(served, "alice-session");
      expect(revoked.status).toBe(303);
      expect(revoked.location).toBe(`${loginPath}?next=%2Fledger`);

      // Carol is signed in and refused. A login page would be a lie.
      const refused = yield* postForm(served, "carol-session");
      expect(refused.status).toBe(403);
      expect(refused.location).toBe("");
      expect(refused.text).toContain("refused: /ledger");
    }),
  );
});

/** The first state of an entry that passes `pass`, or none within three seconds. */
const firstState = <A, E>(entry: QueryEntry<A, E>, pass: (state: QueryState<A, E>) => boolean) =>
  Effect.timeoutOption(Stream.runHead(Stream.filter(entry.state.changes, pass)), "3 seconds");

/** Runs `effect` with a client query cache beside its transport. */
const withQueryCache = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  // @effect-diagnostics-next-line strictEffectProvide:off
  Effect.provide(effect, QueryCache.layer);

describe("a client cache across a principal change", () => {
  it.scopedLive(
    "a revoked stream drops every query value the client read under that principal",
    () =>
      Effect.gen(function* () {
        const served = yield* serveHost(sessionPrincipal);
        yield* signIn(served, "s1", "alice", ["acme"], never);

        const seen = yield* asBrowser(
          served,
          Option.some("s1"),
          quickReconnect,
        )(
          Effect.gen(function* () {
            const entry = yield* QueryCache.use((cache) =>
              cache.open(LedgerCount, { tenant: "acme" }),
            );
            const read = yield* firstState(entry, QueryState.isReady);
            // Every state the entry shows from here until the refusal lands.
            const watching = yield* Deferred.make<void>();
            const shown = yield* Effect.forkScoped(
              entry.state.changes.pipe(
                Stream.tap(() => Deferred.succeed(watching, void 0)),
                Stream.drop(1),
                Stream.takeUntil(QueryState.isFailed),
                Stream.runCollect,
              ),
            );
            yield* Deferred.await(watching);
            // A live actor reference: the client's view of the session's validity.
            yield* Actor.remote(Ledger, book);

            yield* command(served, "s1", SessionEvent.SignOut);

            // The reference's stream ends with Unauthorized, and the cache
            // forgets alice's value. It reads again, and the read is refused.
            // Alice's value never shows in between, not even as stale.
            const states = yield* Effect.timeoutOption(Fiber.join(shown), "3 seconds");
            const refused = Option.flatMap(states, (all) => Option.fromNullishOr(all.at(-1)));
            const readyAfter = Option.map(states, (all) => all.filter(QueryState.isReady).length);
            // A later declaration of the same key never shows alice's value.
            const later = yield* QueryCache.use((cache) =>
              cache.open(LedgerCount, { tenant: "acme" }),
            );
            const laterState = yield* later.state.get;
            return { read, refused, readyAfter, laterState };
          }).pipe(withQueryCache),
        );

        expect(Option.map(Option.flatten(seen.read), (state) => state._tag)).toEqual(
          Option.some("Ready"),
        );
        const refused = seen.refused;
        expect(seen.readyAfter).toEqual(Option.some(0));
        expect(
          Option.map(refused, (state) => {
            if (state._tag === "Failed") {
              return state.error._tag;
            }
            return state._tag;
          }),
        ).toEqual(Option.some("Unauthorized"));
        expect(seen.laterState._tag).not.toBe("Ready");
      }),
  );
});

/**
 * A browser whose command replies wait for `gate` after they arrive: the
 * reply is on the client, and it has not landed yet.
 */
const gatedBrowser = (
  served: Served,
  cookie: string,
  replied: Deferred.Deferred<void>,
  gate: Deferred.Deferred<void>,
) =>
  Layer.effect(
    ActorTransport,
    Effect.map(ActorTransport, (inner): TransportService => ({
      ...inner,
      call: (address, commandId, payload, deadline, active) =>
        inner.call(address, commandId, payload, deadline, active).pipe(
          Effect.tap(() => Deferred.succeed(replied, void 0)),
          Effect.tap(() => Deferred.await(gate)),
        ),
    })),
  ).pipe(Layer.provide(browser(served, Option.some(cookie), quickReconnect)));

/**
 * A browser whose next query read, once `armed`, waits for `gate` after its
 * answer arrives: a read in flight that the server already answered.
 */
const heldReadBrowser = (
  served: Served,
  cookie: string,
  armed: Ref.Ref<boolean>,
  answered: Deferred.Deferred<void>,
  gate: Deferred.Deferred<void>,
) => {
  const hold = Effect.flatMap(Ref.getAndSet(armed, false), (held) => {
    if (held) {
      return Effect.andThen(Deferred.succeed(answered, void 0), Deferred.await(gate));
    }
    return Effect.void;
  });
  return Layer.effect(
    ActorTransport,
    Effect.map(ActorTransport, (inner): TransportService => ({
      ...inner,
      query: (key) => Effect.tap(inner.query(key), () => hold),
      queryBatch: (keys) => Effect.tap(inner.queryBatch(keys), () => hold),
    })),
  ).pipe(Layer.provide(browser(served, Option.some(cookie), quickReconnect)));
};

/** Runs `effect` as that browser. */
const asHeldReadBrowser =
  (
    served: Served,
    cookie: string,
    armed: Ref.Ref<boolean>,
    answered: Deferred.Deferred<void>,
    gate: Deferred.Deferred<void>,
  ) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(effect, heldReadBrowser(served, cookie, armed, answered, gate));

/** Runs `effect` as that browser. */
const asGatedBrowser =
  (
    served: Served,
    cookie: string,
    replied: Deferred.Deferred<void>,
    gate: Deferred.Deferred<void>,
  ) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(effect, gatedBrowser(served, cookie, replied, gate));

/** Every state a source shows after its current one, until it fails. */
const statesUntilFailed = <A, E>(changes: Stream.Stream<QueryState<A, E>>) =>
  Effect.gen(function* () {
    const watching = yield* Deferred.make<void>();
    const shown = yield* Effect.forkScoped(
      changes.pipe(
        Stream.tap(() => Deferred.succeed(watching, void 0)),
        Stream.drop(1),
        Stream.takeUntil(QueryState.isFailed),
        Stream.runCollect,
      ),
    );
    yield* Deferred.await(watching);
    return shown;
  });

/** What a recording saw, if it ended within three seconds. */
const recordedWithin = <A, E>(recording: Fiber.Fiber<ReadonlyArray<QueryState<A, E>>>) =>
  Effect.timeoutOption(Fiber.join(recording), "3 seconds");

/** How many Ready states a recording holds, if it ended in time. */
const readyCount = <A, E>(states: Option.Option<ReadonlyArray<QueryState<A, E>>>) =>
  Option.map(states, (all) => all.filter(QueryState.isReady).length);

/**
 * How many Ready states a recording holds after the entry forgot its value,
 * if it ended in time. Before the refusal arrives, the client cannot know.
 */
const readyAfterForget = <A, E>(states: Option.Option<ReadonlyArray<QueryState<A, E>>>) =>
  Option.map(states, (all) => {
    const forgotten = all.findIndex(QueryState.isLoading);
    if (forgotten < 0) {
      return all.length;
    }
    return all.slice(forgotten).filter(QueryState.isReady).length;
  });

/** The tag a recording ended with, if it ended in time. */
const lastTag = <A, E>(states: Option.Option<ReadonlyArray<QueryState<A, E>>>) =>
  Option.map(
    Option.flatMap(states, (all) => Option.fromNullishOr(all.at(-1))),
    (state) => state._tag,
  );

describe("every refusal the client receives", () => {
  it.scopedLive("a query-only client drops its values on an Unauthorized query read", () =>
    Effect.gen(function* () {
      const served = yield* serveHost(sessionPrincipal);
      yield* signIn(served, "s1", "alice", ["acme", "north"], never);

      const seen = yield* asBrowser(
        served,
        Option.some("s1"),
        quickReconnect,
      )(
        Effect.gen(function* () {
          const acme = yield* QueryCache.use((cache) =>
            cache.open(LedgerCount, { tenant: "acme" }),
          );
          const north = yield* QueryCache.use((cache) =>
            cache.open(LedgerCount, { tenant: "north" }),
          );
          yield* firstState(acme, QueryState.isReady);
          yield* firstState(north, QueryState.isReady);
          const recorded = yield* statesUntilFailed(north.state.changes);

          // No reference watches anything. The only news is one refused read.
          yield* command(served, "s1", SessionEvent.SignOut);
          yield* acme.refresh;

          return yield* recordedWithin(recorded);
        }).pipe(withQueryCache),
      );

      // The other entry was read for alice too. It never shows her value
      // again, and its own read under the new principal is refused.
      expect(seen.pipe(readyCount)).toEqual(Option.some(0));
      expect(seen.pipe(lastTag)).toEqual(Option.some("Failed"));
    }),
  );

  it.scopedLive("followQuery shows no old value after a principal change", () =>
    Effect.gen(function* () {
      const served = yield* serveHost(sessionPrincipal);
      yield* signIn(served, "s1", "alice", ["acme"], never);

      const seen = yield* asBrowser(
        served,
        Option.some("s1"),
        quickReconnect,
      )(
        Effect.gen(function* () {
          const tenant = Option.some({ tenant: "acme" });
          const followed = yield* followQuery(LedgerCount, {
            get: Effect.succeed(tenant),
            changes: Stream.succeed(tenant),
          });
          yield* Effect.timeoutOption(
            Stream.runHead(Stream.filter(followed.state.changes, QueryState.isReady)),
            "3 seconds",
          );
          const recorded = yield* statesUntilFailed(followed.state.changes);
          yield* Actor.remote(Ledger, book);

          yield* command(served, "s1", SessionEvent.SignOut);

          return yield* recordedWithin(recorded);
        }).pipe(withQueryCache),
      );

      // The entry forgot alice's value. The followed state never carries it
      // over as stale: that value was read for somebody else.
      expect(seen.pipe(readyCount)).toEqual(Option.some(0));
      expect(seen.pipe(lastTag)).toEqual(Option.some("Failed"));
    }),
  );

  it.scopedLive("a command reply that settles after the change does not land", () =>
    Effect.gen(function* () {
      const served = yield* serveHost(sessionPrincipal);
      yield* signIn(served, "s1", "alice", ["acme"], never);
      const replied = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();

      const final = yield* asGatedBrowser(
        served,
        "s1",
        replied,
        gate,
      )(
        Effect.gen(function* () {
          const count = yield* QueryCache.use((cache) =>
            cache.open(LedgerCount, { tenant: "acme" }),
          );
          yield* firstState(count, QueryState.isReady);
          const ledger = yield* Actor.remote(Ledger, book);
          // The reply carries the count read for alice after her entry.
          const sent = yield* Effect.forkScoped(
            Effect.exit(ledger.call(Entry.make({ text: "line" }), { timeout: "5 seconds" })),
          );
          yield* Deferred.await(replied);

          yield* command(served, "s1", SessionEvent.SignOut);
          yield* firstState(count, QueryState.isFailed);

          yield* Deferred.succeed(gate, void 0);
          yield* Fiber.join(sent);
          return yield* count.state.get;
        }).pipe(withQueryCache),
      );

      expect(final._tag).toBe("Failed");
    }),
  );

  it.scopedLive("a read in flight across a principal change does not land", () =>
    Effect.gen(function* () {
      const served = yield* serveHost(sessionPrincipal);
      yield* signIn(served, "s1", "alice", ["acme"], never);
      const armed = yield* Ref.make(false);
      const answered = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();

      const seen = yield* asHeldReadBrowser(
        served,
        "s1",
        armed,
        answered,
        gate,
      )(
        Effect.gen(function* () {
          const count = yield* QueryCache.use((cache) =>
            cache.open(LedgerCount, { tenant: "acme" }),
          );
          yield* firstState(count, QueryState.isReady);
          yield* Actor.remote(Ledger, book);
          const recorded = yield* statesUntilFailed(count.state.changes);

          // The server answers a read for alice; the answer is on the client.
          yield* Ref.set(armed, true);
          yield* Effect.forkScoped(count.refresh);
          yield* Deferred.await(answered);

          // Alice signs out, the reference's stream ends, and the entry forgets.
          yield* command(served, "s1", SessionEvent.SignOut);
          yield* firstState(count, QueryState.isLoading);
          yield* Deferred.succeed(gate, void 0);

          return yield* recordedWithin(recorded);
        }).pipe(withQueryCache),
      );

      // Alice's answer arrives after the entry forgot her. It never shows.
      expect(seen.pipe(readyAfterForget)).toEqual(Option.some(0));
      expect(seen.pipe(lastTag)).toEqual(Option.some("Failed"));
    }),
  );

  it.scopedLive("a refused command drops every value read under the principal", () =>
    Effect.gen(function* () {
      // Each request reads the session once, so no open stream ever ends:
      // the refused command is the only news.
      const served = yield* serveHost(requestPrincipal);
      yield* signIn(served, "s1", "alice", ["acme"], never);

      const seen = yield* asBrowser(
        served,
        Option.some("s1"),
        quickReconnect,
      )(
        Effect.gen(function* () {
          const count = yield* QueryCache.use((cache) =>
            cache.open(LedgerCount, { tenant: "acme" }),
          );
          yield* firstState(count, QueryState.isReady);
          const ledger = yield* Actor.remote(Ledger, book);
          const recorded = yield* statesUntilFailed(count.state.changes);

          yield* command(served, "s1", SessionEvent.SignOut);
          const refused = yield* Effect.flip(
            ledger.call(Entry.make({ text: "line" }), { timeout: "1 second" }),
          );

          return { refused: refused._tag, states: yield* recordedWithin(recorded) };
        }).pipe(withQueryCache),
      );

      expect(seen.refused).toBe("Unauthorized");
      // Alice's value shows stale while her command is in flight. Once the
      // refusal arrives, it is gone and never comes back.
      expect(seen.states.pipe(readyAfterForget)).toEqual(Option.some(0));
      expect(seen.states.pipe(lastTag)).toEqual(Option.some("Failed"));
    }),
  );

  it.scopedLive("a key the principal was never granted is refused and drops nothing", () =>
    Effect.gen(function* () {
      const served = yield* serveHost(sessionPrincipal);
      yield* signIn(served, "s1", "carol", ["north"], never);

      const moved = yield* asBrowser(
        served,
        Option.some("s1"),
        quickReconnect,
      )(
        Effect.gen(function* () {
          const north = yield* QueryCache.use((cache) =>
            cache.open(LedgerCount, { tenant: "north" }),
          );
          const acme = yield* QueryCache.use((cache) =>
            cache.open(LedgerCount, { tenant: "acme" }),
          );
          yield* firstState(north, QueryState.isReady);
          yield* firstState(acme, QueryState.isFailed);

          // Asking again is the same answer for the same principal. It is
          // not news that the principal changed, so nothing is forgotten
          // and nothing reads again on its own.
          yield* acme.refresh;
          return yield* Effect.timeoutOption(
            Stream.runHead(
              Stream.filter(north.state.changes, (state) => !QueryState.isReady(state)),
            ),
            "300 millis",
          );
        }).pipe(withQueryCache),
      );

      expect(Option.flatten(moved)).toEqual(Option.none());
    }),
  );
});

interface WebAdapter {
  readonly fetch: (request: Request) => Promise<Response>;
}

/** A client of one web handler, in process, carrying one session cookie or none. */
const adapterClient = (web: WebAdapter, cookie: Option.Option<string>) =>
  HttpTransport.layer({ baseUrl: "http://adapter.test", reconnect: quickReconnect }).pipe(
    Layer.provide(
      Layer.succeed(HttpTransport.Fetch, (input, init) => {
        const request = new Request(input, init);
        Option.map(cookie, (value) => request.headers.set("cookie", `session=${value}`));
        return web.fetch(request);
      }),
    ),
  );

/** Runs `effect` as that client. */
const throughAdapter =
  (web: WebAdapter, cookie: Option.Option<string>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(effect, adapterClient(web, cookie));

describe("an adapter keeps its derivation's requirements", () => {
  it.scopedLive("toWebHandler serves a derivation that reads sessions through its own host", () =>
    Effect.gen(function* () {
      const opened = yield* Ref.make(0);
      const host = ActorHost.layer({
        implementations: [sessionLive(opened), LedgerLive],
        store: ActorHost.memoryStore,
      }).pipe(Layer.provide(Layer.succeed(Policies, Policies.of(policies))));
      // The derivation needs `ActorTransport`; the adapter supplies it from its own layer.
      const web = yield* Effect.acquireRelease(
        Effect.sync(() => HttpServer.toWebHandler(host, { principal: snapshotPrincipal })),
        (running) => Effect.promise(() => running.dispose()),
      );
      const session = yield* Actor.remote(Session, { sessionId: "s1" }).pipe(
        throughAdapter(web, Option.none()),
      );
      yield* session.call(
        SessionEvent.SignIn({ subject: "alice", claims: { tenants: ["acme"] }, expiresAt: never }),
        {
          timeout: "1 second",
        },
      );

      const member = yield* Effect.result(
        Actor.remote(Ledger, book).pipe(throughAdapter(web, Option.some("s1"))),
      );
      const stranger = yield* Effect.flip(
        Actor.remote(Ledger, book).pipe(throughAdapter(web, Option.none())),
      );
      expect(member._tag).toBe("Success");
      expect(stranger._tag).toBe("Unauthorized");
    }),
  );
});
