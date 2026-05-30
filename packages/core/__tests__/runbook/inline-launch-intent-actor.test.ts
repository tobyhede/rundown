import { describe, expect, it, jest } from '@jest/globals';
import type {
  ResolvedStep,
  ResolvedStepWithSubsteps,
  Substep,
  Transitions,
} from '@rundown-org/parser';
import { createActor } from 'xstate';

import {
  inlineLaunchIntentActor,
  type InlineLaunchIntentInput,
  type InlineLaunchIntentOutput,
} from '../../src/runbook/actors/inline-launch-intent-actor.js';
import { assertDelegationTokenHash } from '../../src/runbook/delegation-token.js';
import type { ResolvedDelegationRunbook } from '../../src/runbook/delegation-inference.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import type {
  ContextSnapshot,
  DelegationParentState,
  StepInlineChild,
  SubstepState,
} from '../../src/runbook/types.js';
import {
  brandEffectiveVarsForTest,
  brandInitialTemplateVarsForTest,
  brandRunIdForTest,
  brandStoredOutputsForTest,
} from '../../src/testing/effective-vars.js';

const DEFAULT_TRANSITIONS: Transitions = {
  pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
  fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
};

interface RunResult {
  readonly status: 'done' | 'error';
  readonly output?: unknown;
  readonly error?: unknown;
}

