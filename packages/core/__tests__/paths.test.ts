// packages/core/__tests__/paths.test.ts

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  completionLockPath,
  CONTEXTS_DIR,
  delegationLockPath,
  ensureStateDirs,
  LIFECYCLE_WRITE_LOG_FILE,
  lifecycleWriteLogPath,
  LOCKS_DIR,
  logsDir,
  runStateLockPath,
  RUNS_DIR,
  statePath,
  WORK_DIR,
} from '../src/paths.js';

describe('assertSafeId (via path builders)', () => {
  const cwd = '/tmp/project';

  describe('rejects unsafe ids that would enable path traversal', () => {
    const builders: Array<{
      name: string;
      build: (id: string) => string;
    }> = [
      { name: 'completionLockPath', build: (id) => completionLockPath(cwd, id) },
      { name: 'delegationLockPath', build: (id) => delegationLockPath(cwd, id) },
      { name: 'runStateLockPath', build: (id) => runStateLockPath(cwd, id) },
      { name: 'statePath', build: (id) => statePath(cwd, id) },
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

describe('lifecycle write log paths', () => {
  it('resolves logsDir under .rundown', () => {
    expect(logsDir('/proj')).toBe('/proj/.rundown/logs');
  });

  it('resolves lifecycleWriteLogPath to the JSONL file', () => {
    expect(lifecycleWriteLogPath('/proj')).toBe('/proj/.rundown/logs/lifecycle-writes.jsonl');
    expect(LIFECYCLE_WRITE_LOG_FILE).toBe('.rundown/logs/lifecycle-writes.jsonl');
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
