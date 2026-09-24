import { Duration, Effect, Layer, ManagedRuntime, Option, Result, Schema } from "effect";
import type {
  ActorTransport,
  AnyImplementation,
  Policies,
  PolicyNamesMissing,
} from "effect-frame/actor";
import { ActorHost, DurableHostConfig, HttpServer } from "effect-frame/actor";
import type { Address } from "effect-frame/actor/client";
import * as Interop from "./interop.js";
import type { DurableObjectContext } from "./durable-object.js";
import type { DurableStorage, SqlRow } from "./storage.js";
import * as StorageStore from "./storage-store.js";

/**
 * The generic actor host inside one Durable Object.
 *
 * One object holds one actor instance: the worker routes one (contract,
 * version, key) to one object, so the mailbox store ignores the address and
 * uses the object's own storage. The class serves the generic actor wire
 * (`/send`, `/call`, `/snapshot`, `/changes`), so the ordinary HTTP client
 * talks to it with no host-specific code.
 *
 * `alarm()` is the wake with no client request. The first request records the
 * address it served; the alarm reads that row back and opens the instance
 * again. Opening restores the committed state, drains pending commands, and
 * re-enters machine work, because the instance runs the same durable actor a
 * client request would have started. A command's admission arms the alarm,
 * and so does a commit whose state names a wake (`Behavior.wakeAt`), so a
 * machine deadline fires with no client attached.
 */

/** The one row that remembers which actor this object hosts. */
const addressSchema = `CREATE TABLE IF NOT EXISTS hosted_address (
   id INTEGER PRIMARY KEY CHECK (id = 1),
   contract TEXT,
   version INTEGER,
   key TEXT
 )`;

const readAddress = (storage: DurableStorage): Option.Option<Address> =>
  Option.flatMap(
    Interop.firstRow(
      Interop.exec(storage.sql, "SELECT contract, version, key FROM hosted_address WHERE id = 1"),
    ),
    toAddress,
  );

const toAddress = (row: SqlRow): Option.Option<Address> =>
  Option.all({
    contract: Interop.stringColumn(row, "contract"),
    version: Interop.numberColumn(row, "version"),
    key: Interop.stringColumn(row, "key"),
  });

const writeAddress = (storage: DurableStorage, address: Address): void => {
  Interop.exec(
    storage.sql,
    `INSERT INTO hosted_address (id, contract, version, key) VALUES (1, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET contract = excluded.contract,
         version = excluded.version, key = excluded.key`,
    address.contract,
    address.version,
    address.key,
  );
};

/**
 * Every generic verb names its address: the POST verbs carry it in the JSON
 * body, `changes` carries it in the query string. The object records what it
 * last served, so the alarm knows which actor to open.
 */
const Envelope = Schema.Struct({
  address: Schema.Struct({
    contract: Schema.String,
    version: Schema.Finite,
    key: Schema.String,
  }),
});

const decodeEnvelope = Schema.decodeUnknownOption(Envelope);

const addressFromBody = (body: unknown): Option.Option<Address> =>
  Option.map(decodeEnvelope(body), (envelope) => envelope.address);

const addressFromQuery = (url: URL): Option.Option<Address> =>
  Option.flatMap(
    Option.all({
      contract: Option.fromNullishOr(url.searchParams.get("contract")),
      version: Option.fromNullishOr(url.searchParams.get("version")),
      key: Option.fromNullishOr(url.searchParams.get("key")),
    }),
    (query) =>
      Option.map(decodeVersion(Number(query.version)), (version) => ({
        contract: query.contract,
        version,
        key: query.key,
      })),
  );

/** The wire sends the version as a decimal string; `Finite` rejects a NaN. */
const decodeVersion = Schema.decodeUnknownOption(Schema.Finite);

const addressOf = (body: unknown, url: URL): Option.Option<Address> =>
  Option.orElse(addressFromBody(body), () => addressFromQuery(url));

