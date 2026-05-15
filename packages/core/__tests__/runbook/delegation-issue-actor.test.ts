import { describe, expect, it } from '@jest/globals';
import type { ResolvedStepWithSubsteps, Substep, Transitions } from '@rundown-org/parser';
import { createActor } from 'xstate';

import {
  delegationIssueActor,
  type DelegationIssueInput,
  type DelegationIssueOutput,
} from '../../src/runbook/actors/delegation-issue-actor.js';
import { assertDelegationTokenHash } from '../../src/runbook/delegation-token.js';
import type { ResolvedDelegationRunbook } from '../../src/runbook/delegation-inference.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import type {
  DelegationParentState,
  StepDelegation,
  SubstepState,
} from '../../src/runbook/types.js';
import {
  brandEffectiveVarsForTest,
  brandInitialTemplateVarsForTest,
  brandRunIdForTest,
  brandStoredOutputsForTest,
} from '../helpers/effective-vars.js';

const DEFAULT_TRANSITIONS: Transitions = {
  pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
  fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
};

interface RunResult {
  readonly status: 'done' | 'error';
  readonly output?: unknown;
  readonly error?: unknown;
}

async function runActor(input: DelegationIssueInput): Promise<RunResult> {
  const actor = createActor(delegationIssueActor, { input });
  const result = new Promise<RunResult>((resolve) => {
    actor.subscribe({
      next: (snapshot) => {
        if (snapshot.status === 'done') resolve({ status: 'done', output: snapshot.output });
        if (snapshot.status === 'error') resolve({ status: 'error', error: snapshot.error });
      },
      error: (error) => {
        resolve({ status: 'error', error });
      },
    });
  });
  actor.start();
  return await result;
}

function makeSubstep(overrides: Partial<Substep> & { id: string; description: string }): Substep {
  return { transitions: DEFAULT_TRANSITIONS, ...overrides };
}

function makeStepWithSubsteps(
  name: string,
  substeps: readonly Substep[],
): ResolvedStepWithSubsteps {
  return {
    kind: 'substeps',
    name,
    description: `Step ${name}`,
    transitions: DEFAULT_TRANSITIONS,
    substeps,
  };
}

function makeParentState(overrides: Partial<DelegationParentState> = {}): DelegationParentState {
  return {
    id: brandRunIdForTest(`rd_${'1'.repeat(32)}`),
    step: '1',
    substep: '1',
    variables: brandStoredOutputsForTest({ ArtifactPath: '/tmp/artifact.txt' }),
    templateVars: brandInitialTemplateVarsForTest({ Env: 'prod' }),
    ...overrides,
  };
}

function makeResolved(runbookRef: string): ResolvedDelegationRunbook {
  return {
    path: `/resolved/${runbookRef}`,
    runbookRef,
    childRunbookRef: { source: 'project', path: `/canonical/${runbookRef}` },
  };
}

function makeActiveDelegation(): StepDelegation {
  return {
    tokenHash: assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`),
    childRunbookPath: 'child.runbook.md',
    childRunbookRef: { source: 'project', path: 'child.runbook.md' },
    contextSnapshot: { vars: brandEffectiveVarsForTest({}), ancestors: [] },
    childRunId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    cancelledAt: null,
  };
}

function input(
  overrides: Partial<DelegationIssueInput> = {},
  substeps: readonly Substep[] = [
    makeSubstep({ id: '1', description: 'A', runbooks: ['a.runbook.md'], delegate: true }),
    makeSubstep({ id: '2', description: 'B', runbooks: ['b.runbook.md'], delegate: true }),
  ],
): DelegationIssueInput {
  return {
    state: makeParentState(),
    steps: [makeStepWithSubsteps('1', substeps)],
    frameKey: buildFrameKey('1'),
    resolveRunbook: async (runbookRef) => makeResolved(runbookRef),
    ...overrides,
  };
}

describe('delegationIssueActor', () => {
  it('fans out two delegated substeps with tokens and updated substep states', async () => {
    const result = await runActor(input());

    expect(result.status).toBe('done');
    expect(result.output).toMatchObject({ status: 'issued' });
    const output = result.output as Extract<DelegationIssueOutput, { status: 'issued' }>;
    expect(output.frontier).toHaveLength(2);
    expect(output.substepStates).toHaveLength(2);
    expect(output.frontier.map((entry) => entry.id)).toEqual(['1.1', '1.2']);
    expect(output.substepStates.map((state) => state.id)).toEqual(['1', '2']);
    expect(output.substepStates.every((state) => state.delegation?.token)).toBe(true);
  });

  it('preserves the authored runbook ref in frontier entries', async () => {
    const result = await runActor(
      input({}, [
        makeSubstep({ id: '1', description: 'A', runbooks: ['authored'], delegate: true }),
      ]),
    );

    expect(result.status).toBe('done');
    expect(result.output).toMatchObject({
      status: 'issued',
      frontier: [expect.objectContaining({ id: '1.1', runbook: 'authored' })],
    });
  });

  it('returns delegation_resolution_failed when any child runbook cannot resolve', async () => {
    const result = await runActor(
      input({
        resolveRunbook: async (runbookRef) =>
          runbookRef === 'a.runbook.md' ? makeResolved(runbookRef) : null,
      }),
    );

    expect(result.status).toBe('done');
    expect(result.output).toMatchObject({
      status: 'failed',
      reason: 'delegation_resolution_failed',
    });
    expect(result.output).not.toHaveProperty('substepStates');
  });

  it('returns nested_delegation_forbidden for delegated children attempting fan-out', async () => {
    const result = await runActor(
      input({
        state: makeParentState({
          parentLinkage: {
            kind: 'delegation',
            parentRunId: brandRunIdForTest(`rd_${'2'.repeat(32)}`),
            parentStepId: '1.1',
            parentFrameKey: buildFrameKey('1'),
            tokenHash: assertDelegationTokenHash(`sha256:${'b'.repeat(64)}`),
          },
        }),
      }),
    );

    expect(result.status).toBe('done');
    expect(result.output).toMatchObject({
      status: 'failed',
      reason: 'nested_delegation_forbidden',
    });
  });

  it('skips substeps with existing active delegations', async () => {
    const existing: SubstepState = {
      id: '1',
      frameKey: buildFrameKey('1'),
      status: 'pending',
      delegation: makeActiveDelegation(),
    };

    const result = await runActor(input({ state: makeParentState({ substepStates: [existing] }) }));

    expect(result.status).toBe('done');
    expect(result.output).toMatchObject({ status: 'issued' });
    const output = result.output as Extract<DelegationIssueOutput, { status: 'issued' }>;
    expect(output.frontier.map((entry) => entry.id)).toEqual(['1.2']);
    expect(output.substepStates).toHaveLength(2);
    expect(output.substepStates[0]).toBe(existing);
  });

  it('returns typed delegation_resolution_failed when the resolver rejects', async () => {
    const result = await runActor(
      input({
        resolveRunbook: async () => {
          throw new Error('disk read failed');
        },
      }),
    );

    expect(result.status).toBe('done');
    expect(result.output).toMatchObject({
      status: 'failed',
      reason: 'delegation_resolution_failed',
    });
    expect((result.output as { message: string }).message).toContain('disk read failed');
  });

  it('does not return partial state when a mixed fan-out fails', async () => {
    const result = await runActor(
      input({
        resolveRunbook: async (runbookRef) =>
          runbookRef === 'a.runbook.md' ? makeResolved(runbookRef) : null,
      }),
    );

    expect(result.status).toBe('done');
    expect(result.output).toEqual(
      expect.not.objectContaining({
        status: 'issued',
      }),
    );
  });
});
