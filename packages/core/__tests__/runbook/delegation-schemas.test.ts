import { describe, it, expect } from '@jest/globals';
import {
  StepDelegationSchema,
  ContextSnapshotSchema,
  AncestorSnapshotSchema,
  RunbookStateSchema,
  DelegationTokenHashSchema,
  AgentRunbookOwnershipSchema,
  SessionDataSchema,
} from '../../src/schemas.js';
import { DelegationStatusEntrySchema, StatusResponseSchema } from '../../src/output/zod-schemas.js';
import { isAgentRunbookOwnership } from '../../src/runbook/agent-ownership.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';

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

  it('rejects legacy snapshot with sources field', () => {
    const result = ContextSnapshotSchema.safeParse({
      vars: { env: 'prod' },
      ancestors: [],
      sources: { items: { kind: 'array', items: ['a', 'b', 'c'] } },
    });
    expect(result.success).toBe(false);
  });

  it('accepts snapshot without sources (backward compat)', () => {
    const result = ContextSnapshotSchema.safeParse({
      vars: { env: 'prod' },
      ancestors: [],
    });
    expect(result.success).toBe(true);
  });

  it('accepts array vars values (unified variable model)', () => {
    const result = ContextSnapshotSchema.safeParse({
      vars: { env: 'prod', items: ['a', 'b'] },
      ancestors: [],
    });
    expect(result.success).toBe(true);
  });

  it('accepts number vars values', () => {
    const result = ContextSnapshotSchema.safeParse({
      vars: { env: 'prod', port: 3000 },
      ancestors: [],
    });
    expect(result.success).toBe(true);
  });

  it('accepts object vars values', () => {
    const result = ContextSnapshotSchema.safeParse({
      vars: { config: { host: 'localhost', port: 3000 } },
      ancestors: [],
    });
    expect(result.success).toBe(true);
  });

  it('accepts deeply nested object vars values', () => {
    const result = ContextSnapshotSchema.safeParse({
      vars: { config: { db: { host: 'localhost', port: 5432 } } },
      ancestors: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.vars.config).toEqual({ db: { host: 'localhost', port: 5432 } });
    }
  });

  it('rejects boolean vars values', () => {
    const result = ContextSnapshotSchema.safeParse({
      vars: { debug: true },
      ancestors: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects null vars values', () => {
    const result = ContextSnapshotSchema.safeParse({
      vars: { val: null },
      ancestors: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('StepDelegationSchema', () => {
  const validDelegation = {
    tokenHash: `sha256:${'a'.repeat(64)}`,
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
      tokenHash: `sha256:${'a'.repeat(32)}`,
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

  it('preserves extraVars through parse (round-trip)', () => {
    const result = StepDelegationSchema.safeParse({
      ...validDelegation,
      extraVars: { environment: 'staging', port: 3000 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.extraVars).toEqual({ environment: 'staging', port: 3000 });
    }
  });

  it('accepts StepDelegation without extraVars (result.extraVars is undefined)', () => {
    const result = StepDelegationSchema.safeParse(validDelegation);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.extraVars).toBeUndefined();
    }
  });
});

describe('DelegationTokenHashSchema', () => {
  it('accepts canonical token hashes', () => {
    const result = DelegationTokenHashSchema.safeParse(`sha256:${'c'.repeat(64)}`);
    expect(result.success).toBe(true);
  });

  it('rejects uppercase and malformed hashes', () => {
    expect(DelegationTokenHashSchema.safeParse(`sha256:${'C'.repeat(64)}`).success).toBe(false);
    expect(DelegationTokenHashSchema.safeParse('sha256:bad').success).toBe(false);
    expect(DelegationTokenHashSchema.safeParse('not-a-hash').success).toBe(false);
  });
});

describe('AgentRunbookOwnershipSchema', () => {
  const validOwnership = {
    kind: 'agent-owned-runbook',
    ownerKey: 'agent:agent-a:session:session-a',
    agent_id: 'agent-a',
    session_id: 'session-a',
    childRunId: 'wf-2026-04-28-child',
    tokenHash: `sha256:${'d'.repeat(64)}`,
    parentRunId: 'wf-2026-04-28-parent',
    parentStepId: '1',
    parentStep: '1',
    parentFrameKey: '1|',
    parentEntry: 1,
    claimedAt: '2026-04-28T00:00:00.000Z',
    updatedAt: '2026-04-28T00:00:01.000Z',
  };

  it('accepts a complete ownership record', () => {
    expect(AgentRunbookOwnershipSchema.safeParse(validOwnership).success).toBe(true);
  });

  it('requires agent_id even though ownerKey also contains it', () => {
    const { agent_id: _agentId, ...withoutAgentId } = validOwnership;
    expect(AgentRunbookOwnershipSchema.safeParse(withoutAgentId).success).toBe(false);
  });

  it('rejects malformed token hashes', () => {
    expect(
      AgentRunbookOwnershipSchema.safeParse({
        ...validOwnership,
        tokenHash: 'not-a-hash',
      }).success,
    ).toBe(false);
  });

  it('rejects records whose ownerKey does not match agent_id and session_id', () => {
    expect(
      AgentRunbookOwnershipSchema.safeParse({
        ...validOwnership,
        ownerKey: 'agent:other-agent:session:session-a',
      }).success,
    ).toBe(false);
  });

  it('accepts agent-only owner keys when session_id is absent', () => {
    expect(
      AgentRunbookOwnershipSchema.safeParse({
        ...validOwnership,
        ownerKey: 'agent:agent-a',
        session_id: undefined,
      }).success,
    ).toBe(true);
  });

  it('does not structurally narrow incomplete ownership objects', () => {
    expect(isAgentRunbookOwnership({ kind: 'agent-owned-runbook' })).toBe(false);
  });
});

describe('SessionDataSchema ownership compatibility', () => {
  const ownershipFor = (overrides: Record<string, unknown> = {}) => ({
    kind: 'agent-owned-runbook',
    ownerKey: 'agent:agent-a:session:session-a',
    agent_id: 'agent-a',
    session_id: 'session-a',
    childRunId: 'wf-2026-04-28-child',
    tokenHash: `sha256:${'d'.repeat(64)}`,
    parentRunId: 'wf-2026-04-28-parent',
    parentStepId: '1',
    parentStep: '1',
    parentFrameKey: '1|',
    parentEntry: 1,
    claimedAt: '2026-04-28T00:00:00.000Z',
    updatedAt: '2026-04-28T00:00:01.000Z',
    ...overrides,
  });

  it('loads legacy sessions without ownedRunbooks', () => {
    const result = SessionDataSchema.safeParse({ defaultStack: ['parent'] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ownedRunbooks).toEqual({});
      expect(result.data.stashedRunbookOwnership).toBeUndefined();
    }
  });

  it('rejects malformed ownedRunbooks instead of ignoring them', () => {
    const result = SessionDataSchema.safeParse({
      defaultStack: ['parent'],
      ownedRunbooks: {
        bad: [{ kind: 'agent-owned-runbook', childRunId: 42 }],
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects ownedRunbooks entries whose map key differs from ownerKey', () => {
    const result = SessionDataSchema.safeParse({
      defaultStack: ['parent'],
      ownedRunbooks: {
        'agent:agent-b:session:session-a': [ownershipFor()],
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects stashed ownership that does not match the stashed runbook id', () => {
    const result = SessionDataSchema.safeParse({
      defaultStack: ['parent'],
      stashedRunbookId: 'different-child',
      stashedRunbookOwnership: {
        kind: 'agent-owned-runbook',
        ownerKey: 'agent:agent-a:session:session-a',
        agent_id: 'agent-a',
        session_id: 'session-a',
        childRunId: 'child',
        tokenHash: `sha256:${'f'.repeat(64)}`,
        parentRunId: 'parent',
        parentStepId: '1',
        claimedAt: '2026-04-28T00:00:00.000Z',
        updatedAt: '2026-04-28T00:00:00.000Z',
      },
    });

    expect(result.success).toBe(false);
  });

  it('accepts an anonymous stashedRunbookId without stashed ownership when unique', () => {
    const result = SessionDataSchema.safeParse({
      defaultStack: ['parent'],
      stashedRunbookId: 'child',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stashedRunbookId).toBe('child');
      expect(result.data.stashedRunbookOwnership).toBeUndefined();
    }
  });

  it('rejects anonymous stashedRunbookId duplicates instead of ignoring them', () => {
    const result = SessionDataSchema.safeParse({
      defaultStack: ['parent', 'child'],
      stashedRunbookId: 'child',
      ownedRunbooks: {
        'agent:agent-a:session:session-a': [ownershipFor({ childRunId: 'child' })],
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues.map((issue) => issue.message).join('\n');
      expect(message).toContain('stashedRunbookId');
    }
  });

  it('rejects a session with the same childRunId in owned stack and stash', () => {
    const result = SessionDataSchema.safeParse({
      defaultStack: ['parent'],
      stashedRunbookId: 'child',
      stashedRunbookOwnership: ownershipFor({ childRunId: 'child' }),
      ownedRunbooks: {
        'agent:agent-a:session:session-a': [ownershipFor({ childRunId: 'child' })],
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues.map((issue) => issue.message).join('\n');
      expect(message).toContain('ownedRunbooks.agent:agent-a:session:session-a.0.childRunId');
      expect(message).toContain('stashedRunbookOwnership.childRunId');
    }
  });

  it('rejects duplicate childRunId entries across owned stacks', () => {
    const result = SessionDataSchema.safeParse({
      defaultStack: ['parent'],
      ownedRunbooks: {
        'agent:agent-a:session:session-a': [ownershipFor({ childRunId: 'child' })],
        'agent:agent-b:session:session-b': [
          ownershipFor({
            ownerKey: 'agent:agent-b:session:session-b',
            agent_id: 'agent-b',
            session_id: 'session-b',
            childRunId: 'child',
          }),
        ],
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const issuePaths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(issuePaths).toContain('ownedRunbooks.agent:agent-a:session:session-a.0.childRunId');
      expect(issuePaths).toContain('ownedRunbooks.agent:agent-b:session:session-b.0.childRunId');
    }
  });

  it('reports every location in a three-way duplicate childRunId conflict', () => {
    const result = SessionDataSchema.safeParse({
      defaultStack: ['child'],
      stashedRunbookId: 'child',
      ownedRunbooks: {
        'agent:agent-a:session:session-a': [ownershipFor({ childRunId: 'child' })],
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const issuePaths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(issuePaths).toContain('defaultStack.0');
      expect(issuePaths).toContain('ownedRunbooks.agent:agent-a:session:session-a.0.childRunId');
      expect(issuePaths).toContain('stashedRunbookId');
    }
  });

  it('rejects a child runbook that is both default-active and owner-owned', () => {
    const result = SessionDataSchema.safeParse({
      defaultStack: ['parent', 'child'],
      ownedRunbooks: {
        'agent:agent-a:session:session-a': [ownershipFor({ childRunId: 'child' })],
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues.map((issue) => issue.message).join('\n');
      expect(message).toContain('defaultStack.1');
      expect(message).toContain('ownedRunbooks.agent:agent-a:session:session-a.0.childRunId');
    }
  });

  it('rejects a child runbook that is both default-active and owner-stashed', () => {
    const result = SessionDataSchema.safeParse({
      defaultStack: ['parent', 'child'],
      stashedRunbookId: 'child',
      stashedRunbookOwnership: ownershipFor({ childRunId: 'child' }),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues.map((issue) => issue.message).join('\n');
      expect(message).toContain('defaultStack.1');
      expect(message).toContain('stashedRunbookOwnership.childRunId');
    }
  });
});

describe('SubstepStateSchema backward compatibility', () => {
  it('accepts substep state without delegation field', () => {
    const state = {
      id: '1',
      frameKey: buildFrameKey('1'),
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

  it('accepts substep state with frameKey field', () => {
    const state = {
      id: '1',
      frameKey: buildFrameKey('1', 2),
      status: 'pending' as const,
    };
    const runbookState = createMinimalRunbookState({
      substepStates: [state],
    });
    const result = RunbookStateSchema.safeParse(runbookState);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.substepStates?.[0]?.frameKey).toBe('1|2');
    }
  });

  it('rejects substep state without frameKey', () => {
    const state = {
      id: '1',
      status: 'pending' as const,
    };
    const runbookState = createMinimalRunbookState({
      substepStates: [state as any],
    });
    const result = RunbookStateSchema.safeParse(runbookState);
    expect(result.success).toBe(false);
  });

  it('accepts substep state with delegation field', () => {
    const state = {
      id: '1',
      frameKey: buildFrameKey('1'),
      status: 'pending' as const,
      delegation: {
        tokenHash: `sha256:${'b'.repeat(64)}`,
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
      tokenHash: `sha256:${'c'.repeat(64)}`,
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
      substepStates: [{ id: '1', frameKey: buildFrameKey('1'), status: 'pending', delegation }],
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

describe('DelegationStatusEntrySchema', () => {
  const TOKEN_HASH = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
  const TOKEN = 'rdtk_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  it('validates a pending entry with a recovery token', () => {
    const entry = {
      substep: '1.1',
      runbook: 'child.md',
      state: 'pending',
      tokenHash: TOKEN_HASH,
      token: TOKEN,
    };
    expect(() => DelegationStatusEntrySchema.parse(entry)).not.toThrow();
  });

  it('validates a claimed entry with childRunId', () => {
    const entry = {
      substep: '1.1',
      runbook: 'child.md',
      state: 'claimed',
      childRunId: 'run_abc123',
      tokenHash: TOKEN_HASH,
    };
    expect(() => DelegationStatusEntrySchema.parse(entry)).not.toThrow();
  });

  it('validates a cancelled entry', () => {
    const entry = {
      substep: '1.1',
      runbook: 'child.md',
      state: 'cancelled',
      tokenHash: TOKEN_HASH,
    };
    expect(() => DelegationStatusEntrySchema.parse(entry)).not.toThrow();
  });

  it('rejects invalid state', () => {
    const entry = {
      substep: '1.1',
      runbook: 'child.md',
      state: 'resolved',
      tokenHash: TOKEN_HASH,
    };
    expect(() => DelegationStatusEntrySchema.parse(entry)).toThrow();
  });

  it('rejects missing required fields', () => {
    expect(() => DelegationStatusEntrySchema.parse({})).toThrow();
  });

  it('rejects entry missing tokenHash', () => {
    const entry = { substep: '1.1', runbook: 'child.md', state: 'pending' };
    expect(() => DelegationStatusEntrySchema.parse(entry)).toThrow();
  });

  it('rejects malformed recovery tokens', () => {
    const entry = {
      substep: '1.1',
      runbook: 'child.md',
      state: 'pending',
      tokenHash: TOKEN_HASH,
      token: 'bad-token',
    };
    expect(() => DelegationStatusEntrySchema.parse(entry)).toThrow();
  });

  it('rejects recovery tokens on claimed entries', () => {
    const entry = {
      substep: '1.1',
      runbook: 'child.md',
      state: 'claimed',
      childRunId: 'run_abc123',
      tokenHash: TOKEN_HASH,
      token: TOKEN,
    };
    expect(() => DelegationStatusEntrySchema.parse(entry)).toThrow();
  });
});

describe('StatusResponseSchema with delegations', () => {
  const TOKEN_HASH_A = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
  const TOKEN_HASH_B = 'sha256:2222222222222222222222222222222222222222222222222222222222222222';

  it('accepts delegations field', () => {
    const status = {
      kind: 'status',
      active: true,
      stashed: false,
      delegations: [
        { substep: '1.1', runbook: 'review.md', state: 'pending', tokenHash: TOKEN_HASH_A },
        {
          substep: '1.2',
          runbook: 'test.md',
          state: 'claimed',
          childRunId: 'run_xyz',
          tokenHash: TOKEN_HASH_B,
        },
      ],
    };
    expect(() => StatusResponseSchema.parse(status)).not.toThrow();
  });

  it('validates without delegations (backward compat)', () => {
    const status = { kind: 'status', active: true, stashed: false };
    expect(() => StatusResponseSchema.parse(status)).not.toThrow();
  });

  it('validates with empty delegations array', () => {
    const status = { kind: 'status', active: true, stashed: false, delegations: [] };
    expect(() => StatusResponseSchema.parse(status)).not.toThrow();
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
    startedAt: '2026-02-27T10:00:00.000Z',
    updatedAt: '2026-02-27T10:00:00.000Z',
    ...overrides,
  };
}
