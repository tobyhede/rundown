import { describe, it, expect } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CommandTargetReader,
  resolveCommandTarget,
  resolveTransitionTarget,
} from '../../src/runbook/command-target-resolver.js';
import {
  assertClaimId,
  type ClaimId,
  type ClaimIdResolution,
  type ClaimRecord,
} from '../../src/runbook/claim-id.js';
import { assertDelegationTokenHash } from '../../src/runbook/delegation-token.js';
import { RunbookStateManager } from '../../src/runbook/state.js';
import { SessionService } from '../../src/runbook/session-service.js';
import {
  activeFrame,
  buildCompletionKey,
  buildFrameKey,
  buildResolvedCompletion,
} from '../../src/runbook/targeting.js';
import { trustedRunControllerContext } from '../../src/runbook/actor-context.js';
import { makeBaseStep } from '../helpers/step-factories.js';
import type { Runbook, RunbookState, Step } from '../../src/runbook/types.js';
import { assertClaimed, linkageFor } from './claim-test-helpers.js';

const parent = { id: 'parent', lifecycle: 'running' } as RunbookState;
const child = { id: 'child', lifecycle: 'running' } as RunbookState;
const terminalCompletedChild = { ...child, lifecycle: 'completed' } as RunbookState;
const terminalStoppedChild = { ...child, lifecycle: 'stopped' } as RunbookState;
const claimId = assertClaimId('rdclm_abcdefghijklmnopqrstu1');
const secondClaimId = assertClaimId('rdclm_abcdefghijklmnopqrstu2');
const claim = makeClaim(claimId);
const secondClaim = makeClaim(secondClaimId);

const KNOWN_TRANSITION_KINDS = new Set([
  'claim',
  'default',
  'terminal_claim_confirmed',
  'terminal_claim_conflict',
  'open_delegated_children',
  'none',
  'stale_claim',
]);

