// packages/core/__tests__/paths.test.ts

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  CONTEXTS_DIR,
  DB_SIDECAR_SUFFIXES,
  ensureStateDirs,
  LOCKS_DIR,
  RUNS_DIR,
  WORK_DIR,
} from '../src/paths.js';
import { assembleArtifactPath } from '../src/runbook/artifact-paths.js';
import { buildArtifactUri } from '../src/runbook/artifact-uri.js';

describe('assertSafeId (via path builders)', () => {
  const cwd = '/tmp/project';
  const runId = `rd_${'a'.repeat(32)}`;

  describe('rejects unsafe ids that would enable path traversal', () => {
    // Every builder here routes a caller-supplied identity segment through
    // `assertSafeId` before it reaches `path.join`. The guard is the security
    // control — an id that survives it is interpolated into a filename — so it
    // is exercised in each distinct parameter position, not once per module.
    const builders: Array<{
      name: string;
      build: (id: string) => string;
    }> = [
      {
        name: 'assembleArtifactPath (ctx)',
        build: (id) => assembleArtifactPath(cwd, id, 'out.md'),
      },
      { name: 'assembleArtifactPath (file)', build: (id) => assembleArtifactPath(cwd, 'ctx', id) },
      {
        name: 'buildArtifactUri (contextId)',
        build: (id) => buildArtifactUri({ contextId: id, runId, key: 'out.md' }),
      },
    ];

    const badIds = ['..', '.', 'foo/bar', 'foo\\bar', '', '../outside'];

    for (const { name, build } of builders) {
      for (const bad of badIds) {
        it(`${name} throws for ${JSON.stringify(bad)}`, () => {
          expect(() => build(bad)).toThrow(/Invalid/);
        });
      }
    }
  });
});

describe('ensureStateDirs', () => {
  it('creates the rundown state directories under the project root', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rd-paths-state-'));
    try {
      await ensureStateDirs(dir);
      for (const sub of [RUNS_DIR, LOCKS_DIR, CONTEXTS_DIR, WORK_DIR]) {
        expect(existsSync(join(dir, sub))).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent when the directories already exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rd-paths-state-'));
    try {
      await ensureStateDirs(dir);
      await expect(ensureStateDirs(dir)).resolves.toBeUndefined();
      expect(existsSync(join(dir, WORK_DIR))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('DB_SIDECAR_SUFFIXES', () => {
  // The value is a SQLite contract, not a Rundown preference: every consumer
  // (file-mode hardening, the default policy write allow-list, the site's state
  // reset) derives its paths from this tuple, so drift here silently un-hardens,
  // un-grants, or un-deletes real files. Asserting the literal alone would only
  // compare the constant to itself, so the set is checked against what a real
  // WAL-mode database actually leaves on disk.
  it('matches the sidecars a real WAL-mode SQLite database creates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rd-paths-wal-'));
    const dbFile = join(dir, 'rundown.db');
    const db = new DatabaseSync(dbFile);
    try {
      db.exec('PRAGMA journal_mode = WAL');
      // The -wal/-shm pair appears on first write, not on open.
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      db.exec('INSERT INTO t (id) VALUES (1)');

      // Read while the connection is open: closing checkpoints the WAL and
      // removes both sidecars.
      const observed = readdirSync(dir)
        .filter((name) => name !== basename(dbFile))
        .map((name) => name.slice(basename(dbFile).length))
        .sort();

      expect(observed).toEqual([...DB_SIDECAR_SUFFIXES].sort());
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('composes sidecar paths that sit beside the database file', () => {
    const sidecars = DB_SIDECAR_SUFFIXES.map((suffix) => `/repo/.rundown/rundown.db${suffix}`);

    expect(sidecars).toEqual(['/repo/.rundown/rundown.db-wal', '/repo/.rundown/rundown.db-shm']);
  });
});
