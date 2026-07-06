import { describe, it, expect } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CommandTargetReader,
  resolveMutationAuthority,
  resolveCommandTarget,
  resolveTerminalTarget,
  resolveTransitionTarget,
} from '../../src/runbook/command-target-resolver.js';
import {
  assertClaimLookupKey,
  assertClaimId,
  assertClaimSecretHash,
  type AuthorizedClaim,
  type ClaimAuthorizationRequest,
  type ClaimId,
  type ClaimIdResolution,
  type ClaimRecord,
  type ClaimVerificationResult,
  type VerifiedClaim,
} from '../../src/runbook/claim-id.js';
import { assertDelegationTokenHash } from '../../src/runbook/delegation-token.js';
import { assertRunId } from '../../src/runbook/run-id.js';
import { RunbookStateManager } from '../../src/runbook/state.js';
import { SessionService } from '../../src/runbook/session-service.js';
import {
  activeFrame,
  buildCompletionKey,
  buildFrameKey,
  buildResolvedCompletion,
} from '../../src/runbook/targeting.js';
import { verifiedClaimContext } from '../../src/runbook/actor-context.js';
import { makeBaseStep } from '../helpers/step-factories.js';
import type { Runbook, RunbookState, Step } from '../../src/runbook/types.js';
import { assertClaimed, linkageFor } from './claim-test-helpers.js';

const parent = { id: 'parent', lifecycle: 'running' } as RunbookState;
const child = { id: 'child', lifecycle: 'running' } as RunbookState;
const terminalCompletedChild = { ...child, lifecycle: 'completed' } as RunbookState;
const terminalStoppedChild = { ...child, lifecycle: 'stopped' } as RunbookState;
const claimId = assertClaimId(
  'rdclm_11111111111111111111111111111111_abcdefghijklmnopqrstuvwxyzABCDE1234567890-_',
);
const secondClaimId = assertClaimId(
  'rdclm_22222222222222222222222222222222_abcdefghijklmnopqrstuvwxyzABCDE1234567890-_',
);
const claim = makeClaim(claimId);
const secondClaim = makeClaim(secondClaimId);
const verifiedClaim = makeVerifiedClaim(claim);
const secondVerifiedClaim = makeVerifiedClaim(secondClaim);

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
  const claimKey = assertClaimLookupKey(`rdclk_${id.slice('rdclm_'.length, 'rdclm_'.length + 32)}`);
  return {
    claimKey,
    secretHash: assertClaimSecretHash(`sha256:${'a'.repeat(64)}`),
    controlledRunId: child.id,
    delegation: {
      childRunId: child.id,
      tokenHash: assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`),
      parentRunId: parent.id,
      parentStepId: '1.1',
      parentStep: '1',
      parentFrameKey: buildFrameKey('1'),
      parentEntry: 1,
    },
    grants: [
      { action: 'mutate-run', runId: child.id },
      {
        action: 'report-delegation-result',
        childRunId: child.id,
        tokenHash: assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`),
        parentRunId: parent.id,
        parentStepId: '1.1',
        parentStep: '1',
        parentFrameKey: buildFrameKey('1'),
        parentEntry: 1,
      },
    ],
    issuedAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
  };
}

function makeVerifiedClaim(record: ClaimRecord): VerifiedClaim {
  return {
    claimKey: record.claimKey,
    controlledRunId: record.controlledRunId,
    ...(record.delegation ? { delegation: record.delegation } : {}),
    grants: record.grants,
  };
}

function verifiedRunContext(runId: RunbookState['id']) {
  return verifiedClaimContext({
    authority: { kind: 'bearer', claimId, claimKey: claim.claimKey },
    claim: {
      claimKey: claim.claimKey,
      controlledRunId: runId,
      grants: [{ action: 'mutate-run', runId }],
    },
  });
}

function claimedResolution(state: RunbookState = child): ClaimIdResolution {
  return { status: 'claimed', claimId, claim: verifiedClaim, record: claim, state };
}

