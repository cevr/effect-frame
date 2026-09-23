import { Effect, Option } from "effect";
import type {
  DurableStorage,
  SqlBinding,
  SqlRow,
  SqlStorage,
  StorageTransaction,
} from "./storage.js";

/**
 * The one place that touches the runtime's promise and nullish surface. Every
 * other file works in Effect and Option. The lint rules that forbid promises
 * and nullish values stay on everywhere else because of this seam.
 */

/** Runs a statement and returns its rows. */
export const exec = (
  sql: SqlStorage,
  query: string,
  ...bindings: ReadonlyArray<SqlBinding>
): ReadonlyArray<SqlRow> => sql.exec(query, ...bindings).toArray();

/** The first row a statement returned, if it returned one. */
export const firstRow = (rows: ReadonlyArray<SqlRow>): Option.Option<SqlRow> =>
  Option.fromNullishOr(rows[0]);

/** Reads a column the schema declares as an integer. A NULL reads as absent. */
export const numberColumn = (row: SqlRow, column: string): Option.Option<number> => {
  const value = row[column];
  if (typeof value === "number") {
    return Option.some(value);
  }
  return Option.none();
};

/** Reads a column the schema declares as text. A NULL reads as absent. */
export const stringColumn = (row: SqlRow, column: string): Option.Option<string> => {
  const value = row[column];
  if (typeof value === "string") {
    return Option.some(value);
  }
  return Option.none();
};

/**
 * Runs SQL writes in one transaction. The body writes through `storage.sql`,
 * which the runtime binds to the open transaction. The runtime commits when
 * the callback's promise resolves and rolls back when it rejects, so a
 * synchronous body that only writes rows always commits as a unit.
 */
export const transact = <A>(storage: DurableStorage, body: () => A): Effect.Effect<A> =>
  Effect.promise(() => storage.transaction(() => Promise.resolve(body())));

/** One command's admission row. */
export interface Admission {
  readonly commandId: string;
  readonly payload: string;
  readonly payloadHash: number;
  /** The wake time to arm. Now, so a restart drains at once. */
  readonly at: number;
}

/**
 * Inserts the command and arms the wake in one transaction, and returns the
 * admission order the insert assigned.
 *
 * The runtime publishes a transaction alarm at commit, so the command row and
 * its wake become visible together or not at all. That is what lets a restart
 * after an accepted response drain the command with no client request.
 */
export const admit = (storage: DurableStorage, admission: Admission): Effect.Effect<number> =>
  Effect.promise(() =>
    storage.transaction(async (txn: StorageTransaction) => {
      exec(
        storage.sql,
        "INSERT INTO commands (command_id, payload, payload_hash) VALUES (?, ?, ?)",
        admission.commandId,
        admission.payload,
        admission.payloadHash,
      );
      const rows = exec(
        storage.sql,
        "SELECT admitted FROM commands WHERE command_id = ?",
        admission.commandId,
      );
      await txn.setAlarm(admission.at);
      return Option.match(
        Option.flatMap(firstRow(rows), (row) => numberColumn(row, "admitted")),
        {
          onNone: () => 0,
          onSome: (admitted) => admitted,
        },
      );
    }),
  );

/** Arms a wake outside a transaction. */
export const setAlarm = (storage: DurableStorage, at: number): Effect.Effect<void> =>
  Effect.promise(() => storage.setAlarm(at));

/** The armed wake time, if one is armed. The runtime reports none as null. */
export const getAlarm = (storage: DurableStorage): Effect.Effect<Option.Option<number>> =>
  Effect.map(
    Effect.promise(() => storage.getAlarm()),
    (value) => {
      if (typeof value === "number") {
        return Option.some(value);
      }
      return Option.none();
    },
  );

/** Drops the armed wake. */
export const deleteAlarm = (storage: DurableStorage): Effect.Effect<void> =>
  Effect.promise(() => storage.deleteAlarm());
