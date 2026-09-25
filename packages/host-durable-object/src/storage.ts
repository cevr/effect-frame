/**
 * The smallest part of a Durable Object's storage that the mailbox store
 * uses. celld and Cloudflare both supply a wider object that satisfies this
 * shape. A test fake satisfies it over an in-memory SQLite database, so the
 * store runs without a runtime.
 *
 * The runtime returns SQL NULL and an absent alarm as `null`. This boundary
 * types those reads as `unknown` and the store converts them to `Option`, so
 * no nullish value travels past the edge.
 */

/** A value this code binds into a statement. The store never binds SQL NULL. */
export type SqlBinding = string | number;

/** One row a statement returned. A NULL column arrives as an unknown value. */
export interface SqlRow {
  readonly [column: string]: unknown;
}

/** The cursor `sql.exec` returns. The store reads it with `toArray`. */
export interface SqlCursor {
  readonly toArray: () => ReadonlyArray<SqlRow>;
}

export interface SqlStorage {
  readonly exec: (query: string, ...bindings: ReadonlyArray<SqlBinding>) => SqlCursor;
}

/**
 * The handle an async transaction callback receives. Its `setAlarm` publishes
 * the wake at commit, so an admission and its alarm land together.
 *
 * The handle carries no SQL. Cloudflare's handle has none, and on both
 * runtimes a statement run through the storage's own `sql` inside the
 * callback is part of the open transaction: it commits and rolls back with
 * it. `tests/workerd-conformance.test.ts` proves that on workerd.
 */
export interface StorageTransaction {
  readonly setAlarm: (scheduledTime: number) => Promise<void>;
}

export interface DurableStorage {
  readonly sql: SqlStorage;
  /**
   * Commits on a resolved callback. Rolls back on a rejected one, with every
   * `sql` statement the callback ran.
   */
  readonly transaction: <A>(run: (txn: StorageTransaction) => Promise<A>) => Promise<A>;
  readonly setAlarm: (scheduledTime: number) => Promise<void>;
  /** The armed wake time, or an absent value when no alarm is armed. */
  readonly getAlarm: () => Promise<unknown>;
  readonly deleteAlarm: () => Promise<void>;
}

/**
 * What a Durable Object hands its class. celld and Cloudflare both supply a
 * wider object; the host uses only the storage.
 */
export interface DurableObjectContext {
  readonly storage: DurableStorage;
}
