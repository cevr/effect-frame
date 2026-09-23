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
import type { DurableStorage, SqlRow, SqlStorage } from "./storage.js";

const decodeCommandId = Schema.decodeSync(CommandId);

/**
 * The tables one actor owns inside its object. `commands.admitted` is the
 * mailbox order. A row without a `revision` is still pending. `committed`
 * holds one row: the actor's latest revision and encoded state.
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
     state TEXT
   )`,
];

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
    Interop.firstRow(Interop.exec(sql, "SELECT revision, state FROM committed WHERE id = 1")),
    toCommitted,
  );

const nextRevision = (sql: SqlStorage): number =>
  Option.match(readCommitted(sql), {
    onNone: () => 1,
    onSome: (committed) => committed.revision + 1,
  });

const writeCommitted = (sql: SqlStorage, revision: number, state: string): void => {
  Interop.exec(
    sql,
    `INSERT INTO committed (id, revision, state) VALUES (1, ?, ?)
       ON CONFLICT (id) DO UPDATE SET revision = excluded.revision, state = excluded.state`,
    revision,
    state,
  );
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
    const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
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
  ) {
    const found = yield* Effect.sync(() => readCommand(storage.sql, commandId));
    if (Option.isNone(found)) {
      return yield* Effect.die(`MailboxStore.commit: unknown command ${commandId}`);
    }
    const revision = yield* Interop.transact(storage, (txn) =>
      writeReceipt(txn.sql, commandId, state),
    );
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

  const advance = Effect.fn("HostDurableObject.storageStore.advance")(function* (state: string) {
    const revision = yield* Interop.transact(storage, (txn) => writeAdvance(txn.sql, state));
    return { revision, state } satisfies Committed;
  });

  return MailboxStore.of({ append, next, commit, receipt, pending, latest, advance });
});

/** Writes the receipt and the new committed revision together. */
const writeReceipt = (sql: SqlStorage, commandId: CommandId, state: string): number => {
  const revision = nextRevision(sql);
  Interop.exec(
    sql,
    "UPDATE commands SET revision = ?, state = ? WHERE command_id = ?",
    revision,
    state,
    commandId,
  );
  writeCommitted(sql, revision, state);
  return revision;
};

/** Writes a committed state the behavior reached with no command. */
const writeAdvance = (sql: SqlStorage, state: string): number => {
  const revision = nextRevision(sql);
  writeCommitted(sql, revision, state);
  return revision;
};

/** The layer a Durable Object builds once and gives to the durable actor. */
export const layer = (storage: DurableStorage): Layer.Layer<MailboxStore> =>
  Layer.effect(MailboxStore, make(storage));

/** The store as a scoped factory, which the conformance suite takes. */
export const factory = (storage: DurableStorage): StoreFactory => make(storage);
