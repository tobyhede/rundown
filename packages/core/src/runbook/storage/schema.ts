/**
 * SQLite schema for the Rundown runbook state store.
 *
 * Defines the authoritative schema version, the DDL for the single `runs`
 * table, and the version-checking install/validate routines. One writer per
 * run (ADR 0005): every run has exactly one Run Owner, proven by the Owner
 * Token whose hash lives on the row, and only that owner's commands write it.
 * There is no claims table, no session stack, no stash slot, no completion
 * mailbox and no execution-attempts ledger — each of those existed to let a
 * second writer into the row, and the one-writer model removes the writer
 * rather than coordinating it.
 *
 * The schema version is stored in SQLite's built-in `PRAGMA user_version`. It is
 * atomic, cheap, and identical across both adapters. An on-disk database whose
 * version is neither `0` (fresh) nor {@link SCHEMA_VERSION} is rejected, never
 * migrated (see the no-migration rule in CLAUDE.md).
 *
 * @module runbook/storage/schema
 */

import type { SqlReadTransaction, SqlTransaction } from './sql-driver.js';

/**
 * Current schema version.
 *
 * Persisted runbook state is never migrated. State written under any other
 * version is invalid and rejected with an {@link IncompatibleSchemaError}; the
 * recovery path is explicit user action (finish, stop, prune, restart).
 *
 * Version 3 was the one-writer-per-run schema (ADR 0005, #901): a single `runs`
 * table carrying the Owner Token hash, nullable child-linkage and lease column
 * groups, and `state_version`. Version 4 (#902) makes a write to the lease
 * columns move `state_version` too, so the lease's attempt is a version and a
 * reader from before the lease cannot write after it. Versions 1 and 2 carried
 * the multi-writer tables (`claims`, `session_stack`, `stash_slot`, `resolved_completions`,
 * `execution_attempts`); a database at either version is foreign to this build
 * and is refused whole, because none of its coordinating rows has a home here.
 *
 * **Not the same version as `CURRENT_SCHEMA_VERSION`, and neither one covers
 * the other.** This constant gates the DDL — the whole database, via
 * `PRAGMA user_version`, refused as {@link IncompatibleSchemaError} / RD-305.
 * `CURRENT_SCHEMA_VERSION` (`runbook/persisted-state-guards.ts`) gates the run
 * state inside each `runs.state_json` blob, one row at a time, refused as
 * RD-309. `state_json` is opaque TEXT to this DDL, so a change to the persisted
 * run-state shape moves that constant and not this one; a DDL edit moves this
 * and leaves that. Both read `3` after #901, which changed the tables and the
 * blob at once; #902 moved this one to `4` for a DDL-only change (the lease
 * trigger) and left the blob's version alone. Version 5 (#903) lets an Inline
 * Child's row carry no Owner Token hash: its parent's token authorizes it, so
 * `owner_token_hash` is nullable exactly when `parent_kind` is `inline`.
 * Version 6 (#903) rewrites the `runs_unlink_children` trigger so a child
 * that is not inline, linked to an Inline Child the trigger deletes, is
 * unlinked rather than left dangling (which the foreign key refused, aborting
 * the whole delete). Version 7 (#904) adds `claim_agent_id`: the agent id
 * `rundown claim` records on a Delegation's row, the identity a later
 * `release` is matched against. It belongs to the linkage: the unlink trigger
 * clears it with the rest of the group.
 */
export const SCHEMA_VERSION = 7;

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
        `expected ${String(expectedVersion)}. Rundown never migrates persisted state. ` +
        `Any in-flight runs in this database are unrecoverable — delete ` +
        `\`.rundown/rundown.db\` and restart your runbooks from source.`,
    );
    this.name = 'IncompatibleSchemaError';
    this.foundVersion = foundVersion;
    this.expectedVersion = expectedVersion;
  }
}

/**
 * DDL statements installing schema version {@link SCHEMA_VERSION}.
 *
 * Every closed union in the model is pinned by a `CHECK` constraint, so a value
 * outside it cannot be persisted even by a caller that bypasses the typed store.
 * The two nullable column groups (`parent_*`, `lease_*`) are all-or-none under
 * their own `CHECK`s, so a half-written linkage or lease is unrepresentable.
 *
 * `state_version` is owned solely by the `runs_bump_state_version` trigger: it
 * advances on every `state_json` or `lease_attempt` write, for any writer
 * present or future, so the conditional `UPDATE … WHERE state_version =
 * :expected` in the store is a complete lost-update check by construction
 * rather than by call-site discipline. Covering the lease column is what makes
 * the execution lease (#902) a version: setting it refuses every reader that
 * read the run before it, and its attempt is the version it produced.
 *
 * Child linkage is cleared by the `runs_unlink_children` trigger when the
 * parent row is deleted, not by `ON DELETE SET NULL`: the referential action
 * nulls `parent_run_id` alone, which the all-or-none `CHECK` then refuses, so
 * the parent could never be pruned while a child row remained. The trigger
 * clears the whole group inside the same statement, and the foreign key (no
 * action) still refuses any other write that would leave a dangling reference.
 * The same trigger also deletes the deleted run's Inline Children and theirs,
 * transitively (#903): an Inline Child carries no Owner Token of its own, so
 * once the run whose token authorized it is gone nothing can reach it, and
 * unlinking it would leave a row the token `CHECK` refuses. The unlink runs
 * first and covers every run the delete removes — the deleted row and each
 * inline descendant — because the nested `DELETE` does not re-fire this
 * trigger (`recursive_triggers` is off): a child that is not inline, linked to
 * an inline descendant, would otherwise be left naming a deleted row, and the
 * foreign key would refuse the whole delete.
 *
 * `PRAGMA user_version` is set last, inside the same transaction, so a crash
 * mid-install leaves the version at `0` and the next open re-installs rather
 * than adopting a partial schema.
 */
