/**
 * Minimal common statement/transaction interface shared by the native
 * `node:sqlite` driver and the WASM `sql.js` driver.
 *
 * Both adapters execute the **same SQL against the same schema**; this seam is a
 * thin driver boundary (prepare/exec/transaction + persist), not two persistence
 * models. `transaction()` — exposed as {@link SqlDriver.read} and
 * {@link SqlDriver.immediate} — is the sole authoritative write path; callers
 * never obtain a raw writable connection.
 *
 * @module runbook/storage/sql-driver
 */

/**
 * Values SQLite can bind to a statement parameter.
 *
 * Narrower than `unknown` so an unbindable JS value (an object, a boolean, a
 * `Date`) is a compile error at the call site rather than a runtime throw inside
 * the driver.
 */
export type SqlBindable = null | number | bigint | string | Uint8Array;

/** Named bind parameters for a prepared statement. */
export type SqlParams = Readonly<Record<string, SqlBindable>>;

/**
 * Shape of a returned row.
 *
 * Constraining `T extends SqlRow` keeps {@link SqlStatement.get} /
 * {@link SqlStatement.all} from returning bare primitives that the store would
 * then have to re-wrap. Row *values* are `unknown` because they are UNVALIDATED
 * at this layer — `runbook-store.ts` is the sole consumer and applies Zod at its
 * edge.
 */
export type SqlRow = Readonly<Record<string, unknown>>;

/** Result of a non-query statement execution. */
export interface SqlRunResult {
  /** Number of rows the statement changed. */
  readonly changes: number;
  /** Rowid of the last inserted row (`bigint` for large rowids). */
  readonly lastInsertRowid: number | bigint;
}

/**
 * A prepared statement bound to one open transaction.
 *
 * Rows returned by {@link get} / {@link all} are UNVALIDATED. `runbook-store.ts`
 * is the sole consumer and applies Zod at its edge; no raw row escapes the store.
 */
export interface SqlStatement {
  /**
   * Execute a non-query statement (INSERT/UPDATE/DELETE/DDL).
   *
   * @param params - Optional named bind parameters.
   * @returns The change count and last insert rowid.
   */
  run(params?: SqlParams): SqlRunResult;
  /**
   * Execute a query and return the first row, if any.
   *
   * @param params - Optional named bind parameters.
   * @returns The first row, or `undefined` when the query matched nothing.
   */
  get<T extends SqlRow>(params?: SqlParams): T | undefined;
  /**
   * Execute a query and return every matching row.
   *
   * @param params - Optional named bind parameters.
   * @returns All matching rows in result order.
   */
  all<T extends SqlRow>(params?: SqlParams): readonly T[];
}

/**
 * A handle to one open SQLite transaction.
 *
 * Only valid for the synchronous duration of the `work` callback passed to
 * {@link SqlDriver.read} / {@link SqlDriver.immediate}.
 */
export interface SqlTransaction {
  /**
   * Prepare a statement for execution within this transaction.
   *
   * @param sql - The SQL text to prepare.
   * @returns A prepared statement.
   */
  prepare(sql: string): SqlStatement;
  /**
   * Execute one or more statements with no bound parameters and no results.
   *
   * @param sql - The SQL text to execute.
   */
  exec(sql: string): void;
}

/**
 * Capability-selected SQLite driver.
 *
 * `work` is intentionally SYNCHRONOUS: it structurally prevents awaiting an
 * external effect inside `BEGIN IMMEDIATE`. Do not widen it to a
 * Promise-returning callback — that would reintroduce the "slow work under the
 * write lock" hazard the transaction-boundary rule forbids.
 */
export interface SqlDriver extends AsyncDisposable {
  /** Which concrete adapter backs this driver. */
  readonly kind: 'native' | 'sqljs';
  /** Static capability facts a caller can branch on rather than by convention. */
  readonly capabilities: {
    /** Whether this adapter serializes writes safely across OS processes. */
    readonly multiProcess: boolean;
  };
  /**
   * Run read-only work in a deferred transaction.
   *
   * @template T - The value the work callback returns.
   * @param work - Synchronous callback receiving the open transaction.
   * @returns The callback's return value once the transaction closes.
   */
  read<T>(work: (tx: SqlTransaction) => T): Promise<T>;
  /**
   * Run writing work in a `BEGIN IMMEDIATE` transaction, committing on normal
   * return and rolling back on any throw.
   *
   * @template T - The value the work callback returns.
   * @param work - Synchronous callback receiving the open transaction.
   * @returns The callback's return value once the transaction commits.
   */
  immediate<T>(work: (tx: SqlTransaction) => T): Promise<T>;
}
