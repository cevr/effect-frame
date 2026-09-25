import { Effect, Option, Schema } from "effect";
import { CommandId } from "effect-frame/actor";
import type { ConformanceCase, StoreFactory } from "effect-frame/actor/testing";
import { mailboxStoreConformance } from "effect-frame/actor/testing";
import * as Interop from "../src/interop.js";
import type { DurableObjectContext, DurableStorage } from "../src/storage.js";
import * as StorageStore from "../src/storage-store.js";

/**
 * The store-on-the-real-runtime fixture.
 *
 * `tests/workerd-conformance.test.ts` serves this worker with workerd and
 * asks one SQLite-backed Durable Object to run two suites against its own
 * storage:
 *
 * - `/conformance` runs the shared `mailboxStoreConformance` over the
 *   storage store. The bun:sqlite fake proves the store's logic; this proves
 *   it against the runtime's SQL, transactions and alarms.
 * - `/assumptions` checks what the store relies on and the fake only
 *   imitates: an async `transaction` commits on resolve and rolls back on
 *   reject, and an alarm set on the transaction handle lands at commit and
 *   not on rollback.
 *
 * Each suite answers JSON; the test fails on any failed case. This is a proof
 * fixture, not a library entry point.
 */

const commandId = Schema.decodeSync(CommandId);

/** Empties the object between cases, so each case gets a fresh store. */
const reset = (storage: DurableStorage) =>
  Effect.andThen(
    Effect.sync(() => {
      Interop.exec(storage.sql, "DROP TABLE IF EXISTS commands");
      Interop.exec(storage.sql, "DROP TABLE IF EXISTS committed");
    }),
    Interop.deleteAlarm(storage),
  );

const freshStore = (storage: DurableStorage): StoreFactory =>
  Effect.acquireRelease(Effect.andThen(reset(storage), StorageStore.make(storage)), () =>
    reset(storage),
  );

// ---------------------------------------------------------------------------
// The runtime assumptions
// ---------------------------------------------------------------------------

const probeSchema = "CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY, label TEXT)";

const labels = (storage: DurableStorage): ReadonlyArray<unknown> =>
  Interop.exec(storage.sql, "SELECT label FROM probe ORDER BY id").map((row) => row["label"]);

/** A rejection the checks raise on purpose to force a rollback. */
const rollback = { _tag: "DeliberateRollback" };

/** Runs a transaction that is meant to reject, and reports whether it did. */
const rejects = async (run: () => Promise<unknown>): Promise<boolean> =>
  run().then(
    () => false,
    () => true,
  );

const check = (name: string, passed: boolean, detail: unknown): ConformanceCase => ({
  name,
  passed,
  detail: JSON.stringify(detail),
});