const SCHEMA_DDL = `
CREATE TABLE runs (
  id                TEXT    PRIMARY KEY NOT NULL,
  -- Persisted machine lifecycle. 'abandoned' is written only by \`rundown
  -- release\` on a child's own row (ADR 0005) and collects as a fail.
  lifecycle         TEXT    NOT NULL
                            CHECK (lifecycle IN ('running', 'completed', 'stopped', 'abandoned')),
  -- SHA-256 hash of the run's Owner Token. The token itself is printed once at
  -- \`rundown run\` and never stored; this hash is the sole authority lookup key.
  -- NULL exactly for an Inline Child (#903), which has no token of its own: its
  -- parent's Owner Token authorizes it (CHECK below).
  owner_token_hash  TEXT    UNIQUE,
  -- Child linkage (nullable all-or-none; written by #903/#904).
  -- parent_step is the qualified parent unit (\`step.substep\`) the child runs for;
  -- parent_frame_key and parent_entry name the frame entry that reserved it.
  -- parent_kind: 'delegation' | 'inline'.
  parent_run_id     TEXT,
  parent_step       TEXT,
  parent_frame_key  TEXT,
  parent_entry      INTEGER,
  parent_kind       TEXT    CHECK (parent_kind IS NULL OR parent_kind IN ('delegation', 'inline')),
  -- The agent id \`rundown claim --agent-id\` recorded for a Delegation (#904);
  -- NULL for every other row, and for a claim made without one.
  claim_agent_id    TEXT    CHECK (claim_agent_id IS NULL OR COALESCE(parent_kind, '') = 'delegation'),
  -- Execution lease (nullable all-or-none). Set by one conditional update
  -- before an external effect; cleared by the state write that commits its
  -- finish. lease_attempt is the state_version the set produced.
  -- lease_start_id may be NULL where the host supplies no process start id.
  lease_attempt     INTEGER,
  lease_pid         INTEGER,
  lease_start_id    TEXT,
  lease_started_at  TEXT,
  -- Lost-update counter: bumped by the trigger below on every state_json or
  -- lease_attempt write.
  state_version     INTEGER NOT NULL DEFAULT 0,
  -- Authoritative RunbookState JSON, minus \`lifecycle\`, whose home is its own
  -- column so the CHECK above can pin it.
  state_json        TEXT    NOT NULL,
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL,
  CHECK (
    (parent_run_id IS NULL AND parent_step IS NULL AND parent_frame_key IS NULL
      AND parent_entry IS NULL AND parent_kind IS NULL)
    OR (parent_run_id IS NOT NULL AND parent_step IS NOT NULL AND parent_frame_key IS NOT NULL
      AND parent_entry IS NOT NULL AND parent_kind IS NOT NULL)
  ),
  CHECK ((owner_token_hash IS NULL) = (COALESCE(parent_kind, '') = 'inline')),
  CHECK (
    (lease_attempt IS NULL AND lease_pid IS NULL AND lease_start_id IS NULL
      AND lease_started_at IS NULL)
    OR (lease_attempt IS NOT NULL AND lease_pid IS NOT NULL AND lease_started_at IS NOT NULL)
  ),
  FOREIGN KEY (parent_run_id) REFERENCES runs(id)
);

CREATE INDEX runs_parent_run ON runs(parent_run_id);

CREATE TRIGGER runs_bump_state_version AFTER UPDATE OF state_json, lease_attempt ON runs
BEGIN
  UPDATE runs SET state_version = state_version + 1 WHERE id = NEW.id;
END;

CREATE TRIGGER runs_unlink_children AFTER DELETE ON runs
BEGIN
  UPDATE runs
     SET parent_run_id = NULL, parent_step = NULL, parent_frame_key = NULL,
         parent_entry = NULL, parent_kind = NULL, claim_agent_id = NULL
   WHERE parent_kind IS NOT 'inline' AND parent_run_id IN (
     WITH RECURSIVE removed(id) AS (
       SELECT OLD.id
       UNION
       SELECT runs.id FROM runs
         JOIN removed ON runs.parent_run_id = removed.id
        WHERE runs.parent_kind = 'inline'
     )
     SELECT id FROM removed
   );
  DELETE FROM runs WHERE id IN (
    WITH RECURSIVE inline_descendants(id) AS (
      SELECT id FROM runs WHERE parent_run_id = OLD.id AND parent_kind = 'inline'
      UNION
      SELECT runs.id FROM runs
        JOIN inline_descendants ON runs.parent_run_id = inline_descendants.id
       WHERE runs.parent_kind = 'inline'
    )
    SELECT id FROM inline_descendants
  );
END;`;

/**
 * Read the database's `user_version`.
 *
 * Takes the read-only transaction type so it is callable from `read` work as
 * well as from the writing `ensureSchema` path.
 *
 * @param tx - Open transaction to read through.
 * @returns The integer schema version (`0` for a fresh database).
 */
export function readSchemaVersion(tx: SqlReadTransaction): number {
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
