import { describe, it, expect } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  AbortDelegationResult,
  CreateDelegationResult,
} from '../../src/runbook/delegation-service.js';
import {
  readConsumedDelegationClosure,
  readConsumedDelegationClosureForCwd,
} from '../../src/runbook/delegation-service.js';
import type {
  DelegationLinkage,
  RunbookState,
  StepDelegation,
  SubstepState,
} from '../../src/runbook/types.js';
import { Errors } from '../../src/errors/factory.js';
import { assertDelegationTokenHash } from '../../src/runbook/delegation-token.js';
import { brandEffectiveVars } from '../../src/runbook/effective-vars.js';
import { RunbookStateManager } from '../../src/runbook/state.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';

const TEST_TOKEN_HASH = assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`);
const OTHER_TOKEN_HASH = assertDelegationTokenHash(`sha256:${'b'.repeat(64)}`);
const PARENT_RUN_ID = `rd_${'1'.repeat(32)}`;
const CHILD_RUN_ID = `rd_${'2'.repeat(32)}`;

function runState(overrides: Partial<RunbookState> = {}): RunbookState {
  return {
    id: PARENT_RUN_ID,
    runbook: { source: 'project', path: 'parent.md' },
    runbookPath: 'parent.md',
    step: '1',
    stepName: 'Step',
    retryCount: 0,
    variables: {} as RunbookState['variables'],
    steps: [],
    startedAt: '2026-04-23T00:00:00.000Z',
    updatedAt: '2026-04-23T00:00:00.000Z',
    lifecycle: 'running',
    ...overrides,
  } as RunbookState;
}

function delegation(overrides: Partial<StepDelegation> = {}): StepDelegation {
  return {
    tokenHash: TEST_TOKEN_HASH,
    childRunbookPath: 'child.md',
    childRunbookRef: { source: 'project', path: 'child.md' },
    contextSnapshot: { vars: brandEffectiveVars({}), ancestors: [] },
    childRunId: null,
    createdAt: '2026-04-23T00:00:00.000Z',
    cancelledAt: null,
    ...overrides,
  };
}

function parentState(overrides: Partial<StepDelegation> = {}): RunbookState {
  return runState({
    id: PARENT_RUN_ID as RunbookState['id'],
    substepStates: [
      {
        id: '1.1',
        frameKey: '1|' as SubstepState['frameKey'],
        status: 'pending',
        delegation: delegation(overrides),
      },
    ],
  });
}

function childLinkage(overrides: Partial<DelegationLinkage> = {}): DelegationLinkage {
  return {
    kind: 'delegation',
    parentRunId: PARENT_RUN_ID as DelegationLinkage['parentRunId'],
    parentStepId: '1.1',
    parentStep: '1',
    parentFrameKey: buildFrameKey('1'),
    parentEntry: 1,
    tokenHash: TEST_TOKEN_HASH,
    ...overrides,
  };
}

function childState(
  lifecycle: RunbookState['lifecycle'],
  overrides: Partial<RunbookState> = {},
): RunbookState {
  return runState({
    id: CHILD_RUN_ID as RunbookState['id'],
    lifecycle,
    parentLinkage: childLinkage(),
    ...overrides,
  });
}

describe('Result types', () => {
  describe('CreateDelegationResult type', () => {
    const makeResult = (): CreateDelegationResult => ({
      status: 'created',
      token: 'dlg_test',
      tokenHash: TEST_TOKEN_HASH,
      delegation: {
        tokenHash: TEST_TOKEN_HASH,
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
        contextSnapshot: { vars: brandEffectiveVars({}), ancestors: [] },
        childRunId: null,
        createdAt: '2026-04-23T00:00:00.000Z',
        cancelledAt: null,
      },
      updatedSubstepStates: [],
    });

    it('narrows to the created variant on status match', () => {
      const result = makeResult();
      // result.status is the full union here; the narrow below is real.
      if (result.status !== 'created') {
        throw new Error(`expected created, got ${result.status}`);
      }
      expect(result.token).toBe('dlg_test');
      expect(result.tokenHash).toBe(TEST_TOKEN_HASH);
    });
  });

  describe('AbortDelegationResult type', () => {
    const makeResult = (): AbortDelegationResult => ({
      status: 'not_found',
      substepId: '1.1',
      error: Errors.delegationStepNotFound('1.1'),
    });

    it('narrows to the not_found variant', () => {
      const result = makeResult();
      if (result.status !== 'not_found') {
        throw new Error(`expected not_found, got ${result.status}`);
      }
      expect(result.substepId).toBe('1.1');
      expect(result.error.code).toBe('RD-801');
    });
  });
});

describe('readConsumedDelegationClosure', () => {
  it('returns unknown/missing when no parent or child matches', () => {
    expect(readConsumedDelegationClosure([], TEST_TOKEN_HASH)).toEqual({
      status: 'unknown',
      reason: 'missing',
      requiresClosure: true,
    });
  });

  it('returns unknown/corrupt for duplicate parent delegations', () => {
    const first = parentState();
    const second = runState({
      id: 'rd_other_parent_000000000000000000000' as RunbookState['id'],
      substepStates: [
        {
          id: '2.1',
          frameKey: '2|' as SubstepState['frameKey'],
          status: 'pending',
          delegation: delegation(),
        },
      ],
    });

    expect(readConsumedDelegationClosure([first, second], TEST_TOKEN_HASH)).toMatchObject({
      status: 'unknown',
      reason: 'corrupt',
      requiresClosure: true,
    });
  });

  it('returns unknown/corrupt for duplicate child runs', () => {
    const first = childState('running');
    const second = childState('running', {
      id: 'rd_child2000000000000000000000000000' as RunbookState['id'],
    });

    expect(readConsumedDelegationClosure([first, second], TEST_TOKEN_HASH)).toMatchObject({
      status: 'unknown',
      reason: 'corrupt',
      requiresClosure: true,
    });
  });

  it('returns closed/cancelled when the parent delegation is cancelled', () => {
    expect(
      readConsumedDelegationClosure(
        [parentState({ cancelledAt: '2026-04-23T01:00:00.000Z' })],
        TEST_TOKEN_HASH,
      ),
    ).toEqual({
      status: 'closed',
      reason: 'cancelled',
      requiresClosure: false,
      parentRunId: PARENT_RUN_ID,
    });
  });

  it('returns requires_closure/pending when the parent delegation is unclaimed', () => {
    expect(readConsumedDelegationClosure([parentState()], TEST_TOKEN_HASH)).toEqual({
      status: 'requires_closure',
      reason: 'pending',
      requiresClosure: true,
      parentRunId: PARENT_RUN_ID,
    });
  });

  it('returns unknown/corrupt when the claimed child run is missing', () => {
    expect(
      readConsumedDelegationClosure(
        [parentState({ childRunId: CHILD_RUN_ID as RunbookState['id'] })],
        TEST_TOKEN_HASH,
      ),
    ).toMatchObject({
      status: 'unknown',
      reason: 'corrupt',
      requiresClosure: true,
    });
  });

  it('returns unknown/corrupt when child linkage disagrees with the parent delegation', () => {
    const parent = parentState({ childRunId: CHILD_RUN_ID as RunbookState['id'] });
    const child = childState('running', {
      parentLinkage: childLinkage({ parentStepId: 'different' }),
    });

    expect(readConsumedDelegationClosure([parent, child], TEST_TOKEN_HASH)).toMatchObject({
      status: 'unknown',
      reason: 'corrupt',
      requiresClosure: true,
    });
  });

  it.each([
    ['completed', 'closed', 'completed', false],
    ['stopped', 'closed', 'stopped', false],
    ['running', 'requires_closure', 'claimed_active', true],
  ] as const)('maps claimed child lifecycle %s', (lifecycle, status, reason, requiresClosure) => {
    const parent = parentState({ childRunId: CHILD_RUN_ID as RunbookState['id'] });
    const child = childState(lifecycle);

    expect(readConsumedDelegationClosure([parent, child], TEST_TOKEN_HASH)).toEqual({
      status,
      reason,
      requiresClosure,
      parentRunId: PARENT_RUN_ID,
      childRunId: CHILD_RUN_ID,
    });
  });

  it('accepts parent-pruned terminal child-only state', () => {
    expect(readConsumedDelegationClosure([childState('completed')], TEST_TOKEN_HASH)).toEqual({
      status: 'closed',
      reason: 'completed',
      requiresClosure: false,
      childRunId: CHILD_RUN_ID,
    });
  });

  it('accepts parent-pruned active child-only state as requiring closure', () => {
    expect(readConsumedDelegationClosure([childState('running')], TEST_TOKEN_HASH)).toEqual({
      status: 'requires_closure',
      reason: 'claimed_active',
      requiresClosure: true,
      childRunId: CHILD_RUN_ID,
    });
  });

  it('ignores unrelated token hashes', () => {
    const child = childState('completed', {
      parentLinkage: childLinkage({ tokenHash: OTHER_TOKEN_HASH }),
    });

    expect(readConsumedDelegationClosure([parentState(), child], TEST_TOKEN_HASH)).toEqual({
      status: 'requires_closure',
      reason: 'pending',
      requiresClosure: true,
      parentRunId: PARENT_RUN_ID,
    });
  });

  it('reads consumed delegation closure from persisted states by cwd', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'delegation-closure-cwd-'));
    try {
      const manager = new RunbookStateManager(cwd);
      await manager.save(parentState({ childRunId: CHILD_RUN_ID as RunbookState['id'] }));
      await manager.save(childState('completed'));

      await expect(readConsumedDelegationClosureForCwd(cwd, TEST_TOKEN_HASH)).resolves.toEqual({
        status: 'closed',
        reason: 'completed',
        requiresClosure: false,
        parentRunId: PARENT_RUN_ID,
        childRunId: CHILD_RUN_ID,
      });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});
