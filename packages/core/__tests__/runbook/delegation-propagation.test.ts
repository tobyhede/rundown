import { describe, it, expect } from '@jest/globals';
import { RunbookStateSchema } from '../../src/schemas.js';
import {
  buildCompletionKey,
  buildFrameKey,
  deriveActiveFrame,
} from '../../src/runbook/targeting.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- babel parser can't handle inline `type` keyword
import type { DelegationLinkage, RunbookState } from '../../src/runbook/types.js';

describe('DelegationLinkage extended fields', () => {
  function makeSchemaState(delegation: Record<string, unknown>): Record<string, unknown> {
    return {
      id: 'run-child',
      runbook: 'child.md',
      runbookPath: '/tmp/child.md',
      runbookSrc: '## 1. Do\n- PASS: COMPLETE\n\nDo it.',
      step: '1',
      stepName: 'Do',
      retryCount: 0,
      variables: {},
      steps: [],
      pendingSteps: [],
      agentBindings: {},
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      delegation,
    };
  }

  it('schema accepts linkage with extended fields', () => {
    const state = makeSchemaState({
      parentRunId: 'run-parent',
      parentStepId: '1',
      tokenHash: `sha256:${'a'.repeat(64)}`,
      parentStep: '1',
      parentFrameKey: '1|',
      parentEntry: 1,
    });

    const result = RunbookStateSchema.safeParse(state);
    expect(result.success).toBe(true);
  });

  it('schema accepts linkage without extended fields (backward compat)', () => {
    const state = makeSchemaState({
      parentRunId: 'run-parent',
      parentStepId: '1',
      tokenHash: `sha256:${'b'.repeat(64)}`,
    });

    const result = RunbookStateSchema.safeParse(state);
    expect(result.success).toBe(true);
  });

  it('schema rejects non-positive parentEntry', () => {
    const state = makeSchemaState({
      parentRunId: 'run-parent',
      parentStepId: '1',
      tokenHash: `sha256:${'c'.repeat(64)}`,
      parentEntry: 0,
    });

    const result = RunbookStateSchema.safeParse(state);
    expect(result.success).toBe(false);
  });
});

describe('DelegationLinkage type shape', () => {
  it('returns true when delegation field is present', () => {
    const linkage: DelegationLinkage = {
      parentRunId: 'run-parent',
      parentStepId: '1',
      tokenHash: `sha256:${'a'.repeat(64)}`,
    };
    expect(linkage).toBeDefined();
    expect(linkage.parentRunId).toBe('run-parent');
  });

  it('undefined delegation means no linkage', () => {
    const state = { delegation: undefined };
    expect(state.delegation).toBeUndefined();
  });
});

describe('frame identity derivation for propagation', () => {
  function makeState(overrides: Partial<RunbookState>): RunbookState {
    return {
      id: 'run-1',
      runbook: 'test.md',
      runbookPath: '/tmp/test.md',
      runbookSrc: '## 1. Step\n- PASS: COMPLETE\n\nTest.',
      step: '1',
      stepName: 'Step',
      retryCount: 0,
      variables: {},
      steps: [],
      pendingSteps: [],
      agentBindings: {},
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it('derives frame key from step without FOR loop', () => {
    const state = makeState({ step: '2' });
    const frame = deriveActiveFrame(state);
    expect(frame.frameKey).toBe('2|');
    expect(frame.step).toBe('2');
    expect(frame.iteration).toBeUndefined();
  });

  it('derives frame key with FOR loop iteration', () => {
    const state = makeState({
      step: '1',
      forStack: [
        {
          stepId: '1',
          iteration: 3,
          start: 1,
          end: 5,
          implicit: false,
          source: { kind: 'range' },
        },
      ],
    });
    const frame = deriveActiveFrame(state);
    expect(frame.frameKey).toBe('1|3');
    expect(frame.iteration).toBe(3);
  });

  it('builds completion key with substep', () => {
    const frameKey = buildFrameKey('1');
    expect(frameKey).toBe('1|');

    const completionKey = buildCompletionKey(frameKey, 1, '2');
    expect(completionKey).toBe('1||1|2');
  });

  it('uses stored parentFrameKey when available', () => {
    const linkage: DelegationLinkage = {
      parentRunId: 'run-parent',
      parentStepId: '1',
      tokenHash: `sha256:${'a'.repeat(64)}`,
      parentStep: '1',
      parentFrameKey: '1|',
      parentEntry: 1,
    };

    // When parentFrameKey is present, use it directly instead of deriving
    const frameKey = linkage.parentFrameKey ?? buildFrameKey('1');
    const entry = linkage.parentEntry ?? 1;
    const completionKey = buildCompletionKey(frameKey, entry, linkage.parentStepId);

    expect(completionKey).toBe('1||1|1');
  });

  it('falls back to deriveActiveFrame when parentFrameKey absent', () => {
    const linkage: DelegationLinkage = {
      parentRunId: 'run-parent',
      parentStepId: '2',
      tokenHash: `sha256:${'a'.repeat(64)}`,
      // No parentFrameKey, parentEntry — legacy linkage
    };

    const parentState = makeState({ step: '1', activeEntry: 2 });
    const frame = deriveActiveFrame(parentState);
    const frameKey = linkage.parentFrameKey ?? frame.frameKey;
    const entry = linkage.parentEntry ?? parentState.activeEntry ?? 1;

    expect(frameKey).toBe('1|');
    expect(entry).toBe(2);
  });
});