function makeClaim(id: ClaimId): ClaimRecord {
  return {
    kind: 'claim-record',
    claimId: id,
    childRunId: child.id,
    tokenHash: assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`),
    parentRunId: parent.id,
    parentStepId: '1.1',
    parentStep: '1',
    parentFrameKey: buildFrameKey('1'),
    parentEntry: 1,
    claimedAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
  };
}

function claimedResolution(state: RunbookState = child): ClaimIdResolution {
  return { status: 'claimed', claim, state };
}

function fakeReader(options: {
  readonly active?: RunbookState | null;
  readonly openClaims?: readonly ClaimRecord[];
  readonly claimResolution?: ClaimIdResolution;
  readonly expectedClaimId?: ClaimId;
  readonly expectedIncludeStashed?: boolean;
  readonly failOnDefaultRead?: boolean;
  readonly failOnOpenClaimRead?: boolean;
}): CommandTargetReader {
  return {
    async getActive() {
      if (options.failOnDefaultRead) {
        throw new Error('default stack should not be inspected');
      }
      return options.active ?? null;
    },
    async getActiveForClaimId(_claimId, includeOptions) {
      expect(_claimId).toBe(options.expectedClaimId ?? claimId);
      if (options.expectedIncludeStashed !== undefined) {
        expect(includeOptions.includeStashed).toBe(options.expectedIncludeStashed);
      }
      return options.claimResolution ?? { status: 'missing', claimId: _claimId };
    },
    async listOpenClaimsForParent(parentRunId) {
      if (options.failOnOpenClaimRead) {
        throw new Error('open delegated children should not be inspected');
      }
      expect(parentRunId).toBe(parent.id);
      return options.openClaims ?? [];
    },
  };
}

describe('resolveCommandTarget', () => {
  it('resolves explicit claim id before default stack', async () => {
    const result = await resolveCommandTarget(
      fakeReader({
        claimResolution: claimedResolution(),
        expectedIncludeStashed: false,
        failOnDefaultRead: true,
      }),
      { claimId },
    );

    expect(result).toEqual({ kind: 'claim', claimId, claim, state: child });
  });

  it('passes allowStashed through claim resolution for read-only targeting', async () => {
    const result = await resolveCommandTarget(
      fakeReader({
        claimResolution: claimedResolution(),
        expectedIncludeStashed: true,
        failOnDefaultRead: true,
      }),
      { claimId, allowStashed: true },
    );

    expect(result.kind).toBe('claim');
  });

  it('does not fall back when explicit claim id is missing', async () => {
    const result = await resolveCommandTarget(
      fakeReader({
        active: parent,
        claimResolution: { status: 'missing', claimId },
        expectedIncludeStashed: false,
        failOnDefaultRead: true,
      }),
      { claimId },
    );

    expect(result).toEqual({
      kind: 'stale_claim',
      claimId,
      message: `Claim id ${claimId} does not exist.`,
    });
  });

  it('preserves terminal claim resolution with final child state', async () => {
    const result = await resolveCommandTarget(
      fakeReader({
        claimResolution: {
          status: 'terminal',
          claim,
          lifecycle: 'completed',
          state: terminalCompletedChild,
        },
        expectedIncludeStashed: false,
      }),
      { claimId },
    );

    expect(result).toEqual({
      kind: 'terminal_claim',
      claimId,
      claim,
      state: terminalCompletedChild,
      lifecycle: 'completed',
      message: `Claim id ${claimId} points at a completed child runbook.`,
    });
  });

  it('resolves default stack when no claim id is supplied', async () => {
    const result = await resolveCommandTarget(fakeReader({ active: parent }));

    expect(result).toEqual({ kind: 'default', state: parent });
  });

  it('returns none when there is no default stack target', async () => {
    const result = await resolveCommandTarget(fakeReader({ active: null }));

    expect(result).toEqual({ kind: 'none' });
  });
});

describe('resolveTransitionTarget', () => {
  it.each([
    'pass',
    'fail',
  ] as const)('refuses a bare %s against a default parent with open delegated child claims', async (command) => {
    await expect(
      resolveTransitionTarget(fakeReader({ active: parent, openClaims: [claim] }), {
        command,
        actorContext: trustedRunControllerContext(parent.id, 'direct-cli'),
      }),
    ).resolves.toEqual({
      kind: 'open_delegated_children',
      parentRunId: parent.id,
      claims: [claim],
    });
  });

  it('resolves default active runbook when there are no open delegated child claims', async () => {
    await expect(
      resolveTransitionTarget(fakeReader({ active: parent, openClaims: [] }), {
        command: 'pass',
        actorContext: trustedRunControllerContext(parent.id, 'direct-cli'),
      }),
    ).resolves.toEqual({ kind: 'default', state: parent });
  });

  it('refuses a bare transition when a delegated outcome is waiting for collection', async () => {
    const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
    const pendingParent = {
      ...parent,
      step: '1',
      substep: '1',
      activeFrameKey: buildFrameKey('1'),
      activeEntry: 1,
      frameEntries: { [buildFrameKey('1')]: 1 },
      resolvedCompletions: {
        [key]: buildResolvedCompletion({
          agentId: 'delegation',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: activeFrame(buildFrameKey('1'), 1),
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
    } as RunbookState;

    await expect(
      resolveTransitionTarget(fakeReader({ active: pendingParent, openClaims: [] }), {
        command: 'pass',
        actorContext: trustedRunControllerContext(parent.id, 'direct-cli'),
      }),
    ).resolves.toEqual({
      kind: 'delegation_collection_pending',
      parentRunId: parent.id,
      outcomeCompletionKeys: [key],
      message:
        'A delegated claim has reported an outcome that must be collected by the orchestrator.',
    });
  });

  it('returns kind none when there is no active runbook and no claim id', async () => {
    await expect(
      resolveTransitionTarget(fakeReader({ active: null }), { command: 'pass' }),
    ).resolves.toEqual({
      kind: 'none',
    });
  });

  it('skips the open delegated child guard for targeted transitions', async () => {
    await expect(
      resolveTransitionTarget(
        fakeReader({ active: parent, openClaims: [claim], failOnOpenClaimRead: true }),
        { command: 'pass', targeted: true },
      ),
    ).resolves.toEqual({ kind: 'default', state: parent });
  });

  it('resolves an explicit live claim without checking default stack or parent open claims', async () => {
    await expect(
      resolveTransitionTarget(
        fakeReader({
          claimResolution: claimedResolution(),
          expectedIncludeStashed: false,
          failOnDefaultRead: true,
          failOnOpenClaimRead: true,
        }),
        { command: 'pass', claimId },
      ),
    ).resolves.toEqual({ kind: 'claim', claimId, claim, state: child });
  });

  it.each([
    { command: 'pass' as const, lifecycle: 'completed' as const, state: terminalCompletedChild },
    { command: 'fail' as const, lifecycle: 'stopped' as const, state: terminalStoppedChild },
  ])('confirms a terminal claim when $command matches $lifecycle', async (caseDef) => {
    await expect(
      resolveTransitionTarget(
        fakeReader({
          claimResolution: {
            status: 'terminal',
            claim,
            lifecycle: caseDef.lifecycle,
            state: caseDef.state,
          },
          expectedIncludeStashed: false,
        }),
        { command: caseDef.command, claimId },
      ),
    ).resolves.toMatchObject({
      kind: 'terminal_claim_confirmed',
      claimId,
      lifecycle: caseDef.lifecycle,
      result: caseDef.command,
    });
  });

  it('reports a terminal claim conflict when requested result differs from child lifecycle', async () => {
    await expect(
      resolveTransitionTarget(
        fakeReader({
          claimResolution: {
            status: 'terminal',
            claim,
            lifecycle: 'stopped',
            state: terminalStoppedChild,
          },
          expectedIncludeStashed: false,
        }),
        { command: 'pass', claimId },
      ),
    ).resolves.toMatchObject({
      kind: 'terminal_claim_conflict',
      claimId,
      lifecycle: 'stopped',
      expectedResult: 'fail',
      requestedResult: 'pass',
    });
  });

  it.each([
    {
      label: 'missing',
      resolution: { status: 'missing' as const, claimId },
      expectedMessage: `Claim id ${claimId} does not exist.`,
    },
    {
      label: 'stale',
      resolution: { status: 'stale' as const, claim, reason: 'missing-state' as const },
      expectedMessage: `Claim id ${claimId} points at missing child state (missing-state).`,
    },
    {
      label: 'unlinked stashed',
      resolution: { status: 'unlinked' as const, claim, reason: 'stashed' as const },
      expectedMessage: `Claim id ${claimId} is currently stashed. Run \`rd pop --claim-id ${claimId}\` to resume.`,
    },
    {
      label: 'unlinked non-stashed',
      resolution: {
        status: 'unlinked' as const,
        claim,
        reason: 'child-linkage-mismatch' as const,
      },
      expectedMessage: `Claim id ${claimId} is no longer linked to an active delegation (child-linkage-mismatch).`,
    },
  ])('reports stale_claim for $label claim resolution', async (caseDef) => {
    await expect(
      resolveTransitionTarget(
        fakeReader({
          claimResolution: caseDef.resolution,
          expectedIncludeStashed: false,
        }),
        { command: 'pass', claimId },
      ),
    ).resolves.toEqual({
      kind: 'stale_claim',
      claimId,
      message: caseDef.expectedMessage,
    });
  });

  it.each([
    {
      label: 'explicit claim',
      reader: fakeReader({ claimResolution: claimedResolution() }),
      options: { command: 'pass' as const, claimId },
    },
    {
      label: 'default active',
      reader: fakeReader({ active: parent, openClaims: [] }),
      options: {
        command: 'pass' as const,
        actorContext: trustedRunControllerContext(parent.id, 'direct-cli'),
      },
    },
    {
      label: 'no active',
      reader: fakeReader({ active: null }),
      options: { command: 'pass' as const },
    },
    {
      label: 'open delegated child',
      reader: fakeReader({ active: parent, openClaims: [secondClaim] }),
      options: {
        command: 'fail' as const,
        actorContext: trustedRunControllerContext(parent.id, 'direct-cli'),
      },
    },
  ])('returns a known transition target variant for $label', async (caseDef) => {
    const result = await resolveTransitionTarget(caseDef.reader, caseDef.options);

    expect(KNOWN_TRANSITION_KINDS.has(result.kind)).toBe(true);
  });
});