function fakeReader(options: {
  readonly active?: RunbookState | null;
  readonly openClaims?: readonly ClaimRecord[];
  readonly claimResolution?: ClaimIdResolution;
  readonly claimVerification?: ClaimVerificationResult;
  readonly authorizingClaims?: readonly AuthorizedClaim[];
  readonly expectedClaimId?: ClaimId;
  readonly expectedIncludeStashed?: boolean;
  readonly failOnDefaultRead?: boolean;
  readonly failOnOpenClaimRead?: boolean;
  readonly runById?: Readonly<Record<string, RunbookState | null>>;
}): CommandTargetReader {
  return {
    async getActive() {
      if (options.failOnDefaultRead) {
        throw new Error('default stack should not be inspected');
      }
      return options.active ?? null;
    },
    async resolveRunningStackMember(runId) {
      const state = options.runById?.[runId] ?? null;
      if (!state) return { kind: 'not_on_stack' };
      if (state.lifecycle !== 'running') {
        return { kind: 'not_running', lifecycle: state.lifecycle };
      }
      return { kind: 'running', state };
    },
    async getActiveForClaimId(_claimId, includeOptions) {
      expect(_claimId).toBe(options.expectedClaimId ?? claimId);
      if (options.expectedIncludeStashed !== undefined) {
        expect(includeOptions.includeStashed).toBe(options.expectedIncludeStashed);
      }
      return options.claimResolution ?? { status: 'missing', claimId: _claimId };
    },
    async verifyClaimId(_claimId) {
      expect(_claimId).toBe(options.expectedClaimId ?? claimId);
      return options.claimVerification ?? { status: 'missing', claimKey: claim.claimKey };
    },
    async listClaimsAuthorizing() {
      return options.authorizingClaims ?? [];
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

    expect(result).toEqual({ kind: 'claim', claimId, claim: verifiedClaim, state: child });
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

  it('refuses a claim id with an invalid secret', async () => {
    const result = await resolveCommandTarget(
      fakeReader({
        claimResolution: { status: 'invalid-secret', claimId },
        failOnDefaultRead: true,
      }),
      { claimId },
    );

    expect(result).toEqual({
      kind: 'stale_claim',
      claimId,
      message: `Claim id ${claimId} is not valid for this session.`,
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

describe('resolveMutationAuthority', () => {
  it('uses explicit bearer authority when the verified claim has the exact grant', async () => {
    const request: ClaimAuthorizationRequest = { action: 'mutate-run', runId: child.id };

    const result = await resolveMutationAuthority({
      targetReader: fakeReader({
        claimVerification: { status: 'verified', claim: verifiedClaim },
        failOnDefaultRead: true,
      }),
      presentedClaimId: claimId,
      targetState: child,
      request,
    });

    expect(result).toEqual({
      kind: 'verified',
      authority: { kind: 'bearer', claimId, claimKey: verifiedClaim.claimKey },
      claim: verifiedClaim,
    });
  });

  it('refuses a presented bearer claim id with an invalid secret', async () => {
    const request: ClaimAuthorizationRequest = { action: 'mutate-run', runId: child.id };

    const result = await resolveMutationAuthority({
      targetReader: fakeReader({
        claimVerification: { status: 'invalid-secret', claimKey: verifiedClaim.claimKey },
        failOnDefaultRead: true,
      }),
      presentedClaimId: claimId,
      targetState: child,
      request,
    });

    expect(result).toEqual({ kind: 'refused', reason: 'invalid-secret' });
  });

  it('uses implicit authority when exactly one local claim authorizes the target request', async () => {
    const request: ClaimAuthorizationRequest = { action: 'mutate-run', runId: child.id };

    const result = await resolveMutationAuthority({
      targetReader: fakeReader({
        authorizingClaims: [
          {
            authority: { kind: 'implicit', claimKey: verifiedClaim.claimKey },
            claim: verifiedClaim,
          },
        ],
      }),
      targetState: child,
      request,
    });

    expect(result).toEqual({
      kind: 'verified',
      authority: { kind: 'implicit', claimKey: verifiedClaim.claimKey },
      claim: verifiedClaim,
    });
  });

  it('refuses implicit authority when more than one local claim authorizes the request', async () => {
    const request: ClaimAuthorizationRequest = { action: 'mutate-run', runId: child.id };

    const result = await resolveMutationAuthority({
      targetReader: fakeReader({
        authorizingClaims: [
          {
            authority: { kind: 'implicit', claimKey: verifiedClaim.claimKey },
            claim: verifiedClaim,
          },
          {
            authority: { kind: 'implicit', claimKey: secondVerifiedClaim.claimKey },
            claim: secondVerifiedClaim,
          },
        ],
      }),
      targetState: child,
      request,
    });

    expect(result).toEqual({ kind: 'refused', reason: 'ambiguous' });
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
        actorContext: verifiedRunContext(parent.id),
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
        actorContext: verifiedRunContext(parent.id),
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
      frameEntryCounts: { [buildFrameKey('1')]: 1 },
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
        actorContext: verifiedRunContext(parent.id),
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

  it('returns a typed actor_context_required refusal for a strict caller with no actor evidence', async () => {
    // No actorContext supplied: the strict core default evaluates as unknown for
    // the target, so a bare transition is refused as a typed resolution rather
    // than throwing. Frontends pass bearer evidence through core verification
    // before reaching here; callers that pass none render the policy error
    // consistently from this result.
    await expect(
      resolveTransitionTarget(fakeReader({ active: parent, openClaims: [] }), {
        command: 'pass',
      }),
    ).resolves.toEqual({
      // Deliberately carries NO run id: the refusal is an accident barrier and
      // must not hand the caller the id it needs to bypass it (decision 4).
      kind: 'actor_context_required',
    });
  });

  it('skips the open delegated child guard for targeted transitions (with trusted evidence)', async () => {
    await expect(
      resolveTransitionTarget(
        fakeReader({ active: parent, openClaims: [claim], failOnOpenClaimRead: true }),
        {
          command: 'pass',
          targeted: true,
          actorContext: verifiedRunContext(parent.id),
        },
      ),
    ).resolves.toEqual({ kind: 'default', state: parent });
  });

  it('refuses a targeted transition with no trusted evidence on a delegating run (--step is not authority)', async () => {
    // The #460 child could as easily issue `rd pass --step N`: a step name is
    // a completion target, not authority. The role gate applies to targeted
    // and bare transitions alike; only the collection guards stay exempt.
    await expect(
      resolveTransitionTarget(
        fakeReader({ active: parent, openClaims: [claim], failOnOpenClaimRead: true }),
        { command: 'pass', targeted: true },
      ),
    ).resolves.toEqual({ kind: 'actor_context_required' });
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
    ).resolves.toEqual({ kind: 'claim', claimId, claim: verifiedClaim, state: child });
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
      expectedMessage: `Claim id ${claimId} is currently stashed. Run \`rundown pop --claim-id ${claimId}\` to resume.`,
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
        actorContext: verifiedRunContext(parent.id),
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
        actorContext: verifiedRunContext(parent.id),
      },
    },
  ])('returns a known transition target variant for $label', async (caseDef) => {
    const result = await resolveTransitionTarget(caseDef.reader, caseDef.options);

    expect(KNOWN_TRANSITION_KINDS.has(result.kind)).toBe(true);
  });
});

describe('resolveTransitionTarget --run targeting', () => {
  it('resolves --run to the named running stack member', async () => {
    const resolution = await resolveTransitionTarget(
      fakeReader({ runById: { [parent.id]: parent }, openClaims: [], failOnDefaultRead: true }),
      {
        command: 'pass',
        runId: parent.id,
        actorContext: verifiedRunContext(parent.id),
      },
    );
    expect(resolution).toEqual({ kind: 'run', runId: parent.id, state: parent });
  });

  it('refuses a --run id that is not part of this session stack', async () => {
    const foreign = assertRunId(`rd_${'f'.repeat(32)}`);
    const resolution = await resolveTransitionTarget(
      fakeReader({ runById: {}, failOnDefaultRead: true }),
      {
        command: 'pass',
        runId: foreign,
        actorContext: verifiedRunContext(foreign),
      },
    );
    expect(resolution).toEqual({
      kind: 'unknown_run',
      runId: foreign,
      message: `Run ${foreign} is not part of this session's active stack.`,
    });
  });

  it('refuses a --run id whose run is terminal, mentioning its lifecycle', async () => {
    const terminalParent = { ...parent, lifecycle: 'completed' } as RunbookState;
    const resolution = await resolveTransitionTarget(
      fakeReader({ runById: { [parent.id]: terminalParent }, failOnDefaultRead: true }),
      {
        command: 'pass',
        runId: parent.id,
        actorContext: verifiedRunContext(parent.id),
      },
    );
    expect(resolution).toEqual({
      kind: 'unknown_run',
      runId: parent.id,
      message: `Run ${parent.id} is completed.`,
    });
  });

  it('still applies the open-children guard to a bare-shaped run-targeted advance', async () => {
    // --run names authority; it does not skip the collection guards. A trusted
    // controller of the target advancing bare-shaped over open claims refuses.
    const resolution = await resolveTransitionTarget(
      fakeReader({
        runById: { [parent.id]: parent },
        openClaims: [claim],
        failOnDefaultRead: true,
      }),
      {
        command: 'pass',
        runId: parent.id,
        actorContext: verifiedRunContext(parent.id),
      },
    );
    expect(resolution).toEqual({
      kind: 'open_delegated_children',
      parentRunId: parent.id,
      claims: [claim],
    });
  });

  it('keeps the targeted exemption for a run-targeted transition carrying an explicit step target', async () => {
    // Decision 3: `targeted` derives from the presence of an explicit step
    // target, never from selector kind alone — pass --run <id> --step <n> is
    // the sanctioned operator recovery and skips the collection guards.
    const resolution = await resolveTransitionTarget(
      fakeReader({
        runById: { [parent.id]: parent },
        openClaims: [claim],
        failOnDefaultRead: true,
        failOnOpenClaimRead: true,
      }),
      {
        command: 'pass',
        runId: parent.id,
        targeted: true,
        actorContext: verifiedRunContext(parent.id),
      },
    );
    expect(resolution).toEqual({ kind: 'run', runId: parent.id, state: parent });
  });
});

describe('resolveCommandTarget --run targeting', () => {
  it('resolves --run to the named running stack member', async () => {
    const resolution = await resolveCommandTarget(
      fakeReader({ runById: { [parent.id]: parent }, failOnDefaultRead: true }),
      { runId: parent.id },
    );
    expect(resolution).toEqual({ kind: 'run', runId: parent.id, state: parent });
  });

  it('refuses a --run id that does not resolve to a session-stack run', async () => {
    const foreign = assertRunId(`rd_${'f'.repeat(32)}`);
    const resolution = await resolveCommandTarget(
      fakeReader({ runById: {}, failOnDefaultRead: true }),
      { runId: foreign },
    );
    expect(resolution).toEqual({
      kind: 'unknown_run',
      runId: foreign,
      message: `Run ${foreign} is not part of this session's active stack.`,
    });
  });
});

describe('resolveTerminalTarget', () => {
  // A terminal-claim reader whose child has the given terminal lifecycle. The
  // resolver must call the claim head with includeStashed: false (write command).
  function terminalReader(lifecycle: 'completed' | 'stopped'): CommandTargetReader {
    const terminalChild = lifecycle === 'completed' ? terminalCompletedChild : terminalStoppedChild;
    return fakeReader({
      claimResolution: {
        status: 'terminal',
        claim: verifiedClaim,
        state: terminalChild,
        lifecycle,
      },
      expectedIncludeStashed: false,
    });
  }

  it.each([
    ['complete', 'completed', 'terminal_claim_confirmed'],
    ['stop', 'stopped', 'terminal_claim_confirmed'],
    ['complete', 'stopped', 'terminal_claim_conflict'],
    ['stop', 'completed', 'terminal_claim_conflict'],
  ] as const)('%s against a %s child resolves as %s', async (command, lifecycle, expectedKind) => {
    const terminalChild = lifecycle === 'completed' ? terminalCompletedChild : terminalStoppedChild;
    const res = await resolveTerminalTarget(terminalReader(lifecycle), { command, claimId });
    expect(res.kind).toBe(expectedKind);
    if (res.kind === 'terminal_claim_confirmed') {
      expect(res.command).toBe(command);
      expect(res.lifecycle).toBe(lifecycle);
      expect(res.claimId).toBe(claimId);
      expect(res.claim).toBe(verifiedClaim);
      expect(res.state).toBe(terminalChild);
    }
    if (res.kind === 'terminal_claim_conflict') {
      expect(res.requestedCommand).toBe(command);
      expect(res.expectedCommand).toBe(lifecycle === 'completed' ? 'complete' : 'stop');
      expect(res.claimId).toBe(claimId);
      expect(res.claim).toBe(verifiedClaim);
      expect(res.state).toBe(terminalChild);
    }
  });

  it('passes through a live claim unchanged', async () => {
    const reader = fakeReader({
      claimResolution: claimedResolution(),
      expectedIncludeStashed: false,
    });
    const res = await resolveTerminalTarget(reader, { command: 'complete', claimId });
    expect(res.kind).toBe('claim');
  });

  it('passes through a stale (missing) claim unchanged', async () => {
    const reader = fakeReader({
      claimResolution: { status: 'missing', claimId },
      expectedIncludeStashed: false,
    });
    const res = await resolveTerminalTarget(reader, { command: 'stop', claimId });
    expect(res.kind).toBe('stale_claim');
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
          actorContext: verifiedRunContext(parentState.id),
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