export interface FrameHostOptions<R> {
  readonly implementations: ReadonlyArray<AnyImplementation<R>>;
  /**
   * The services the implementations need, and the `Policies` table every
   * host requires (#20). There is no default table: an object whose
   * contracts name a policy this table does not hold fails its first
   * request with `PolicyNamesMissing`, because a Durable Object constructor
   * cannot fail asynchronously.
   */
  readonly layer: Layer.Layer<R | Policies>;
  /**
   * Derives who is asking from each request, as `HttpServer.make` does. An
   * object with no sessions writes `principal: HttpServer.anonymous`. It
   * runs in the object's runtime, so it may read the host's
   * `ActorTransport` and any service `layer` provides.
   */
  readonly principal: HttpServer.DerivePrincipal<ActorTransport | R | Policies>;
  /** How long `call` sleeps between receipt polls. A durable store polls fast. */
  readonly pollInterval: Option.Option<Duration.Input>;
  /**
   * How long one alarm holds the object while work is due (#101 §5). Work
   * still due at the end arms the next alarm at once. `None` is 30 seconds,
   * well inside the runtime's limit for one alarm. A value outside one poll
   * step to ten minutes is clamped to that range, so one alarm always ends
   * inside Cloudflare's 15-minute limit for an alarm handler.
   */
  readonly alarmHold: Option.Option<Duration.Input>;
}

/** What a Durable Object class must expose to celld and Cloudflare. */
export interface FrameHostInstance {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly alarm: () => Promise<void>;
}

export interface FrameHostClass {
  new (context: DurableObjectContext, env: unknown): FrameHostInstance;
}

/**
 * Builds the Durable Object class that hosts the given implementations.
 *
 * The constructor is the layer boundary: it owns one `ManagedRuntime` over
 * the host layer and the requirements layer, and every request runs inside
 * it. A restart loses the runtime, not the state.
 */
export const defineFrameHost = <R>(options: FrameHostOptions<R>): FrameHostClass => {
  const settings = Layer.succeed(
    DurableHostConfig,
    DurableHostConfig.of({
      pollInterval: Option.getOrElse<Duration.Input, Duration.Input>(
        options.pollInterval,
        () => "20 millis",
      ),
    }),
  );
  const requirements = options.layer;
  const hold = holdOf(options.alarmHold);

  return class FrameHost implements FrameHostInstance {
    readonly #storage: DurableStorage;
    readonly #runtime: ManagedRuntime.ManagedRuntime<
      ActorTransport | ActorHost.Recovery | R | Policies,
      PolicyNamesMissing
    >;
    #handler: Option.Option<Promise<HttpServer.WebHandler>> = Option.none();

    constructor(context: DurableObjectContext, _env: unknown) {
      this.#storage = context.storage;
      Interop.exec(context.storage.sql, addressSchema);
      const host = ActorHost.layer({
        implementations: options.implementations,
        store: () => StorageStore.layer(context.storage),
      });
      // The Durable Object constructor is the boundary: it builds the one
      // runtime that every request of this object runs inside. The
      // requirements stay in it, so the principal derivation can read them.
      this.#runtime = ManagedRuntime.make(
        Layer.provideMerge(host, Layer.merge(requirements, settings)),
      );
    }

    /** The one web handler this object serves. Concurrent requests share it. */
    #ensureHandler(): Promise<HttpServer.WebHandler> {
      return Option.match(this.#handler, {
        onSome: (running) => running,
        onNone: () => {
          const starting = this.#runtime.runPromise(
            HttpServer.make({ principal: options.principal }),
          );
          this.#handler = Option.some(starting);
          return starting;
        },
      });
    }

    /**
     * The wake an admission or a committed deadline armed, or a retry of a
     * failed alarm. It opens the instance the last request named, which
     * restores the committed state, drains pending commands, and re-enters
     * machine work. It holds until nothing is due, so the object is not
     * evicted while that work runs.
     */
    async alarm(): Promise<void> {
      const address = readAddress(this.#storage);
      if (Option.isNone(address)) {
        return;
      }
      await this.#runtime.runPromise(wakeAndDrain(address.value, this.#storage, hold));
    }

    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const body: unknown = await request
        .clone()
        .json()
        .catch(() => ({}));
      const address = addressOf(body, url);
      if (Option.isSome(address)) {
        writeAddress(this.#storage, address.value);
      }
      const handler = await this.#ensureHandler();
      return await this.#runtime.runPromise(handler(request));
    }
  };
};

/**
 * What still needs the object awake: a pending command, or a committed wake
 * (`Behavior.wakeAt`) at or before now. `Some` is the time to wake again.
 */
