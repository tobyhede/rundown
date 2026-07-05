import { describe, expect, it } from '@jest/globals';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertDelegationTokenHash,
  assertClaimCapability,
  type DelegationLinkage,
  type ClaimRecord,
  type ClaimCapability,
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

  it('refreshes a claim lease only when the claim capability verifies', async () => {
    const setup = await createClaimedChildFixture();
    try {
      const refreshed = await setup.session.refreshClaimLease(setup.claimCapability);

      expect(refreshed.status).toBe('refreshed');
      if (refreshed.status !== 'refreshed') throw new Error('expected refreshed');
      expect(Date.parse(refreshed.claim.leaseHeartbeatAt ?? '')).toBeGreaterThan(
        Date.parse(setup.claim.leaseHeartbeatAt ?? ''),
      );
    } finally {
      await rm(setup.cwd, { recursive: true, force: true });
    }
  });

  it('lists expired open claims for parent-side recovery', async () => {
    const setup = await createClaimedChildFixture({
      leaseHeartbeatAt: '2026-07-05T00:00:00.000Z',
      leaseExpiresAt: '2026-07-05T00:01:00.000Z',
    });
    try {
      const expired = await setup.session.listExpiredOpenClaimsForParent(
        setup.parent.id,
        new Date('2026-07-05T00:02:00.000Z'),
      );

      expect(expired.map((claim) => claim.claimId)).toEqual([setup.claim.claimId]);
    } finally {
      await rm(setup.cwd, { recursive: true, force: true });
    }
  });

  it('lets an explicit operator release an abandoned claim without a child proof', async () => {
    const setup = await createClaimedChildFixture();
    try {
      const released = await setup.session.operatorReleaseClaim(
        setup.claim.claimId,
        'abandoned-child',
      );

      expect(released.status).toBe('released');
      if (released.status !== 'released') throw new Error('expected released');
      expect(released.claim.claimId).toBe(setup.claim.claimId);

      const loaded = await setup.manager.loadSession();
      expect(loaded.claims[setup.claim.claimId]).toBeUndefined();
    } finally {
      await rm(setup.cwd, { recursive: true, force: true });
    }
  });

  it.each([
    [
      'terminal',
      async (setup: Awaited<ReturnType<typeof createClaimedChildFixture>>) => {
        await setup.manager.save({ ...setup.child, lifecycle: 'completed' });
      },
    ],
    [
      'stale',
      async (setup: Awaited<ReturnType<typeof createClaimedChildFixture>>) => {
        await rm(join(setup.cwd, '.rundown', 'runs', `${setup.child.id}.json`));
      },
    ],
    [
      'unlinked',
      async (setup: Awaited<ReturnType<typeof createClaimedChildFixture>>) => {
        await setup.manager.save({ ...setup.child, parentLinkage: undefined });
      },
    ],
  ])('treats a forged claim capability for a %s claim as missing', async (_label, arrange) => {
    const setup = await createClaimedChildFixture();
    try {
      await arrange(setup);

      const forged = forgeClaimCapability(setup.claim.claimId);
      const resolved = await setup.session.getActiveForClaimCapability(forged);

      expect(resolved).toEqual({ status: 'missing', claimId: setup.claim.claimId });
    } finally {
      await rm(setup.cwd, { recursive: true, force: true });
    }
  });
});

async function createClaimedChildFixture(
  overrides: Partial<Pick<ClaimRecord, 'leaseHeartbeatAt' | 'leaseExpiresAt'>> = {},
): Promise<{
  readonly cwd: string;
  readonly manager: RunbookStateManager;
  readonly session: SessionService;
  readonly parent: RunbookState;
  readonly child: RunbookState;
  readonly claim: ClaimRecord;
  readonly claimCapability: ClaimCapability;
}> {
  const cwd = await mkdtemp(join(tmpdir(), 'rd-session-cap-'));
  const manager = new RunbookStateManager(cwd);
  const session = new SessionService(manager);
  const parent = await createRunningState(manager, 'parent.md');
  const linkage = delegationLinkage(parent.id);
  const child = await createRunningState(manager, 'child.md', { parentLinkage: linkage });
  const claimed = await session.claimRunbook(child.id, linkage);
  if (claimed.status !== 'claimed') throw new Error(`expected claimed, got ${claimed.status}`);

  if (Object.keys(overrides).length > 0) {
    const loaded = await manager.loadSession();
    loaded.claims[claimed.claim.claimId] = { ...claimed.claim, ...overrides };
    await manager.saveSession(loaded);
    const refreshed = loaded.claims[claimed.claim.claimId];
    if (!refreshed) throw new Error('expected refreshed claim fixture');
    return {
      cwd,
      manager,
      session,
      parent,
      child,
      claim: refreshed,
      claimCapability: claimed.claimCapability,
    };
  }

  return {
    cwd,
    manager,
    session,
    parent,
    child,
    claim: claimed.claim,
    claimCapability: claimed.claimCapability,
  };
}

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

function forgeClaimCapability(claimId: string): ClaimCapability {
  return assertClaimCapability(`rdcc_${claimId.slice('rdclm_'.length)}_${'A'.repeat(43)}`);
}
