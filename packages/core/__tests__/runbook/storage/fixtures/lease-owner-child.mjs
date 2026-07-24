// Test-only worker: a REAL separate OS process that acquires execution ownership
// of a run (with its own pid), signals readiness, then hangs so the parent can
// kill it at a chosen phase and exercise dead-owner recovery. Uses raw
// node:sqlite so it needs no TypeScript loader.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const [dbPath, runId, phase, readyFile] = process.argv.slice(2);

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
  `INSERT INTO execution_attempts (run_id, exec_epoch, exec_token, phase, owner_pid, started_at, effect_started_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
).run(runId, epoch, hash, phase, process.pid, now, phase === 'effect_started' ? now : null);
db.prepare('UPDATE runs SET exec_pid = ?, exec_token = ?, exec_epoch = ? WHERE id = ?').run(
  process.pid,
  hash,
  epoch,
  runId,
);
db.exec('COMMIT');
db.close();

// Signal readiness only after ownership is durably committed.
writeFileSync(readyFile, String(process.pid));

// Hang until the parent kills us.
setInterval(() => {}, 1000);
