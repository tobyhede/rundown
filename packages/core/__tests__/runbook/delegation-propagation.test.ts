import { describe, it, expect } from '@jest/globals';
import { RunbookStateSchema } from '../../src/schemas.js';
import {
  buildCompletionKey,
  buildFrameKey,
  deriveActiveFrame,
} from '../../src/runbook/targeting.js';
import type { DelegationLinkage, RunbookState } from '../../src/runbook/types.js';

describe('DelegationLinkage extended fields', () => {
  function makeSchemaState(parentLinkage: Record<string, unknown>): Record<string, unknown> {
    return {
      id: 'run-child',
      runbook: 'child.md',
      runbookPath: '/tmp/child.md',
      runbookSrc: '## 1. Do\n- PASS COMPLETE\n\nDo it.',
      step: '1',
      stepName: 'Do',
      retryCount: 0,
      variables: {},
      steps: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      parentLinkage,
    };
  }

  it('schema accepts delegation linkage with extended fields', () => {
    const state = makeSchemaState({
      kind: 'delegation',
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

  it('schema accepts delegation linkage without extended fields', () => {
    const state = makeSchemaState({
      kind: 'delegation',
      parentRunId: 'run-parent',
      parentStepId: '1',
      tokenHash: `sha256:${'b'.repeat(64)}`,
    });

    const result = RunbookStateSchema.safeParse(state);
    expect(result.success).toBe(true);
  });

  it('schema rejects non-positive parentEntry', () => {
    const state = makeSchemaState({
      kind: 'delegation',
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
  it('returns true when parentLinkage field is present', () => {
    const linkage: DelegationLinkage = {
      kind: 'delegation',
      parentRunId: 'run-parent',
      parentStepId: '1',
      tokenHash: `sha256:${'a'.repeat(64)}`,
    };
    expect(linkage).toBeDefined();
    expect(linkage.parentRunId).toBe('run-parent');
    expect(linkage.kind).toBe('delegation');
  });

  it('undefined parentLinkage means no linkage', () => {
    const state = { parentLinkage: undefined };
    expect(state.parentLinkage).toBeUndefined();
  });
});

describe('parentLinkage discriminated union schema', () => {
  function makeBaseState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'run-child',
      runbook: 'child.md',
      runbookPath: '/tmp/child.md',
      runbookSrc: '## 1. Do\n- PASS COMPLETE\n\nDo it.',
      step: '1',
      stepName: 'Do',
      retryCount: 0,
      variables: {},
      steps: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it('accepts parentLinkage with kind: delegation', () => {
    const state = makeBaseState({
      parentLinkage: {
        kind: 'delegation',
        parentRunId: 'run-parent',
        parentStepId: '1',
        tokenHash: `sha256:${'a'.repeat(64)}`,
        parentStep: '1',
        parentFrameKey: '1|',
        parentEntry: 1,
      },
    });

    const result = RunbookStateSchema.safeParse(state);
    expect(result.success).toBe(true);
    if (result.success) {
      const parsed = result.data as Record<string, unknown>;
      expect(parsed).toHaveProperty('parentLinkage');
      expect((parsed.parentLinkage as Record<string, unknown>).kind).toBe('delegation');
    }
  });

  it('accepts parentLinkage with kind: inline', () => {
    const state = makeBaseState({
      parentLinkage: {
        kind: 'inline',
        parentRunId: 'run-parent',
        parentStepId: '2',
        parentStep: '1',
        parentFrameKey: '1|',
        parentEntry: 1,
      },
    });

    const result = RunbookStateSchema.safeParse(state);
    expect(result.success).toBe(true);
    if (result.success) {
      const parsed = result.data as Record<string, unknown>;
      expect(parsed).toHaveProperty('parentLinkage');
      expect((parsed.parentLinkage as Record<string, unknown>).kind).toBe('inline');
    }
  });

  it('rejects parentLinkage with unknown kind', () => {
    const state = makeBaseState({
      parentLinkage: {
        kind: 'bogus',
        parentRunId: 'run-parent',
        parentStepId: '1',
      },
    });

    const result = RunbookStateSchema.safeParse(state);
    expect(result.success).toBe(false);
  });

  it('does not recognize old delegation field as parentLinkage', () => {
    // Old 'delegation' field is passthrough'd but NOT treated as parentLinkage.
    // State with only the old field should have no parentLinkage in the typed result.
    const state = makeBaseState({
      delegation: {
        parentRunId: 'run-parent',
        parentStepId: '1',
        tokenHash: `sha256:${'a'.repeat(64)}`,
      },
    });

    const result = RunbookStateSchema.safeParse(state);
    expect(result.success).toBe(true);
    if (result.success) {
      // The typed output should NOT have parentLinkage (it was never set)
      expect(result.data.parentLinkage).toBeUndefined();
    }
  });

  it('does not recognize old inlineLinkage field as parentLinkage', () => {
    // Old 'inlineLinkage' field is passthrough'd but NOT treated as parentLinkage.
    const state = makeBaseState({
      inlineLinkage: {
        kind: 'inline',
        parentRunId: 'run-parent',
        parentStepId: '1',
      },
    });

    const result = RunbookStateSchema.safeParse(state);
    expect(result.success).toBe(true);
    if (result.success) {
      // The typed output should NOT have parentLinkage (it was never set)
      expect(result.data.parentLinkage).toBeUndefined();
    }
  });
});

describe('frame identity derivation for propagation', () => {
  function makeState(overrides: Partial<RunbookState>): RunbookState {
    return {
      id: 'run-1',
      runbook: 'test.md',
      runbookPath: '/tmp/test.md',
      runbookSrc: '## 1. Step\n- PASS COMPLETE\n\nTest.',
      step: '1',
      stepName: 'Step',
      retryCount: 0,
      variables: {},
      steps: [],
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
      kind: 'delegation',
      parentRunId: 'run-parent',
      parentStepId: '1',
      tokenHash: `sha256:${'a'.repeat(64)}`,
      parentStep: '1',
      parentFrameKey: buildFrameKey('1'),
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
      kind: 'delegation',
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
