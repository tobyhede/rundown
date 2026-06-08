import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunbookStateManager } from '../../src/runbook/state.js';
import { SessionService } from '../../src/runbook/session-service.js';
import {
  resolveCommandTarget,
  resolveTransitionTarget,
} from '../../src/runbook/command-target-resolver.js';
import { assertClaimId } from '../../src/runbook/claim-id.js';
import { makeBaseStep } from '../helpers/step-factories.js';
import type { Step, Runbook, RunbookState } from '../../src/runbook/types.js';
import { linkageFor, assertClaimed } from './claim-test-helpers.js';

const parent = { id: 'parent', lifecycle: 'running' } as RunbookState;
const child = { id: 'child', lifecycle: 'running' } as RunbookState;

describe('resolveCommandTarget', () => {
  it('resolves explicit claim id before default stack', async () => {
    const claimId = assertClaimId('rdclm_abcdefghijklmnopqrstu1');
    const sessionService = {
      getActiveForClaimId: async () => ({
        status: 'claimed' as const,
        claim: {
          kind: 'claim-record',
          claimId,
          childRunId: 'child',
          tokenHash: `sha256:${'a'.repeat(64)}`,
          parentRunId: 'parent',
          parentStepId: '1.1',
          claimedAt: '2026-05-01T00:00:00.000Z',
          updatedAt: '2026-05-01T00:00:00.000Z',
        },
        state: child,
      }),
      getActive: async () => parent,
    } as unknown as SessionService;

    const result = await resolveCommandTarget(sessionService, { claimId });

    expect(result.kind).toBe('claim');
    if (result.kind === 'claim') {
      expect(result.state.id).toBe('child');
    }
  });

  it('does not fall back when explicit claim id is missing', async () => {
    const claimId = assertClaimId('rdclm_abcdefghijklmnopqrstu1');
    const sessionService = {
      getActiveForClaimId: async () => ({ status: 'missing' as const, claimId }),
      getActive: async () => parent,
    } as unknown as SessionService;

    const result = await resolveCommandTarget(sessionService, { claimId });

    expect(result.kind).toBe('stale_claim');
    if (result.kind === 'stale_claim') {
      expect(result.message).toContain('Claim id');
    }
  });

  it('preserves terminal claim resolution with final child state', async () => {
    const claimId = assertClaimId('rdclm_abcdefghijklmnopqrstu1');
    const terminalChild = { ...child, lifecycle: 'completed' } as RunbookState;
    const sessionService = {
      getActiveForClaimId: async () => ({
        status: 'terminal' as const,
        claim: {
          kind: 'claim-record',
          claimId,
          childRunId: 'child',
          tokenHash: `sha256:${'a'.repeat(64)}`,
          parentRunId: 'parent',
          parentStepId: '1.1',
          claimedAt: '2026-05-01T00:00:00.000Z',
          updatedAt: '2026-05-01T00:00:00.000Z',
        },
        lifecycle: 'completed' as const,
        state: terminalChild,
      }),
      getActive: async () => parent,
    } as unknown as SessionService;

    const result = await resolveCommandTarget(sessionService, { claimId });

    expect(result.kind).toBe('terminal_claim');
    if (result.kind === 'terminal_claim') {
      expect(result.lifecycle).toBe('completed');
      expect(result.state.id).toBe('child');
    }
  });

  it('resolves default stack when no claim id is supplied', async () => {
    const sessionService = {
      getActive: async () => parent,
    } as unknown as SessionService;

    const result = await resolveCommandTarget(sessionService, {});

    expect(result).toEqual({ kind: 'default', state: parent });
  });
});

