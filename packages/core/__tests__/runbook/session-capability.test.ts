import { describe, expect, it } from '@jest/globals';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertDelegationTokenHash,
  type DelegationLinkage,
  type RunbookState,
} from '../../src/runbook/index.js';
import { SessionService } from '../../src/runbook/session-service.js';
import { RunbookStateManager } from '../../src/runbook/state.js';
import type { RunId } from '../../src/runbook/run-id.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import { makeBaseStep } from '../helpers/step-factories.js';

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

  it('returns a claim capability once and stores only its hash', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'rd-session-cap-'));
    try {
      const manager = new RunbookStateManager(cwd);
      const session = new SessionService(manager);
      const parent = await createRunningState(manager, 'parent.md');
      const child = await createRunningState(manager, 'child.md', {
        parentLinkage: delegationLinkage(parent.id),
      });

      const claimed = await session.claimRunbook(child.id, delegationLinkage(parent.id));

      expect(claimed.status).toBe('claimed');
      if (claimed.status !== 'claimed') throw new Error('expected claimed');
      expect(claimed.claimCapability).toMatch(/^rdcc_/);
      expect(JSON.stringify(claimed.claim)).not.toContain(claimed.claimCapability);
      expect(claimed.claim.claimCapabilityHash).toMatch(/^sha256:/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

async function createRunningState(
  manager: RunbookStateManager,
  runbookPath: string,
  options: { readonly parentLinkage?: DelegationLinkage } = {},
): Promise<RunbookState> {
  const created = await manager.create(
    { source: 'project', path: runbookPath },
    {
      title: runbookPath,
      description: '',
      steps: [makeBaseStep({ name: '1', description: 'Step 1' })],
    },
    {
      runbookPath,
      ...(options.parentLinkage !== undefined ? { parentLinkage: options.parentLinkage } : {}),
    },
  );
  return created.state;
}

function delegationLinkage(parentRunId: RunId): DelegationLinkage {
  return {
    kind: 'delegation',
    parentRunId,
    parentStepId: '1.1',
    parentStep: 'Parent',
    parentFrameKey: buildFrameKey('1.1'),
    parentEntry: 1,
    tokenHash: assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`),
  };
}
