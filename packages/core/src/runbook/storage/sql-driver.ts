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
 * Raised when a bound `bigint` cannot be faithfully round-tripped.
 *
 * SQLite itself stores 64-bit integers, but NEITHER adapter can return one
 * through this contract, and they fail in opposite directions:
 *
 * - `node:sqlite` binds and stores the int64 exactly, then refuses to read it
 *   back — "If Node.js reads an INTEGER value from SQLite that is outside the
 *   JavaScript safe integer range, and the option to read BigInts is not
 *   enabled, then an ERR_OUT_OF_RANGE error will be thrown"
 *   (https://nodejs.org/api/sqlite.html). The row becomes write-only.
 * - sql.js 1.14.1 exposes no `bind_int64`/`column_int64` at all, so the value
 *   goes through a float64 and is SILENTLY truncated: binding
 *   9007199254740993 stores 9007199254740992, with `typeof(v)` still reporting
 *   `integer`. Nothing downstream can detect the loss.
 *
 * Enabling `StatementSync.prototype.setReadBigInts(true)` would fix the native
 * read at the cost of returning EVERY integer column as a `BigInt`, which the
 * sql.js adapter still could not match. Until the row-level policy is decided,
 * the contract refuses the values it cannot honour rather than storing a
 * corrupt one under one adapter and an unreadable one under the other.
 */
export class UnrepresentableIntegerError extends Error {
  /**
   * Construct the typed out-of-range bind error.
   *
   * @param key - Named bind parameter carrying the offending value.
   * @param value - The value that cannot be round-tripped.
   */
  constructor(
    readonly key: string,
    readonly value: bigint,
  ) {
    super(
      `Cannot bind ${String(value)} for ":${key}": outside the safe integer range ` +
        `(±${String(Number.MAX_SAFE_INTEGER)}), where one adapter truncates silently and the ` +
        `other stores a row it cannot read back.`,
    );
    this.name = 'UnrepresentableIntegerError';
  }
}

/**
 * Convert a bound value to one both adapters round-trip identically.
 *
 * A `bigint` within the safe integer range is narrowed to `number`, which both
 * adapters store as a SQLite `INTEGER` and return unchanged. Anything wider is
 * refused — see {@link UnrepresentableIntegerError} for why neither adapter can
 * honour it.
 *
 * @param key - Named bind parameter, used only for the error message.
 * @param value - The value to normalize.
 * @returns The value, with an in-range `bigint` narrowed to `number`.
 * @throws {UnrepresentableIntegerError} When a `bigint` exceeds the safe range.
 */
export function toPortableBindValue(key: string, value: SqlBindable): Exclude<SqlBindable, bigint> {
  if (typeof value !== 'bigint') {
    return value;
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new UnrepresentableIntegerError(key, value);
  }
  return Number(value);
}

/**
 * Normalize every bound value in a parameter set.
 *
 * @param params - Named bind parameters to normalize.
 * @returns The same keys with portable values.
 * @throws {UnrepresentableIntegerError} When any `bigint` exceeds the safe range.
 */
export function toPortableParams(params: SqlParams): Record<string, Exclude<SqlBindable, bigint>> {
  const out: Record<string, Exclude<SqlBindable, bigint>> = {};
  for (const [key, value] of Object.entries(params)) {
    out[key] = toPortableBindValue(key, value);
  }
  return out;
}

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
 * A prepared query bound to one open read transaction.
 *
 * Rows returned by {@link get} / {@link all} are UNVALIDATED. `runbook-store.ts`
 * is the sole consumer and applies Zod at its edge; no raw row escapes the store.
 */
export interface SqlReadStatement {
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

/** A prepared statement bound to one open writing transaction. */
export interface SqlStatement extends SqlReadStatement {
  /**
   * Execute a non-query statement (INSERT/UPDATE/DELETE/DDL).
   *
   * @param params - Optional named bind parameters.
   * @returns The change count and last insert rowid.
   */
  run(params?: SqlParams): SqlRunResult;
}

/**
 * A handle to one open read transaction.
 *
 * Deliberately carries NO mutating surface: no `exec`, and prepared statements
 * expose queries only. Under the sql.js adapter a mutation made through
 * {@link SqlDriver.read} is silently discarded (the read path never persists the
 * exported image), so "read-only" has to be a type the caller cannot escape
 * rather than a convention the caller is asked to honour.
 *
 * Only valid for the synchronous duration of the `work` callback passed to
 * {@link SqlDriver.read}.
 */
export interface SqlReadTransaction {
  /**
   * Prepare a query for execution within this transaction.
   *
   * @param sql - The SQL text to prepare.
   * @returns A prepared query.
   */
  prepare(sql: string): SqlReadStatement;
}

/**
 * A handle to one open writing SQLite transaction.
 *
 * Only valid for the synchronous duration of the `work` callback passed to
 * {@link SqlDriver.immediate}.
 */
export interface SqlTransaction extends SqlReadTransaction {
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
 * Restrict a writing transaction to the read-only surface.
 *
 * Both adapters own a single transaction implementation and hand this narrowed
 * view to read work, so neither can drift from the other on what a read may do.
 * The returned statements delegate to the underlying prepared statement, which
 * keeps adapter-owned bookkeeping (sql.js statement disposal) intact.
 *
 * @param tx - The writing transaction to narrow.
 * @returns A view exposing only `prepare` → `get`/`all`.
 */
export function readOnlyTransaction(tx: SqlTransaction): SqlReadTransaction {
  return {
    prepare(sql: string): SqlReadStatement {
      const stmt = tx.prepare(sql);
      return {
        get: <T extends SqlRow>(params?: SqlParams): T | undefined => stmt.get<T>(params),
        all: <T extends SqlRow>(params?: SqlParams): readonly T[] => stmt.all<T>(params),
      };
    },
  };
}

/**
 * Callback return type that structurally rejects promise-returning work.
 *
 * `T` still infers from whatever the callback returns, but an inferred
 * `Promise<X>` collapses the required parameter type to `never`, so the call
 * site fails to compile. This is the compile-time half of the sync-only
 * transaction contract; {@link assertSyncWorkResult} is the runtime half.
 */
export type SyncWork<T> = T & (T extends PromiseLike<unknown> ? never : unknown);

/**
 * Raised when transaction work returns a thenable.
 *
 * Awaiting an external effect inside an open transaction holds the write lock
 * for the duration of that effect, and — because the driver commits as soon as
 * the callback returns — commits BEFORE the awaited work has run at all. Both
 * are refused rather than tolerated.
 */
export class AsyncTransactionWorkError extends Error {
  /** Construct the typed sync-only violation error. */
  constructor() {
    super(
      'Transaction work must be synchronous: the callback returned a promise, which would ' +
        'commit before the awaited work ran and hold the write lock while it did.',
    );
    this.name = 'AsyncTransactionWorkError';
  }
}

/**
 * Refuse a work result that is thenable.
 *
 * The type contract already rejects promise-returning callbacks; this guards the
 * callers types cannot reach — JavaScript consumers, and callbacks whose
 * promise return is laundered through `any`.
 *
 * @param result - Value the work callback returned.
 * @throws {AsyncTransactionWorkError} When `result` is thenable.
 */
export function assertSyncWorkResult(result: unknown): void {
  if (
    typeof result === 'object' &&
    result !== null &&
    typeof (result as { then?: unknown }).then === 'function'
  ) {
    throw new AsyncTransactionWorkError();
  }
}

/**
 * Capability-selected SQLite driver.
 *
 * `work` is SYNCHRONOUS by type ({@link SyncWork}) and by runtime check
 * ({@link assertSyncWorkResult}): both halves exist because the type alone
 * cannot constrain a JavaScript caller. Do not widen either to admit a
 * Promise-returning callback — that reintroduces the "slow work under the write
 * lock" hazard the transaction-boundary rule forbids, and commits before the
 * awaited work has run.
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
   * @param work - Synchronous callback receiving the open read transaction.
   * @returns The callback's return value once the transaction closes.
   * @throws {AsyncTransactionWorkError} When the callback returns a thenable.
   */
  read<T>(work: (tx: SqlReadTransaction) => SyncWork<T>): Promise<T>;
  /**
   * Run writing work in a `BEGIN IMMEDIATE` transaction, committing on normal
   * return and rolling back on any throw.
   *
   * @template T - The value the work callback returns.
   * @param work - Synchronous callback receiving the open transaction.
   * @returns The callback's return value once the transaction commits.
   * @throws {AsyncTransactionWorkError} When the callback returns a thenable.
   */
  immediate<T>(work: (tx: SqlTransaction) => SyncWork<T>): Promise<T>;
}
