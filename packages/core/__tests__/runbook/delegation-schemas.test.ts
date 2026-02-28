import { describe, it, expect } from '@jest/globals';
import {
  StepDelegationSchema,
  ContextSnapshotSchema,
  AncestorSnapshotSchema,
  RunbookStateSchema,
} from '../../src/schemas.js';

describe('AncestorSnapshotSchema', () => {
  it('accepts valid ancestor snapshot', () => {
    const result = AncestorSnapshotSchema.safeParse({
      runId: 'run-123',
      runbook: 'deploy.md',
      step: '1',
      substep: '2',
      vars: { env: 'staging' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts null substep', () => {
    const result = AncestorSnapshotSchema.safeParse({
      runId: 'run-123',
      runbook: 'deploy.md',
      step: '1',
      substep: null,
      vars: {},
    });
    expect(result.success).toBe(true);
  });
});

describe('AncestorSnapshotSchema structural fields', () => {
  it('accepts at and index fields', () => {
    const result = AncestorSnapshotSchema.safeParse({
      runId: 'run-1',
      runbook: 'parent.md',
      step: '2',
      substep: '1',
      vars: {},
      at: '2.3.1',
      index: 3,
    });
    expect(result.success).toBe(true);
  });

  it('accepts without at and index (backward compat)', () => {
    const result = AncestorSnapshotSchema.safeParse({
      runId: 'run-1',
      runbook: 'parent.md',
      step: '2',
      substep: null,
      vars: {},
    });
    expect(result.success).toBe(true);
  });
});

describe('ContextSnapshotSchema', () => {
  it('accepts valid context snapshot', () => {
    const result = ContextSnapshotSchema.safeParse({
      vars: { env: 'staging', version: '1.2.3' },
      ancestors: [
        {
          runId: 'parent-1',
          runbook: 'parent.md',
          step: '1',
          substep: null,
          vars: { key: 'value' },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts empty ancestors', () => {
    const result = ContextSnapshotSchema.safeParse({
      vars: {},
      ancestors: [],
    });
    expect(result.success).toBe(true);
  });

  it('accepts step, substep, at, and index fields', () => {
    const result = ContextSnapshotSchema.safeParse({
      vars: { env: 'prod' },
      ancestors: [],
      step: '2',
      substep: '1',
      at: '2.3.1',
      index: 3,
    });
    expect(result.success).toBe(true);
  });

  it('accepts without structural fields (backward compat)', () => {
    const result = ContextSnapshotSchema.safeParse({
      vars: { env: 'prod' },
      ancestors: [],
    });
    expect(result.success).toBe(true);
  });
});

describe('StepDelegationSchema', () => {
  const validDelegation = {
    tokenHash: 'sha256:' + 'a'.repeat(64),
    childRunbookPath: 'child-runbook.md',
    contextSnapshot: {
      vars: { env: 'staging' },
      ancestors: [],
    },
    childRunId: null,
    createdAt: '2026-02-27T10:00:00.000Z',
    cancelledAt: null,
  };

  it('accepts valid StepDelegation', () => {
    const result = StepDelegationSchema.safeParse(validDelegation);
    expect(result.success).toBe(true);
  });

  it('rejects tokenHash without sha256: prefix', () => {
    const result = StepDelegationSchema.safeParse({
      ...validDelegation,
      tokenHash: 'a'.repeat(64),
    });
    expect(result.success).toBe(false);
  });

  it('rejects tokenHash with wrong hex length', () => {
    const result = StepDelegationSchema.safeParse({
      ...validDelegation,
      tokenHash: 'sha256:' + 'a'.repeat(32),
    });
    expect(result.success).toBe(false);
  });

  it('accepts non-null childRunId', () => {
    const result = StepDelegationSchema.safeParse({
      ...validDelegation,
      childRunId: 'child-run-456',
    });
    expect(result.success).toBe(true);
  });

  it('accepts non-null cancelledAt', () => {
    const result = StepDelegationSchema.safeParse({
      ...validDelegation,
      cancelledAt: '2026-02-27T11:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });
});

describe('SubstepStateSchema backward compatibility', () => {
  it('accepts substep state without delegation field', () => {
    const state = {
      id: '1',
      status: 'pending' as const,
    };
    // SubstepState is embedded in RunbookState, so we test via RunbookStateSchema
    // But we can also verify the schema directly accepts objects without delegation
    const runbookState = createMinimalRunbookState({
      substepStates: [state],
    });
    const result = RunbookStateSchema.safeParse(runbookState);
    expect(result.success).toBe(true);
  });

  it('accepts substep state with delegation field', () => {
    const state = {
      id: '1',
      status: 'pending' as const,
      delegation: {
        tokenHash: 'sha256:' + 'b'.repeat(64),
        childRunbookPath: 'child.md',
        contextSnapshot: { vars: {}, ancestors: [] },
        childRunId: null,
        createdAt: '2026-02-27T10:00:00.000Z',
        cancelledAt: null,
      },
    };
    const runbookState = createMinimalRunbookState({
      substepStates: [state],
    });
    const result = RunbookStateSchema.safeParse(runbookState);
    expect(result.success).toBe(true);
  });
});

describe('RunbookStateSchema round-trip with delegation', () => {
  it('preserves delegation data through parse', () => {
    const delegation = {
      tokenHash: 'sha256:' + 'c'.repeat(64),
      childRunbookPath: 'child.md',
      contextSnapshot: {
        vars: { env: 'prod' },
        ancestors: [
          {
            runId: 'parent-1',
            runbook: 'parent.md',
            step: '1',
            substep: '2',
            vars: { key: 'value' },
          },
        ],
      },
      childRunId: 'child-run-789',
      createdAt: '2026-02-27T10:00:00.000Z',
      cancelledAt: null,
    };
    const runbookState = createMinimalRunbookState({
      substepStates: [{ id: '1', status: 'pending', delegation }],
    });
    const result = RunbookStateSchema.safeParse(runbookState);
    expect(result.success).toBe(true);
    if (result.success) {
      const ss = result.data.substepStates?.[0];
      expect(ss?.delegation?.tokenHash).toBe(delegation.tokenHash);
      expect(ss?.delegation?.childRunbookPath).toBe('child.md');
      expect(ss?.delegation?.contextSnapshot.vars).toEqual({ env: 'prod' });
      expect(ss?.delegation?.contextSnapshot.ancestors).toHaveLength(1);
      expect(ss?.delegation?.childRunId).toBe('child-run-789');
    }
  });
});

/** Helper to create a minimal valid RunbookState for schema testing. */
function createMinimalRunbookState(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test-id',
    runbook: 'test.md',
    runbookPath: 'test.md',
    step: '1',
    stepName: 'Test step',
    retryCount: 0,
    variables: {},
    steps: [{ id: '1', status: 'running' }],
    pendingSteps: [],
    agentBindings: {},
    startedAt: '2026-02-27T10:00:00.000Z',
    updatedAt: '2026-02-27T10:00:00.000Z',
    ...overrides,
  };
}
