/**
 * SQLite schema for the Rundown runbook state store.
 *
 * Defines the authoritative schema version, the DDL for the six coordinated
 * tables (`runs`, `claims`, `session_stack`, `stash_slot`,
 * `resolved_completions`, `execution_attempts`), and the version-checking
 * install/validate routines. Structural lease/version triggers are layered on
 * top of this DDL in the repository task, where they are pinned red-green.
 *
 * The schema version is stored in SQLite's built-in `PRAGMA user_version`. It is
 * atomic, cheap, and identical across both adapters. An on-disk database whose
 * version is neither `0` (fresh) nor {@link SCHEMA_VERSION} is rejected, never
 * migrated (see the no-migration rule in CLAUDE.md).
 *
 * @module runbook/storage/schema
 */

import type { SqlTransaction } from './sql-driver.js';

/**
 * Current schema version.
 *
 * Persisted runbook state is never migrated. State written under any other
 * version is invalid and rejected with an {@link IncompatibleSchemaError}; the
 * recovery path is explicit user action (finish, stop, prune, restart).
 */
export const SCHEMA_VERSION = 1;

/** `user_version` value of a freshly created, never-installed database. */
const UNINITIALIZED_VERSION = 0;

/**
 * Raised when an existing database reports a schema version this build cannot
 * use. Carries the observed and expected versions so a frontend can render a
 * finish/stop/prune/restart instruction without re-deriving either.
 */
export class IncompatibleSchemaError extends Error {
  /** Version found in the on-disk database. */
  readonly foundVersion: number;
  /** Version this build requires. */
  readonly expectedVersion: number;

  /**
   * Construct a typed incompatible-schema error.
   *
   * @param foundVersion - Version found in the on-disk database.
   * @param expectedVersion - Version this build requires.
   */
  constructor(foundVersion: number, expectedVersion: number) {
    super(
      `Incompatible runbook database schema: found version ${String(foundVersion)}, ` +
        `expected ${String(expectedVersion)}. Rundown never migrates persisted state; ` +
        `finish, stop, or prune the active runs and restart from source.`,
    );
    this.name = 'IncompatibleSchemaError';
    this.foundVersion = foundVersion;
    this.expectedVersion = expectedVersion;
  }
}

/**
 * DDL statements installing schema version {@link SCHEMA_VERSION}.
 *
 * Ordered so foreign-key targets precede their referrers. `PRAGMA user_version`
 * is set last, inside the same transaction, so a crash mid-install leaves the
 * version at `0` and the next open re-installs rather than adopting a partial
 * schema.
 */
