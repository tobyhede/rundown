import { describe, expect, it } from '@jest/globals';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunbookStateManager } from '../../src/runbook/state.js';

describe('session capability schema', () => {
  it('creates empty sessions with schemaVersion 2', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'rd-session-cap-'));
    try {
      const manager = new RunbookStateManager(cwd);
      await manager.saveSession({ schemaVersion: 2, defaultStack: [], claims: {} });
      const raw = JSON.parse(await readFile(join(cwd, '.rundown', 'session.json'), 'utf8'));
      expect(raw.schemaVersion).toBe(2);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects versionless session files instead of migrating them', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'rd-session-cap-'));
    try {
      await mkdir(join(cwd, '.rundown'), { recursive: true });
      await writeFile(
        join(cwd, '.rundown', 'session.json'),
        JSON.stringify({ defaultStack: [], claims: {} }),
      );
      const manager = new RunbookStateManager(cwd);
      await expect(manager.loadSession()).rejects.toThrow(
        'Session file uses an incompatible schema version. Finish or prune active runbooks and restart.',
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