async function runActor(input: InlineLaunchIntentInput): Promise<RunResult> {
  const actor = createActor(inlineLaunchIntentActor, { input });
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

function makeStepWithoutSubsteps(name: string): ResolvedStep {
  return {
    kind: 'base',
    name,
    description: `Step ${name}`,
    transitions: DEFAULT_TRANSITIONS,
  };
}

function makeParentState(overrides: Partial<DelegationParentState> = {}): DelegationParentState {
  return {
    id: brandRunIdForTest(`rd_${'1'.repeat(32)}`),
    step: '2',
    substep: '1',
    variables: brandStoredOutputsForTest({ ArtifactPath: '/tmp/artifact.txt' }),
    templateVars: brandInitialTemplateVarsForTest({ Env: 'prod' }),
    ...overrides,
  };
}

function makeResolved(runbookRef: string): ResolvedDelegationRunbook {
  return {
    path: 'runbooks/child.runbook.md',
    runbookRef,
    childRunbookRef: { source: 'project', path: 'runbooks/child.runbook.md' },
  };
}

function input(
  overrides: Partial<InlineLaunchIntentInput> = {},
  substeps: readonly Substep[] = [
    makeSubstep({ id: '1', description: 'Run child', runbooks: ['child'] }),
  ],
): InlineLaunchIntentInput {
  return {
    state: makeParentState(),
    steps: [makeStepWithSubsteps('2', substeps)],
    substepId: '1',
    frameKey: buildFrameKey('2'),
    resolveRunbook: async (runbookRef) => makeResolved(runbookRef),
    generateChildRunId: () => brandRunIdForTest(`rd_${'c'.repeat(32)}`),
    now: () => '2026-05-30T00:00:00.000Z',
    ...overrides,
  };
}

describe('inlineLaunchIntentActor', () => {
  it('prepares inline launch intent for a non-DELEGATE substep with one runbook', async () => {
    const parentState = makeParentState();
    const result = await runActor(input({ state: parentState }));

    expect(result.status).toBe('done');
    expect(result.output).toMatchObject({
      status: 'prepared',
      intent: {
        parentRunId: parentState.id,
        parentStepId: '1',
        parentStep: '2',
        parentFrameKey: '2|',
        childRunId: `rd_${'c'.repeat(32)}`,
        childRunbookPath: 'runbooks/child.runbook.md',
        childRunbookRef: { source: 'project', path: 'runbooks/child.runbook.md' },
      },
      substepStates: [
        expect.objectContaining({
          id: '1',
          frameKey: '2|',
          status: 'running',
          inline: expect.objectContaining({
            childRunId: `rd_${'c'.repeat(32)}`,
            createdAt: '2026-05-30T00:00:00.000Z',
            startedAt: null,
          }),
        }),
      ],
    });

    const output = result.output as Extract<InlineLaunchIntentOutput, { status: 'prepared' }>;
    expect('parentEntry' in output.intent).toBe(false);
    expect(output.intent.contextSnapshot).toMatchObject({
      step: '2',
      substep: '1',
      at: '2.1',
      vars: {
        Env: 'prod',
        ArtifactPath: '/tmp/artifact.txt',
      },
    });
    expect(output.substepStates[0]?.inline?.contextSnapshot).toBe(output.intent.contextSnapshot);
  });

  it('skips when the current parent step is missing', async () => {
    const result = await runActor(input({ steps: [makeStepWithSubsteps('3', [])] }));

    expect(result.status).toBe('done');
    expect(result.output).toEqual({ status: 'skipped' });
  });

  it('skips when the current parent step has no substeps', async () => {
    const result = await runActor(input({ steps: [makeStepWithoutSubsteps('2')] }));

    expect(result.status).toBe('done');
    expect(result.output).toEqual({ status: 'skipped' });
  });

  it('skips when the target substep is missing', async () => {
    const result = await runActor(
      input({
        substepId: '2',
      }),
    );

    expect(result.status).toBe('done');
    expect(result.output).toEqual({ status: 'skipped' });
  });

  it('skips DELEGATE substeps', async () => {
    const result = await runActor(
      input({}, [
        makeSubstep({
          id: '1',
          description: 'Delegate child',
          delegate: true,
          runbooks: ['child'],
        }),
      ]),
    );

    expect(result.status).toBe('done');
    expect(result.output).toEqual({ status: 'skipped' });
  });

  it('skips substeps with no runbook', async () => {
    const result = await runActor(
      input({}, [makeSubstep({ id: '1', description: 'Prompt only' })]),
    );

    expect(result.status).toBe('done');
    expect(result.output).toEqual({ status: 'skipped' });
  });

  it('skips substeps with an empty runbook list', async () => {
    const result = await runActor(
      input({}, [makeSubstep({ id: '1', description: 'Empty children', runbooks: [] })]),
    );

    expect(result.status).toBe('done');
    expect(result.output).toEqual({ status: 'skipped' });
  });

  it('fails inside claimed delegation child scopes', async () => {
    const result = await runActor(
      input({
        state: makeParentState({
          parentLinkage: {
            kind: 'delegation',
            parentRunId: brandRunIdForTest(`rd_${'2'.repeat(32)}`),
            parentStepId: '1.1',
            parentStep: '1',
            parentFrameKey: buildFrameKey('1'),
            parentEntry: 1,
            tokenHash: assertDelegationTokenHash(`sha256:${'b'.repeat(64)}`),
          },
        }),
      }),
    );

    expect(result.status).toBe('done');
    expect(result.output).toMatchObject({
      status: 'failed',
      reason: 'inline_launch_forbidden',
    });
    expect((result.output as { message: string }).message).toContain('claimed child scopes');
  });

  it('fails when the child runbook cannot be resolved', async () => {
    const result = await runActor(
      input({
        resolveRunbook: async () => null,
      }),
    );

    expect(result.status).toBe('done');
    expect(result.output).toMatchObject({
      status: 'failed',
      reason: 'inline_launch_failed',
    });
    expect((result.output as { message: string }).message).toContain('child');
  });

  it('fails when a substep declares more than one inline child runbook', async () => {
    const result = await runActor(
      input({}, [
        makeSubstep({
          id: '1',
          description: 'Ambiguous children',
          runbooks: ['one', 'two'],
        }),
      ]),
    );

    expect(result.status).toBe('done');
    expect(result.output).toEqual({
      status: 'failed',
      reason: 'inline_launch_failed',
      message: 'Inline launch requires exactly one child runbook on substep 2.1.',
    });
  });

  it('prepares idempotently when inline child metadata already exists', async () => {
    const existingContextSnapshot: ContextSnapshot = {
      vars: brandEffectiveVarsForTest({ Existing: 'snapshot' }),
      ancestors: [],
      step: '2',
      substep: '1',
      at: '2.1',
    };
    const existingInline: StepInlineChild = {
      childRunbookPath: 'runbooks/child.runbook.md',
      childRunbookRef: { source: 'project', path: 'runbooks/child.runbook.md' },
      contextSnapshot: existingContextSnapshot,
      childRunId: brandRunIdForTest(`rd_${'d'.repeat(32)}`),
      createdAt: '2026-05-29T00:00:00.000Z',
      startedAt: '2026-05-29T00:01:00.000Z',
    };
    const existingSubstep: SubstepState = {
      id: '1',
      frameKey: buildFrameKey('2'),
      status: 'done',
      result: 'pass',
      inline: existingInline,
    };
    const generateChildRunId = jest.fn<InlineLaunchIntentInput['generateChildRunId']>(() =>
      brandRunIdForTest(`rd_${'e'.repeat(32)}`),
    );
    const now = jest.fn(() => '2026-05-30T00:00:00.000Z');

    const result = await runActor(
      input({
        state: makeParentState({ substepStates: [existingSubstep] }),
        generateChildRunId,
        now,
      }),
    );

    expect(result.status).toBe('done');
    expect(result.output).toMatchObject({
      status: 'prepared',
      intent: {
        childRunId: `rd_${'d'.repeat(32)}`,
        contextSnapshot: existingContextSnapshot,
      },
      substepStates: [
        expect.objectContaining({
          id: '1',
          frameKey: '2|',
          status: 'running',
          inline: expect.objectContaining({
            childRunId: `rd_${'d'.repeat(32)}`,
            createdAt: '2026-05-29T00:00:00.000Z',
            contextSnapshot: existingContextSnapshot,
            startedAt: '2026-05-29T00:01:00.000Z',
          }),
        }),
      ],
    });
    const output = result.output as Extract<InlineLaunchIntentOutput, { status: 'prepared' }>;
    expect(output.substepStates[0]?.status).toBe('running');
    expect(output.substepStates[0]?.inline).toEqual(existingInline);
    expect('result' in (output.substepStates[0] ?? {})).toBe(false);
    expect(generateChildRunId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
  });
});