describe('resolveTransitionTarget', () => {
  let testDir: string;
  let manager: RunbookStateManager;
  let sessionService: SessionService;
  const mockSteps: Step[] = [makeBaseStep({ name: '1', description: 'Initial step' })];
  const mockRunbook: Runbook = { title: 'Test Runbook', description: 'A test', steps: mockSteps };

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'transition-target-'));
    manager = new RunbookStateManager(testDir);
    sessionService = new SessionService(manager);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('refuses a default parent target with open delegated child claims (pass)', async () => {
    const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
      runbookPath: 'parent.md',
    });
    const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
      runbookPath: 'child.md',
      parentLinkage: linkageFor(parent.id, 'a'),
    });
    await sessionService.pushRunbook(parent.id);
    const claimed = assertClaimed(
      await sessionService.claimRunbook(child.id, linkageFor(parent.id, 'a')),
    );

    await expect(resolveTransitionTarget(sessionService, { command: 'pass' })).resolves.toEqual({
      kind: 'open_delegated_children',
      parentRunId: parent.id,
      claims: [claimed.claim],
    });
  });

  it('refuses a default parent target with open delegated child claims (fail)', async () => {
    const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
      runbookPath: 'parent.md',
    });
    const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
      runbookPath: 'child.md',
      parentLinkage: linkageFor(parent.id, 'a'),
    });
    await sessionService.pushRunbook(parent.id);
    const claimed = assertClaimed(
      await sessionService.claimRunbook(child.id, linkageFor(parent.id, 'a')),
    );

    await expect(resolveTransitionTarget(sessionService, { command: 'fail' })).resolves.toEqual({
      kind: 'open_delegated_children',
      parentRunId: parent.id,
      claims: [claimed.claim],
    });
  });

  it('resolves default active runbook when there are no open delegated child claims', async () => {
    const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
      runbookPath: 'parent.md',
    });
    await sessionService.pushRunbook(parent.id);

    await expect(resolveTransitionTarget(sessionService, { command: 'pass' })).resolves.toEqual({
      kind: 'default',
      state: expect.objectContaining({ id: parent.id }),
    });
  });

  it('returns kind none when there is no active runbook and no claim id', async () => {
    await expect(resolveTransitionTarget(sessionService, { command: 'pass' })).resolves.toEqual({
      kind: 'none',
    });
  });

  it('resolves an explicit live claim without checking parent open claims', async () => {
    const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
      runbookPath: 'parent.md',
    });
    const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
      runbookPath: 'child.md',
      parentLinkage: linkageFor(parent.id, 'a'),
    });
    await sessionService.pushRunbook(parent.id);
    const claimed = assertClaimed(
      await sessionService.claimRunbook(child.id, linkageFor(parent.id, 'a')),
    );

    await expect(
      resolveTransitionTarget(sessionService, { command: 'pass', claimId: claimed.claim.claimId }),
    ).resolves.toEqual({
      kind: 'claim',
      claimId: claimed.claim.claimId,
      claim: claimed.claim,
      state: expect.objectContaining({ id: child.id }),
    });
  });

  it('confirms a terminal claim when requested result matches child lifecycle', async () => {
    const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
      runbookPath: 'parent.md',
    });
    const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
      runbookPath: 'child.md',
      parentLinkage: linkageFor(parent.id, 'a'),
    });
    const claimed = assertClaimed(
      await sessionService.claimRunbook(child.id, linkageFor(parent.id, 'a')),
    );
    await manager.update(child.id, { lifecycle: 'completed' });

    await expect(
      resolveTransitionTarget(sessionService, { command: 'pass', claimId: claimed.claim.claimId }),
    ).resolves.toMatchObject({
      kind: 'terminal_claim_confirmed',
      claimId: claimed.claim.claimId,
      lifecycle: 'completed',
      result: 'pass',
    });
  });

  it('reports a terminal claim conflict when requested result differs from child lifecycle', async () => {
    const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
      runbookPath: 'parent.md',
    });
    const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
      runbookPath: 'child.md',
      parentLinkage: linkageFor(parent.id, 'a'),
    });
    const claimed = assertClaimed(
      await sessionService.claimRunbook(child.id, linkageFor(parent.id, 'a')),
    );
    await manager.update(child.id, { lifecycle: 'stopped' });

    await expect(
      resolveTransitionTarget(sessionService, { command: 'pass', claimId: claimed.claim.claimId }),
    ).resolves.toMatchObject({
      kind: 'terminal_claim_conflict',
      claimId: claimed.claim.claimId,
      lifecycle: 'stopped',
      expectedResult: 'fail',
      requestedResult: 'pass',
    });
  });

  it('reports stale_claim for an unknown claim id (missing)', async () => {
    const unknown = assertClaimId('rdclm_abcdefghijklmnopqrstu2');

    await expect(
      resolveTransitionTarget(sessionService, { command: 'pass', claimId: unknown }),
    ).resolves.toMatchObject({
      kind: 'stale_claim',
      claimId: unknown,
      message: expect.stringContaining('does not exist'),
    });
  });

  it('reports stale_claim when the claimed child state was deleted (stale)', async () => {
    const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
      runbookPath: 'parent.md',
    });
    const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
      runbookPath: 'child.md',
      parentLinkage: linkageFor(parent.id, 'a'),
    });
    const claimed = assertClaimed(
      await sessionService.claimRunbook(child.id, linkageFor(parent.id, 'a')),
    );
    await manager.delete(child.id);

    await expect(
      resolveTransitionTarget(sessionService, { command: 'pass', claimId: claimed.claim.claimId }),
    ).resolves.toMatchObject({
      kind: 'stale_claim',
      claimId: claimed.claim.claimId,
      message: expect.stringContaining('missing child state'),
    });
  });

  it('reports stale_claim with rd-pop guidance when the claimed child is stashed (unlinked: stashed)', async () => {
    const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
      runbookPath: 'parent.md',
    });
    const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
      runbookPath: 'child.md',
      parentLinkage: linkageFor(parent.id, 'a'),
    });
    const claimed = assertClaimed(
      await sessionService.claimRunbook(child.id, linkageFor(parent.id, 'a')),
    );
    // Park the claimed child so getActiveForClaimId returns unlinked: 'stashed'.
    await sessionService.pushRunbook(child.id);
    await sessionService.stash();

    await expect(
      resolveTransitionTarget(sessionService, { command: 'pass', claimId: claimed.claim.claimId }),
    ).resolves.toMatchObject({
      kind: 'stale_claim',
      claimId: claimed.claim.claimId,
      message: expect.stringContaining(`rd pop --claim-id ${claimed.claim.claimId}`),
    });
  });

  it('reports stale_claim for a non-stashed unlinked claim (child-linkage-mismatch)', async () => {
    const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
      runbookPath: 'parent.md',
    });
    const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
      runbookPath: 'child.md',
      parentLinkage: linkageFor(parent.id, 'a'),
    });
    const claimed = assertClaimed(
      await sessionService.claimRunbook(child.id, linkageFor(parent.id, 'a')),
    );
    // Diverge the persisted linkage tokenHash so getActiveForClaimId returns
    // unlinked: 'child-linkage-mismatch' (a non-stashed reason). Plan used 'z';
    // that is not valid hex, so we use 'f' — a valid hex fill distinct from 'a'.
    await manager.update(child.id, { parentLinkage: linkageFor(parent.id, 'f') });

    await expect(
      resolveTransitionTarget(sessionService, { command: 'pass', claimId: claimed.claim.claimId }),
    ).resolves.toMatchObject({
      kind: 'stale_claim',
      claimId: claimed.claim.claimId,
      message: expect.stringContaining('no longer linked'),
    });
  });
});
