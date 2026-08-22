import { describe, it, expect } from '@jest/globals';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FOREIGN_SCHEMA_VERSION,
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
  popTopOfStackUnverified,
  unwrapSessionMutation,
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
    await patchPersistedRunState(cwd, a.runId, { schemaVersion: FOREIGN_SCHEMA_VERSION });
    expect((await readPersistedRunState(cwd, a.runId))?.schemaVersion).toBe(FOREIGN_SCHEMA_VERSION);
    await writeRawRunJson(cwd, a.runId, '{invalid');
    await expect(readPersistedRunState(cwd, a.runId)).rejects.toThrow();
    await deletePersistedRunState(cwd, a.runId);
    expect(await readPersistedRunState(cwd, a.runId)).toBeNull();
  });

  it('pops the stack top, revokes its claims, and reports the run beneath it', async () => {
    // The positional pop product code no longer performs, kept here so the few
    // core tests that need a multi-level stack can unwind one. It is the ONLY
    // caller of the release projection outside product code, so nothing else
    // pins that it disposes of the popped run the way the old positional pop
    // did — claims included.
    const cwd = await mkdtemp(join(tmpdir(), 'sf-'));
    const under = await seedActiveRun(cwd);
    const top = await seedActiveRun(cwd, { withRunControlClaim: false });
    await seedSession(cwd, { defaultStack: [under.runId, top.runId] });
    const topClaim = await issueRunControlClaimFor(cwd, top.runId);
    expect(topClaim).toMatch(/^rdclm_/);
    const m = new RunbookStateManager(cwd);

    const nextTop = unwrapSessionMutation(await popTopOfStackUnverified(m));

    expect(nextTop).toBe(under.runId);
    const session = await m.loadSession();
    expect(session.defaultStack).toEqual([under.runId]);
    // `collateral` revokes: the popped run keeps existing, but no claim may
    // still address it. The run beneath is untouched on both counts.
    expect(Object.values(session.claims).map((claim) => claim.controlledRunId)).toEqual([
      under.runId,
    ]);
  });

  it('pops nothing and reports null on an empty stack', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'sf-'));
    await seedSession(cwd, { defaultStack: [] });
    const m = new RunbookStateManager(cwd);

    expect(unwrapSessionMutation(await popTopOfStackUnverified(m))).toBeNull();
    expect((await m.loadSession()).defaultStack).toEqual([]);
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