const assumptions = async (storage: DurableStorage): Promise<ReadonlyArray<ConformanceCase>> => {
  Interop.exec(storage.sql, "DROP TABLE IF EXISTS probe");
  Interop.exec(storage.sql, probeSchema);
  await storage.deleteAlarm();
  const cases: Array<ConformanceCase> = [];

  // 1. Statements the callback runs through `storage.sql`, with an await
  //    between them, commit together.
  await storage.transaction(async () => {
    Interop.exec(storage.sql, "INSERT INTO probe (label) VALUES ('committed-1')");
    await Promise.resolve();
    Interop.exec(storage.sql, "INSERT INTO probe (label) VALUES ('committed-2')");
  });
  const afterCommit = labels(storage);
  cases.push(
    check(
      "an async transaction commits every write when its callback resolves",
      JSON.stringify(afterCommit) === JSON.stringify(["committed-1", "committed-2"]),
      afterCommit,
    ),
  );

  // 2. The same statements roll back when the callback rejects after an await.
  const rejected = await rejects(() =>
    storage.transaction(async () => {
      Interop.exec(storage.sql, "INSERT INTO probe (label) VALUES ('rolled-back')");
      await Promise.resolve();
      return await Promise.reject(rollback);
    }),
  );
  const afterRollback = labels(storage);
  cases.push(
    check(
      "an async transaction rolls back every write when its callback rejects",
      rejected && JSON.stringify(afterRollback) === JSON.stringify(afterCommit),
      { rejected, afterRollback },
    ),
  );

  // 3. An alarm set on the handle of a rolled-back transaction is not armed.
  const rolledBackAt = Date.now() + 3_600_000;
  const alarmRejected = await rejects(() =>
    storage.transaction(async (txn) => {
      Interop.exec(storage.sql, "INSERT INTO probe (label) VALUES ('alarm-rolled-back')");
      await txn.setAlarm(rolledBackAt);
      return await Promise.reject(rollback);
    }),
  );
  const noAlarm = await storage.getAlarm();
  cases.push(
    check(
      "an alarm set inside a rolled-back transaction is not armed",
      alarmRejected &&
        noAlarm === null &&
        JSON.stringify(labels(storage)) === JSON.stringify(afterCommit),
      { alarmRejected, alarm: noAlarm, labels: labels(storage) },
    ),
  );

  // 4. An alarm set on the handle of a committed transaction is armed with it.
  const committedAt = Date.now() + 3_600_000;
  await storage.transaction(async (txn) => {
    Interop.exec(storage.sql, "INSERT INTO probe (label) VALUES ('alarm-committed')");
    await txn.setAlarm(committedAt);
  });
  const armed = await storage.getAlarm();
  const afterAlarm = labels(storage);
  cases.push(
    check(
      "an alarm set inside a committed transaction is armed with its rows",
      armed === committedAt && afterAlarm.includes("alarm-committed"),
      { armed, want: committedAt, labels: afterAlarm },
    ),
  );

  // 5. The store's own admission: the command row and its wake land together.
  await storage.deleteAlarm();
  const store = await Effect.runPromise(Effect.andThen(reset(storage), StorageStore.make(storage)));
  const before = Date.now();
  const admitted = await Effect.runPromise(
    store.append({
      commandId: commandId("admitted"),
      payload: "1",
      payloadHash: 1,
    }),
  );
  const wake = await storage.getAlarm();
  const pending = await Effect.runPromise(store.pending);
  cases.push(
    check(
      "the store's append commits the command and arms its wake together",
      admitted._tag === "Admitted" &&
        typeof wake === "number" &&
        wake >= before &&
        pending.length === 1,
      { admitted, wake, before, pending },
    ),
  );

  await storage.deleteAlarm();
  Interop.exec(storage.sql, "DROP TABLE IF EXISTS probe");
  await Effect.runPromise(reset(storage));
  return cases;
};

// ---------------------------------------------------------------------------
// The Durable Object and the worker
// ---------------------------------------------------------------------------

export class ConformanceObject {
  readonly #storage: DurableStorage;

  constructor(context: DurableObjectContext, _env: unknown) {
    this.#storage = context.storage;
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/conformance") {
      const cases = await Effect.runPromise(mailboxStoreConformance(freshStore(this.#storage)));
      return Response.json({ cases });
    }
    if (path === "/assumptions") {
      return Response.json({ cases: await assumptions(this.#storage) });
    }
    return Response.json({ error: "NotFound", path }, { status: 404 });
  }

  /** An alarm the checks armed may fire; it has nothing to do. */
  async alarm(): Promise<void> {
    await this.#storage.deleteAlarm();
  }
}

interface ObjectNamespace {
  readonly idFromName: (name: string) => unknown;
  readonly get: (id: unknown) => { readonly fetch: (request: Request) => Promise<Response> };
}

interface Env {
  readonly STORE: ObjectNamespace;
}

/** The suites the object runs. Any other path is a 404 that wakes no object. */
const suites = new Set(["/conformance", "/assumptions"]);

/** `/<suite>?object=<name>`: one run names its own fresh object. */
export default {
  fetch: (request: Request, env: Env): Promise<Response> => {
    const url = new URL(request.url);
    if (!suites.has(url.pathname)) {
      return Promise.resolve(Response.json({ error: "NotFound" }, { status: 404 }));
    }
    const name = Option.getOrElse(
      Option.fromNullishOr(url.searchParams.get("object")),
      () => "default",
    );
    return env.STORE.get(env.STORE.idFromName(name)).fetch(request);
  },
};