describe('resolveTransitionTarget integration', () => {
  const mockSteps: Step[] = [makeBaseStep({ name: '1', description: 'Initial step' })];
  const mockRunbook: Runbook = { title: 'Test Runbook', description: 'A test', steps: mockSteps };

  it('surfaces real SessionService open delegated child claims through the resolver', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'transition-target-'));
    try {
      const manager = new RunbookStateManager(testDir);
      const sessionService = new SessionService(manager);
      const parentState = await manager.create(
        { source: 'project', path: 'parent.md' },
        mockRunbook,
        { runbookPath: 'parent.md' },
      );
      const childState = await manager.create(
        { source: 'project', path: 'child.md' },
        mockRunbook,
        { runbookPath: 'child.md', parentLinkage: linkageFor(parentState.id, 'a') },
      );
      await sessionService.pushRunbook(parentState.id);
      const claimed = assertClaimed(
        await sessionService.claimRunbook(childState.id, linkageFor(parentState.id, 'a')),
      );

      await expect(
        resolveTransitionTarget(sessionService, {
          command: 'pass',
          actorContext: trustedRunControllerContext(parentState.id, 'direct-cli'),
        }),
      ).resolves.toEqual({
        kind: 'open_delegated_children',
        parentRunId: parentState.id,
        claims: [claimed.claim],
      });
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });
});
