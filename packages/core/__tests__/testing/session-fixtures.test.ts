import { describe, it, expect } from '@jest/globals';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  seedActiveRun,
  seedRun,
  seedStashedRun,
  seedSession,
  listPersistedRunIds,
  readPersistedRunState,
  patchPersistedRunState,
  writeRawRunJson,
  deletePersistedRunState,
  issueRunControlClaimFor,
} from '../../src/testing/session-fixtures.js';
import { RunbookStateManager } from '../../src/runbook/state.js';

describe('session-fixtures', () => {
  it('seeds an active run with a claim', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'sf-'));
    const { runId, claimId, state } = await seedActiveRun(cwd);
    expect(claimId).toMatch(/^rdclm_/);
    expect(state.step).toBe('1');
    const m = new RunbookStateManager(cwd);
    const session = await m.loadSession();
    expect(session.defaultStack).toEqual([runId]);
    expect(Object.values(session.claims)[0].controlledRunId).toBe(runId);
    expect(await listPersistedRunIds(cwd)).toEqual([runId]);
  });

  it('seeds without a claim, plain runs, stash, session, and raw mutation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'sf-'));
    const a = await seedActiveRun(cwd, { withRunControlClaim: false });
    expect(a.claimId).toBeUndefined();
    const b = await seedRun(cwd);
    const m = new RunbookStateManager(cwd);
    expect((await m.loadSession()).defaultStack).toEqual([a.runId]);
    const cid = await issueRunControlClaimFor(cwd, b.runId);
    expect(cid).toMatch(/^rdclm_/);
    await seedSession(cwd, { defaultStack: [b.runId, a.runId] });
    expect((await m.loadSession()).defaultStack).toEqual([b.runId, a.runId]);
    await patchPersistedRunState(cwd, a.runId, { schemaVersion: 2 });
    expect((await readPersistedRunState(cwd, a.runId))?.schemaVersion).toBe(2);
    await writeRawRunJson(cwd, a.runId, '{invalid');
    await expect(readPersistedRunState(cwd, a.runId)).rejects.toThrow();
    await deletePersistedRunState(cwd, a.runId);
    expect(await readPersistedRunState(cwd, a.runId)).toBeNull();
  });

  it('seeds a stashed run', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'sf-'));
    const s = await seedStashedRun(cwd, {
      markdown: '# T\n\n## 1. One\n- PASS COMPLETE\n\nBody.\n',
    });
    const m = new RunbookStateManager(cwd);
    const session = await m.loadSession();
    expect(session.stashedRunbookId).toBe(s.runId);
    expect(session.defaultStack).toEqual([]);
  });
});
