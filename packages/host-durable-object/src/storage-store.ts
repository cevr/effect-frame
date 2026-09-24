import { Effect, Layer, Option, Schema } from "effect";
import type {
  AppendInput,
  Appended,
  Committed,
  PendingCommand,
  StoredReceipt,
} from "effect-frame/actor";
import { CommandConflict, CommandId, MailboxStore } from "effect-frame/actor";
import type { StoreFactory } from "effect-frame/actor/testing";
import * as Interop from "./interop.js";
import type { DurableStorage, SqlBinding, SqlRow, SqlStorage } from "./storage.js";

const decodeCommandId = Schema.decodeSync(CommandId);

/**
 * The tables one actor owns inside its object. `commands.admitted` is the
 * mailbox order. A row without a `revision` is still pending. `committed`
 * holds one row: the actor's latest revision, encoded state, and the wake
 * that state asked for (`Behavior.wakeAt`), NULL when it waits for nothing.
 */
export const schema: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS commands (
     admitted INTEGER PRIMARY KEY AUTOINCREMENT,
     command_id TEXT UNIQUE,
     payload TEXT,
     payload_hash INTEGER,
     revision INTEGER NULL,
     state TEXT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS committed (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     revision INTEGER,
     state TEXT,
     wake_at INTEGER NULL
   )`,
];

/**
 * An object whose `committed` table predates the wake column gains it. The
 * column is nullable, so every row it already holds reads as no wake.
 */
const addWakeColumn = (sql: SqlStorage): void => {
  const columns = Interop.exec(sql, "PRAGMA table_info(committed)");
  if (
    !columns.some((column) => Interop.stringColumn(column, "name").pipe(Option.contains("wake_at")))
  ) {
    Interop.exec(sql, "ALTER TABLE committed ADD COLUMN wake_at INTEGER NULL");
  }
};

const number = (row: SqlRow, column: string): number =>
  Option.getOrElse(Interop.numberColumn(row, column), () => 0);

const text = (row: SqlRow, column: string): string =>
  Option.getOrElse(Interop.stringColumn(row, column), () => "");

const toPending = (row: SqlRow): PendingCommand => ({
  commandId: decodeCommandId(text(row, "command_id")),
  admitted: number(row, "admitted"),
  payload: text(row, "payload"),
  payloadHash: number(row, "payload_hash"),
});

const toReceipt = (row: SqlRow): StoredReceipt => ({
  commandId: decodeCommandId(text(row, "command_id")),
  admitted: number(row, "admitted"),
  revision: number(row, "revision"),
  state: text(row, "state"),
});

const toCommitted = (row: SqlRow): Committed => ({
  revision: number(row, "revision"),
  state: text(row, "state"),
  wake: Interop.numberColumn(row, "wake_at"),
});

/** A command row, whether or not it carries a receipt yet. */
interface CommandRow {
  readonly admitted: number;
  readonly payload: string;
  readonly payloadHash: number;
  readonly receipt: Option.Option<StoredReceipt>;
}

/**
 * A pending row has no revision, so `revision` reads as absent. A committed
 * row reads as a full receipt.
 */
const toCommandRow = (row: SqlRow): CommandRow => ({
  admitted: number(row, "admitted"),
  payload: text(row, "payload"),
  payloadHash: number(row, "payload_hash"),
  receipt: Option.map(Interop.numberColumn(row, "revision"), () => toReceipt(row)),
});

const readCommand = (sql: SqlStorage, commandId: CommandId): Option.Option<CommandRow> =>
  Option.map(
    Interop.firstRow(
      Interop.exec(
        sql,
        `SELECT admitted, command_id, payload, payload_hash, revision, state
           FROM commands WHERE command_id = ?`,
        commandId,
      ),
    ),
    toCommandRow,
  );

const readCommitted = (sql: SqlStorage): Option.Option<Committed> =>
  Option.map(
    Interop.firstRow(
      Interop.exec(sql, "SELECT revision, state, wake_at FROM committed WHERE id = 1"),
    ),
    toCommitted,
  );

const nextRevision = (sql: SqlStorage): number =>
  Option.match(readCommitted(sql), {
    onNone: () => 1,
    onSome: (committed) => committed.revision + 1,
  });

/** The store binds no SQL NULL, so an absent wake writes the literal. */
const writeCommitted = (
  sql: SqlStorage,
  revision: number,
  state: string,
  wake: Option.Option<number>,
): void => {
  const upsert = (wakeValue: string, ...bindings: ReadonlyArray<SqlBinding>) =>
    Interop.exec(
      sql,
      `INSERT INTO committed (id, revision, state, wake_at) VALUES (1, ?, ?, ${wakeValue})
         ON CONFLICT (id) DO UPDATE SET revision = excluded.revision,
           state = excluded.state, wake_at = excluded.wake_at`,
      revision,
      state,
      ...bindings,
    );
  Option.match(wake, {
    onNone: () => upsert("NULL"),
    onSome: (at) => upsert("?", at),
  });
};

/**
 * The alarm a commit leaves armed. A pending command wakes the object at
 * once: its admission armed that, and a commit must not push it back to a
 * later deadline. Otherwise the committed state's own wake is armed, never
 * earlier than now: a runtime refuses an alarm in the past, and a wake that
 * is already due means now. With neither, the commit leaves the alarm as it
 * was: a stale alarm only opens the actor, which finds nothing due.
 */
const alarmAfterCommit = (
  sql: SqlStorage,
  wake: Option.Option<number>,
  now: number,
): Option.Option<number> => {
  const pending = Interop.exec(sql, "SELECT 1 FROM commands WHERE revision IS NULL LIMIT 1");
  if (pending.length > 0) {
    return Option.some(now);
  }
  return Option.map(wake, (at) => Math.max(at, now));
};

/**
 * A `MailboxStore` over one Durable Object's SQL storage.
 *
 * `append` inserts the command and arms an alarm in one transaction, so a
 * restart after the accepted response still drains the command with no client
 * request. `commit` writes the receipt and the new committed revision in one
 * transaction, so no observer sees a receipt without its state.
 */
export const make = Effect.fn("HostDurableObject.storageStore")(function* (
  storage: DurableStorage,
) {
  yield* Effect.forEach(schema, (statement) =>
    Effect.sync(() => {
      Interop.exec(storage.sql, statement);
    }),
  );
  yield* Effect.sync(() => addWakeColumn(storage.sql));
  const currentTime = Effect.clockWith((clock) => clock.currentTimeMillis);

  const append = Effect.fn("HostDurableObject.storageStore.append")(function* (input: AppendInput) {
    const existing = yield* Effect.sync(() => readCommand(storage.sql, input.commandId));
    if (Option.isSome(existing)) {
      // The hash is only a fast refusal. Two payloads can share a hash, so
      // equal hashes are confirmed on the stored text before a Duplicate.
      if (
        existing.value.payloadHash !== input.payloadHash ||
        existing.value.payload !== input.payload
      ) {
        return yield* CommandConflict.make({ commandId: input.commandId });
      }
      return {
        _tag: "Duplicate",
        admitted: existing.value.admitted,
        receipt: existing.value.receipt,
      } satisfies Appended;
    }
    const now = yield* currentTime;
    const admitted = yield* Interop.admit(storage, {
      commandId: input.commandId,
      payload: input.payload,
      payloadHash: input.payloadHash,
      at: now,
    });
    return { _tag: "Admitted", admitted } satisfies Appended;
  });

  const next = Effect.sync(() =>
    Option.map(
      Interop.firstRow(
        Interop.exec(
          storage.sql,
          `SELECT admitted, command_id, payload, payload_hash
             FROM commands WHERE revision IS NULL
            ORDER BY admitted LIMIT 1`,
        ),
      ),
      toPending,
    ),
  );

  const commit = Effect.fn("HostDurableObject.storageStore.commit")(function* (
    commandId: CommandId,
    state: string,
    wake: Option.Option<number>,
  ) {
    const found = yield* Effect.sync(() => readCommand(storage.sql, commandId));
    if (Option.isNone(found)) {
      return yield* Effect.die(`MailboxStore.commit: unknown command ${commandId}`);
    }
    const now = yield* currentTime;
    const revision = yield* Interop.transactArming(storage, () => ({
      value: writeReceipt(storage.sql, commandId, state, wake),
      alarm: alarmAfterCommit(storage.sql, wake, now),
    }));
    return {
      commandId,
      admitted: found.value.admitted,
      revision,
      state,
    } satisfies StoredReceipt;
  });

  const receipt = (commandId: CommandId) =>
    Effect.sync(() =>
      Option.flatMap(readCommand(storage.sql, commandId), (command) => command.receipt),
    );

  const pending = Effect.sync(() =>
    Interop.exec(
      storage.sql,
      "SELECT command_id FROM commands WHERE revision IS NULL ORDER BY admitted",
    ).map((row) => decodeCommandId(text(row, "command_id"))),
  );

  const latest = Effect.sync(() => readCommitted(storage.sql));

  const advance = Effect.fn("HostDurableObject.storageStore.advance")(function* (
    state: string,
    wake: Option.Option<number>,
  ) {
    const now = yield* currentTime;
    const revision = yield* Interop.transactArming(storage, () => ({
      value: writeAdvance(storage.sql, state, wake),
      alarm: alarmAfterCommit(storage.sql, wake, now),
    }));
    return { revision, state, wake } satisfies Committed;
  });

  return MailboxStore.of({ append, next, commit, receipt, pending, latest, advance });
});

/** Writes the receipt and the new committed revision together. */
const writeReceipt = (
  sql: SqlStorage,
  commandId: CommandId,
  state: string,
  wake: Option.Option<number>,
): number => {
  const revision = nextRevision(sql);
  Interop.exec(
    sql,
    "UPDATE commands SET revision = ?, state = ? WHERE command_id = ?",
    revision,
    state,
    commandId,
  );
  writeCommitted(sql, revision, state, wake);
  return revision;
};

/** Writes a committed state the behavior reached with no command. */
const writeAdvance = (sql: SqlStorage, state: string, wake: Option.Option<number>): number => {
  const revision = nextRevision(sql);
  writeCommitted(sql, revision, state, wake);
  return revision;
};

/** The layer a Durable Object builds once and gives to the durable actor. */
export const layer = (storage: DurableStorage): Layer.Layer<MailboxStore> =>
  Layer.effect(MailboxStore, make(storage));

/** The store as a scoped factory, which the conformance suite takes. */
export const factory = (storage: DurableStorage): StoreFactory => make(storage);
