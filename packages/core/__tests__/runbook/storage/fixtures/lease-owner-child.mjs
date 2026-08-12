// Test-only worker: a REAL separate OS process that acquires execution ownership
// of a run (with its own pid), signals readiness, then hangs so the parent can
// kill it at a chosen phase and exercise dead-owner recovery. Uses raw
// node:sqlite so it needs no TypeScript loader.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const [dbPath, runId, phase, readyFile] = process.argv.slice(2);

/**
 * This process's host start id, as `runbook/process-identity` would record it.
 *
 * A deliberate duplicate: this fixture must run without a TypeScript loader, so
 * it cannot import the real reader. The duplication is pinned, not trusted — the
 * parent asserts this value equals `readProcessStartId(childPid)`, so a format
 * change on either side fails that test rather than silently drifting.
 *
 * @returns The start id, or `null` on a host that has none.
 */
function ownStartId() {
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
      const fields = stat
        .slice(stat.lastIndexOf(')') + 1)
        .trim()
        .split(/\s+/);
      const startTime = fields[19];
      return startTime !== undefined && /^\d+$/.test(startTime) ? startTime : null;
    }
    if (process.platform === 'darwin') {
      const out = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(process.pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        // Must match PS_CANONICAL_ENV: `lstart` renders in the caller's TZ.
        env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
      }).trim();
      return out === '' ? null : out;
    }
  } catch {
    return null;
  }
  return null;
}

const startId = ownStartId();

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA foreign_keys = ON');

const token = randomBytes(32).toString('base64url');
const hash = `sha256:${createHash('sha256').update(token).digest('hex')}`;
const now = new Date().toISOString();

db.exec('BEGIN IMMEDIATE');
const epoch = db
  .prepare('SELECT COALESCE(MAX(exec_epoch), 0) + 1 AS n FROM execution_attempts WHERE run_id = ?')
  .get(runId).n;
db.prepare(
  `INSERT INTO execution_attempts (run_id, exec_epoch, exec_token, phase, owner_pid, owner_start_id, started_at, effect_started_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
).run(
  runId,
  epoch,
  hash,
  phase,
  process.pid,
  startId,
  now,
  phase === 'effect_started' ? now : null,
);
db.prepare(
  'UPDATE runs SET exec_pid = ?, exec_token = ?, exec_epoch = ?, exec_start_id = ? WHERE id = ?',
).run(process.pid, hash, epoch, startId, runId);
db.exec('COMMIT');
db.close();

// Signal readiness only after ownership is durably committed.
writeFileSync(readyFile, String(process.pid));

// Hang until the parent kills us.
setInterval(() => {}, 1000);