const SCHEMA_DDL = `
CREATE TABLE runs (
  id                TEXT    PRIMARY KEY NOT NULL,
  -- Lost-update CAS: bumped by EVERY state mutation, including a valid holder's.
  state_version     INTEGER NOT NULL DEFAULT 0,
  -- Claim-validity CAS: authoritative here, NOT on individual claim rows.
  -- Bumped by every write that can change claim resolution.
  claim_generation  INTEGER NOT NULL DEFAULT 0,
  -- Persisted machine lifecycle: running | completed | stopped. recoveryRequired
  -- persists as 'running'; it is a machine state, not a lifecycle value.
  lifecycle         TEXT    NOT NULL,
  -- Authoritative RunbookState JSON, with the coordinated fields (claims, stack,
  -- stash, resolved completions) excluded — those tables are their sole home.
  state_json        TEXT    NOT NULL,
  -- Active execution identity. All NULL when no attempt owns the run. exec_token
  -- is the HASHED bearer secret; exec_epoch references the active attempt row.
  exec_pid          INTEGER,
  exec_token        TEXT,
  exec_epoch        INTEGER,
  exec_start_id     TEXT,
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL
);

CREATE TABLE claims (
  key               TEXT    PRIMARY KEY NOT NULL,
  controlled_run    TEXT    NOT NULL,
  secret_hash       TEXT    NOT NULL,
  -- Immutable issuance generation retained as metadata only; commit validity
  -- compares the captured value against runs.claim_generation.
  issued_generation INTEGER NOT NULL,
  -- active | superseded. Rotated/released claims remain as superseded tombstones
  -- while any active/recovery attempt can reference their issuance.
  status            TEXT    NOT NULL DEFAULT 'active',
  -- Delegation linkage, NULL for non-delegated claims.
  parent_run_id     TEXT,
  parent_linkage_version INTEGER,
  delegation_json   TEXT,
  grants_json       TEXT    NOT NULL,
  issued_at         TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL,
  -- #519 claim-activity liveness. Distinct from updated_at ("record last
  -- written"); refreshed only at the authorization seam.
  last_seen_at      TEXT    NOT NULL,
  FOREIGN KEY (controlled_run) REFERENCES runs(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_run_id)  REFERENCES runs(id) ON DELETE SET NULL
);

CREATE INDEX claims_controlled_run ON claims(controlled_run);
CREATE INDEX claims_parent_run     ON claims(parent_run_id);

-- The single project default stack. position 0 is the bottom of the stack.
CREATE TABLE session_stack (
  position          INTEGER PRIMARY KEY NOT NULL,
  run_id            TEXT    NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);

-- The single project stash slot. At most one row (slot fixed at 0); an empty
-- stash is the absence of the row.
CREATE TABLE stash_slot (
  slot              INTEGER PRIMARY KEY NOT NULL CHECK (slot = 0),
  run_id            TEXT    NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE TABLE resolved_completions (
  run_id            TEXT    NOT NULL,
  completion_key    TEXT    NOT NULL,
  payload_json      TEXT    NOT NULL,
  created_at        TEXT    NOT NULL,
  PRIMARY KEY (run_id, completion_key),
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);

-- Single authoritative home of execution phase; phase is NOT duplicated on runs.
CREATE TABLE execution_attempts (
  run_id            TEXT    NOT NULL,
  exec_epoch        INTEGER NOT NULL,
  -- Hashed ExecutionToken bearer secret; never the raw token.
  exec_token        TEXT    NOT NULL,
  -- claimed | effect_started | recovery_pending | committed
  phase             TEXT    NOT NULL,
  owner_pid         INTEGER NOT NULL,
  owner_start_id    TEXT,
  -- Closed recovery-reason union member, NULL until recovery.
  reason            TEXT,
  started_at        TEXT    NOT NULL,
  effect_started_at TEXT,
  finished_at       TEXT,
  PRIMARY KEY (run_id, exec_epoch),
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);
`;

/**
 * Read the database's `user_version`.
 *
 * @param tx - Open transaction to read through.
 * @returns The integer schema version (`0` for a fresh database).
 */
export function readSchemaVersion(tx: SqlTransaction): number {
  const row = tx.prepare('PRAGMA user_version').get<{ readonly user_version: number }>();
  return row?.user_version ?? UNINITIALIZED_VERSION;
}

/**
 * Install schema version {@link SCHEMA_VERSION} into a fresh database.
 *
 * Must run inside a writing transaction. Executes the DDL and stamps
 * `user_version` last so a crash mid-install is re-installable.
 *
 * @param tx - Open writing transaction.
 */
export function installSchema(tx: SqlTransaction): void {
  tx.exec(SCHEMA_DDL);
  // PRAGMA user_version does not accept a bound parameter; SCHEMA_VERSION is a
  // trusted integer constant, so interpolation is safe here.
  tx.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION)}`);
}

/**
 * Ensure a database carries exactly schema version {@link SCHEMA_VERSION}.
 *
 * A fresh database (version `0`) is installed. A database already at
 * {@link SCHEMA_VERSION} is left untouched. Any other version is rejected with
 * an {@link IncompatibleSchemaError} — never migrated.
 *
 * This routine performs check-then-install and MUST run inside a single writing
 * transaction so two processes racing to initialize a clean database cannot both
 * install (one wins the write lock; the other observes the installed version).
 *
 * @param tx - Open writing transaction.
 * @throws {IncompatibleSchemaError} When the database version is neither `0` nor
 *   {@link SCHEMA_VERSION}.
 */
export function ensureSchema(tx: SqlTransaction): void {
  const version = readSchemaVersion(tx);
  if (version === SCHEMA_VERSION) {
    return;
  }
  if (version === UNINITIALIZED_VERSION) {
    installSchema(tx);
    return;
  }
  throw new IncompatibleSchemaError(version, SCHEMA_VERSION);
}
