import { Database } from "bun:sqlite";
import type { Scope } from "effect";
import { Effect, Option } from "effect";
import type { DurableStorage, SqlBinding, SqlCursor, SqlRow, SqlStorage } from "../src/storage.js";

/**
 * An in-memory stand-in for a Durable Object's storage. It mimics the shape
 * the store uses: `sql.exec`, an async `transaction` that commits or rolls
 * back, and the alarm calls. It exists so the store passes the conformance
 * suite without a running celld node.
 *
 * The transaction is not concurrent. One test runs one command at a time, so
 * `BEGIN` / `COMMIT` around the callback matches the runtime's input gate.
 */

/** The two ways a transaction callback can end. */
type Outcome<A> =
  | { readonly _tag: "Committed"; readonly value: A }
  | { readonly _tag: "RolledBack"; readonly error: unknown };

const isRow = (value: unknown): value is SqlRow => typeof value === "object" && value !== null;

const sqlOver = (database: Database): SqlStorage => ({
  exec: (query: string, ...bindings: ReadonlyArray<SqlBinding>): SqlCursor => {
    // `bun:sqlite` runs a statement on the first read. The store reads every
    // cursor, so run it here and keep the rows.
    const rows = database
      .prepare(query)
      .all(...bindings)
      .filter(isRow);
    return { toArray: (): ReadonlyArray<SqlRow> => rows };
  },
});

export interface FakeStorage extends DurableStorage {
  /** The alarm the store armed, if any. The harness reads it in a test. */
  readonly armed: () => Option.Option<number>;
  readonly close: () => void;
}

export const makeFake = (): FakeStorage => {
  const database = new Database(":memory:");
  const sql = sqlOver(database);
  const alarm = { at: Option.none<number>() };

  const transaction = async <A>(
    run: (txn: {
      readonly sql: SqlStorage;
      readonly setAlarm: (at: number) => Promise<void>;
    }) => Promise<A>,
  ): Promise<A> => {
    const staged = { at: alarm.at };
    database.exec("BEGIN");
    const outcome: Outcome<A> = await run({
      sql,
      setAlarm: (at: number) => {
        staged.at = Option.some(at);
        return Promise.resolve();
      },
    }).then(
      (value): Outcome<A> => ({ _tag: "Committed", value }),
      (error: unknown): Outcome<A> => ({ _tag: "RolledBack", error }),
    );
    if (outcome._tag === "Committed") {
      database.exec("COMMIT");
      // The runtime publishes a transaction alarm at commit, not before.
      alarm.at = staged.at;
      return outcome.value;
    }
    database.exec("ROLLBACK");
    return await Promise.reject(outcome.error);
  };

  return {
    sql,
    transaction,
    setAlarm: (at: number) => {
      alarm.at = Option.some(at);
      return Promise.resolve();
    },
    // The runtime reports no alarm as `null`. The fake matches it.
    getAlarm: () =>
      Promise.resolve(
        Option.match<number, unknown, unknown>(alarm.at, {
          onNone: () => null,
          onSome: (at) => at,
        }),
      ),
    deleteAlarm: () => {
      alarm.at = Option.none();
      return Promise.resolve();
    },
    armed: () => alarm.at,
    close: () => {
      database.close();
    },
  };
};

/** A fresh fake, closed when the scope closes. */
export const scopedFake: Effect.Effect<FakeStorage, never, Scope.Scope> = Effect.acquireRelease(
  Effect.sync(makeFake),
  (storage) => Effect.sync(storage.close),
);