const due = (storage: DurableStorage, now: number): Option.Option<number> => {
  const pending = Interop.exec(
    storage.sql,
    "SELECT 1 FROM commands WHERE revision IS NULL LIMIT 1",
  );
  if (pending.length > 0) {
    return Option.some(now);
  }
  return Option.flatMap(
    Interop.firstRow(Interop.exec(storage.sql, "SELECT wake_at FROM committed WHERE id = 1")),
    (row) => Interop.numberColumn(row, "wake_at"),
  );
};

/** How often the hold reads the tables. */
const holdStep = Duration.millis(20);

/** The longest hold, with margin below Cloudflare's 15-minute alarm limit. */
const holdLimit = Duration.minutes(10);

/**
 * The hold one alarm runs for: `None` is 30 seconds, and any value is
 * clamped between one poll step and `holdLimit`, so an infinite hold still
 * ends and re-arms.
 */
export const holdOf = (alarmHold: Option.Option<Duration.Input>): Duration.Duration =>
  Duration.clamp(
    Duration.fromInputUnsafe(
      Option.getOrElse<Duration.Input, Duration.Input>(alarmHold, () => "30 seconds"),
    ),
    { minimum: holdStep, maximum: holdLimit },
  );

/** The committed revision, for the log line that closes a wake. */
const committedRevision = (storage: DurableStorage): Option.Option<number> =>
  Option.flatMap(
    Interop.firstRow(Interop.exec(storage.sql, "SELECT revision FROM committed WHERE id = 1")),
    (row) => Interop.numberColumn(row, "revision"),
  );

/**
 * Opens the instance and holds the alarm until nothing is due.
 *
 * The wake has no caller, so it does not go through the public wire, where
 * every read is checked against a policy and a protected actor would refuse
 * it. It asks the host's own `Recovery`, which opens the instance and
 * returns nothing (#85). Opening restores the committed state, drains the
 * admitted commands, and re-enters machine work on the actor's own fibers.
 *
 * The hold is what keeps that work alive (#101 §5): a runtime may evict an
 * object with no request and no running alarm, and a machine's task or
 * deadline would die with it. The hold ends when no command is pending and
 * the committed wake is absent or later than now. The `hold` bound keeps one
 * alarm inside the runtime's limit; work still due at the bound arms the
 * next alarm at once, so a task longer than one alarm continues.
 *
 * A wake still ahead is never armed here. The commit that stored it armed it
 * in its own transaction, and this write would sit outside one: a request can
 * admit a command between the read and the write, and its "now" alarm would
 * be pushed back to the later wake. Arming "now" can only bring a wake
 * forward, so it is the one write this handler makes.
 */
const wakeAndDrain = Effect.fn("FrameHost.wake")(function* (
  address: Address,
  storage: DurableStorage,
  hold: Duration.Duration,
) {
  const recovery = yield* ActorHost.Recovery;
  const woken = yield* Effect.result(recovery.wake(address));
  if (Result.isFailure(woken)) {
    // The recorded address names no hosted contract: there is nothing to run.
    return yield* Effect.logWarning("FrameHost.wake refused").pipe(
      Effect.annotateLogs({ contract: address.contract, reason: woken.failure._tag }),
    );
  }
  const now = Effect.clockWith((clock) => clock.currentTimeMillis);
  const step = Effect.fn("FrameHost.wake.step")(function* () {
    const at = yield* now;
    const settled = Option.match(due(storage, at), {
      onNone: () => true,
      onSome: (wake) => wake > at,
    });
    if (!settled) {
      yield* Effect.sleep(holdStep);
    }
    return settled;
  });
  const steps = Math.ceil(Duration.toMillis(hold) / Duration.toMillis(holdStep));
  yield* Effect.repeat(step(), { until: (settled) => settled, times: steps });
  const at = yield* now;
  const stillDue = Option.filter(due(storage, at), (wake) => wake <= at);
  const revision = Option.getOrElse(committedRevision(storage), () => 0);
  if (Option.isSome(stillDue)) {
    yield* Interop.setAlarm(storage, at);
    return yield* Effect.logInfo(
      `FrameHost.wake rearmed contract=${address.contract} revision=${revision}`,
    );
  }
  yield* Effect.logInfo(`FrameHost.wake settled contract=${address.contract} revision=${revision}`);
});
