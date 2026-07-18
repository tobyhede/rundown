import { describe, it, expect } from '@jest/globals';
import {
  StepDelegationSchema,
  ContextSnapshotSchema,
  AncestorSnapshotSchema,
  RunbookStateSchema,
  makeRunbookStateSchema,
  DelegationTokenHashSchema,
  ClaimRecordSchema,
  SessionDataSchema,
} from '../../src/schemas.js';
import { DelegationStatusEntrySchema, StatusResponseSchema } from '../../src/output/zod-schemas.js';
import {
  assertClaimLookupKey,
  assertClaimSecretHash,
  createClaimRecord,
} from '../../src/runbook/claim-id.js';
import { assertRunId } from '../../src/runbook/run-id.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';

const PARENT_RUN_ID = `rd_${'1'.repeat(32)}`;
const CHILD_RUN_ID = `rd_${'2'.repeat(32)}`;
const OTHER_CHILD_RUN_ID = `rd_${'3'.repeat(32)}`;

describe('AncestorSnapshotSchema', () => {
  it('accepts valid ancestor snapshot', () => {
    const result = AncestorSnapshotSchema.safeParse({
      runId: PARENT_RUN_ID,
      runbook: 'deploy.md',
      step: '1',
      substep: '2',
      vars: { env: 'staging' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts null substep', () => {
    const result = AncestorSnapshotSchema.safeParse({
      runId: PARENT_RUN_ID,
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
      runId: PARENT_RUN_ID,
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
      runId: PARENT_RUN_ID,
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
          runId: PARENT_RUN_ID,
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

// IterationBindingSchema is not exported; it is exercised through the
// `iterationBinding` field of ContextSnapshotSchema — the persisted-snapshot
// validation seam (language spec §10.4). These pin the discriminated-union
// rejection paths directly, not just the happy-path integration coverage.
describe('ContextSnapshotSchema iterationBinding', () => {
  it('accepts a range iteration binding', () => {
    const result = ContextSnapshotSchema.safeParse({
      vars: {},
      ancestors: [],
      iterationBinding: { kind: 'range', index: 2, variable: 'i' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts an item iteration binding with a resolved value', () => {
    const result = ContextSnapshotSchema.safeParse({
      vars: {},
      ancestors: [],
      iterationBinding: { kind: 'item', index: 1, variable: 'item', value: { name: 'a' } },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an item iteration binding missing its value', () => {
    const result = ContextSnapshotSchema.safeParse({
      vars: {},
      ancestors: [],
      iterationBinding: { kind: 'item', index: 1, variable: 'item' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an iteration binding with a non-positive index', () => {
    const result = ContextSnapshotSchema.safeParse({
      vars: {},
      ancestors: [],
      iterationBinding: { kind: 'range', index: 0, variable: 'i' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an iteration binding with an unknown kind', () => {
    const result = ContextSnapshotSchema.safeParse({
      vars: {},
      ancestors: [],
      iterationBinding: { kind: 'sequence', index: 1, variable: 'i' },
    });
    expect(result.success).toBe(false);
  });
});

describe('StepDelegationSchema', () => {
  const validDelegation = {
    tokenHash: `sha256:${'a'.repeat(64)}`,
    childRunbookPath: 'child-runbook.md',
    childRunbookRef: { source: 'project', path: 'child-runbook.md' },
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
      childRunId: CHILD_RUN_ID,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a token on a claimed delegation', () => {
    const result = StepDelegationSchema.safeParse({
      ...validDelegation,
      token: 'rdtk_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
      childRunId: CHILD_RUN_ID,
    });
    expect(result.success).toBe(false);
  });

  it('accepts non-null cancelledAt', () => {
    const result = StepDelegationSchema.safeParse({
      ...validDelegation,
      cancelledAt: '2026-02-27T11:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a token on a cancelled delegation', () => {
    const result = StepDelegationSchema.safeParse({
      ...validDelegation,
      token: 'rdtk_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
      cancelledAt: '2026-02-27T11:00:00.000Z',
    });
    expect(result.success).toBe(false);
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

describe('ClaimRecordSchema', () => {
  const validClaim = {
    claimKey: 'rdclk_11111111111111111111111111111111',
    secretHash: `sha256:${'a'.repeat(64)}`,
    controlledRunId: CHILD_RUN_ID,
    delegation: {
      childRunId: CHILD_RUN_ID,
      parentRunId: PARENT_RUN_ID,
      parentStepId: '1.1',
      parentStep: 'Process item',
      parentFrameKey: buildFrameKey('1', 0),
      parentEntry: 1,
      tokenHash: `sha256:${'b'.repeat(64)}`,
    },
    grants: [
      { action: 'mutate-run', runId: CHILD_RUN_ID },
      {
        action: 'report-delegation-result',
        childRunId: CHILD_RUN_ID,
        parentRunId: PARENT_RUN_ID,
        parentStepId: '1.1',
        parentStep: 'Process item',
        parentFrameKey: buildFrameKey('1', 0),
        parentEntry: 1,
        tokenHash: `sha256:${'b'.repeat(64)}`,
      },
    ],
    issuedAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:01.000Z',
    lastSeenAt: '2026-07-16T00:00:00.000Z',
  };

  it('accepts a complete proof-backed claim record with explicit grants', () => {
    expect(ClaimRecordSchema.safeParse(validClaim).success).toBe(true);
  });

  it('rejects a claim record with no lastSeenAt (#519)', () => {
    // `lastSeenAt` is REQUIRED — an optional field with a fallback would be
    // legacy-field hydration, which CLAUDE.md forbids.
    const { lastSeenAt: _omitted, ...withoutLastSeen } = validClaim;
    expect(ClaimRecordSchema.safeParse(withoutLastSeen).success).toBe(false);
  });

  it('rejects a claim record with an empty lastSeenAt (#519)', () => {
    expect(ClaimRecordSchema.safeParse({ ...validClaim, lastSeenAt: '' }).success).toBe(false);
  });

  it('sets lastSeenAt to issuedAt at claim creation (#519)', () => {
    const now = '2026-07-16T12:00:00.000Z';
    const record = createClaimRecord({
      claimKey: assertClaimLookupKey(validClaim.claimKey),
      secretHash: assertClaimSecretHash(validClaim.secretHash),
      controlledRunId: assertRunId(validClaim.controlledRunId),
      grants: [{ action: 'mutate-run', runId: assertRunId(validClaim.controlledRunId) }],
      now,
    });
    // A brand-new holder was last seen at issuance, so the idle clock starts
    // there rather than at zero/undefined.
    expect(record.lastSeenAt).toBe(now);
    expect(record.lastSeenAt).toBe(record.issuedAt);
  });

  it('rejects persisted reusable bearer claim ids', () => {
    const result = ClaimRecordSchema.safeParse({
      ...validClaim,
      claimId: 'rdclm_11111111111111111111111111111111_abcdefghijklmnopqrstuvwxyzABCDE1234567890-_',
    });

    expect(result.success).toBe(false);
  });

  it('rejects malformed lookup keys and secret hashes', () => {
    expect(ClaimRecordSchema.safeParse({ ...validClaim, claimKey: 'rdclm_plain' }).success).toBe(
      false,
    );
    expect(
      ClaimRecordSchema.safeParse({ ...validClaim, secretHash: 'sha256:not-hex' }).success,
    ).toBe(false);
  });

  it('rejects run-scoped grants that target a run other than controlledRunId', () => {
    const result = ClaimRecordSchema.safeParse({
      ...validClaim,
      grants: [{ action: 'mutate-run', runId: PARENT_RUN_ID }],
    });

    expect(result.success).toBe(false);
  });

  it('rejects delegated claims without a matching report-delegation-result grant', () => {
    const result = ClaimRecordSchema.safeParse({
      ...validClaim,
      grants: [{ action: 'mutate-run', runId: CHILD_RUN_ID }],
    });

    expect(result.success).toBe(false);
  });

  it('rejects delegated claims whose report grant does not match delegation linkage', () => {
    const result = ClaimRecordSchema.safeParse({
      ...validClaim,
      grants: [
        { action: 'mutate-run', runId: CHILD_RUN_ID },
        {
          action: 'report-delegation-result',
          childRunId: CHILD_RUN_ID,
          parentRunId: PARENT_RUN_ID,
          parentStepId: '1.2',
          parentStep: 'Process item',
          parentFrameKey: buildFrameKey('1', 0),
          parentEntry: 1,
          tokenHash: `sha256:${'b'.repeat(64)}`,
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('rejects non-delegated claims with delegation report grants', () => {
    const { delegation: _delegation, ...nonDelegatedClaim } = validClaim;

    const result = ClaimRecordSchema.safeParse(nonDelegatedClaim);

    expect(result.success).toBe(false);
  });

  it('rejects a delegation linkage / report grant with a non-positive parentEntry', () => {
    // The canonical RunbookState.parentLinkage requires parentEntry.positive();
    // a claim's linkage and report grant must agree, so parentEntry 0 (which no
    // real child linkage ever carries) is rejected rather than persisted as a
    // permanently-dead report grant.
    const zeroEntry = {
      ...validClaim,
      delegation: { ...validClaim.delegation, parentEntry: 0 },
      grants: [validClaim.grants[0], { ...validClaim.grants[1], parentEntry: 0 }],
    };

    expect(ClaimRecordSchema.safeParse(zeroEntry).success).toBe(false);
  });
});

describe('SessionDataSchema claims registry', () => {
  it('loads sessions without claims using an empty claims registry', () => {
    const result = SessionDataSchema.safeParse({ defaultStack: [PARENT_RUN_ID] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.claims).toEqual({});
    }
  });

  it('rejects claim records whose map key differs from claimKey', () => {
    const result = SessionDataSchema.safeParse({
      defaultStack: [PARENT_RUN_ID],
      claims: {
        rdclk_11111111111111111111111111111111: {
          claimKey: 'rdclk_22222222222222222222222222222222',
          secretHash: `sha256:${'a'.repeat(64)}`,
          controlledRunId: CHILD_RUN_ID,
          grants: [{ action: 'mutate-run', runId: CHILD_RUN_ID }],
          issuedAt: '2026-05-01T00:00:00.000Z',
          updatedAt: '2026-05-01T00:00:01.000Z',
          lastSeenAt: '2026-05-01T00:00:01.000Z',
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts the same claim record shape when the map key MATCHES claimKey (positive control)', () => {
    // The negative control's twin. `rejects claim records whose map key differs
    // from claimKey` asserts success === false — which a record missing ANY
    // required field also satisfies, so on its own it cannot tell "rejected for
    // the key mismatch" from "rejected because the fixture rotted". This case is
    // the discriminator: identical shape, key mismatch removed, MUST parse. If a
    // required field goes missing from the fixture, THIS case goes red and names
    // the real cause. Do not delete it to "reduce duplication" — the duplication
    // is the mechanism (#519).
    const result = SessionDataSchema.safeParse({
      defaultStack: [PARENT_RUN_ID],
      claims: {
        rdclk_11111111111111111111111111111111: {
          claimKey: 'rdclk_11111111111111111111111111111111', // matches the map key
          secretHash: `sha256:${'a'.repeat(64)}`,
          controlledRunId: CHILD_RUN_ID,
          grants: [{ action: 'mutate-run', runId: CHILD_RUN_ID }],
          issuedAt: '2026-05-01T00:00:00.000Z',
          updatedAt: '2026-05-01T00:00:01.000Z',
          lastSeenAt: '2026-05-01T00:00:01.000Z',
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects two claim records controlling the same run', () => {
    // Minting guarantees at most one claim per run (issueRunControlClaim runs
    // once per run; claimRunbook dedupes on controlledRunId). Two distinct bearer
    // secrets sharing a controlledRunId can only arise from tampered persisted
    // state, so the schema is the boundary that rejects it.
    const record = (claimKey: string) => ({
      claimKey,
      secretHash: `sha256:${'a'.repeat(64)}`,
      controlledRunId: CHILD_RUN_ID,
      grants: [{ action: 'mutate-run', runId: CHILD_RUN_ID }],
      issuedAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:01.000Z',
      lastSeenAt: '2026-05-01T00:00:01.000Z',
    });
    const result = SessionDataSchema.safeParse({
      defaultStack: [PARENT_RUN_ID],
      claims: {
        rdclk_11111111111111111111111111111111: record('rdclk_11111111111111111111111111111111'),
        rdclk_22222222222222222222222222222222: record('rdclk_22222222222222222222222222222222'),
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts two claim records controlling DIFFERENT runs (positive control)', () => {
    // Twin of `rejects two claim records controlling the same run`, for the same
    // reason: proves that rejection is caused by the shared controlledRunId and
    // not by a fixture that quietly stopped being a valid claim record.
    const record = (claimKey: string, runId: string) => ({
      claimKey,
      secretHash: `sha256:${'a'.repeat(64)}`,
      controlledRunId: runId,
      grants: [{ action: 'mutate-run', runId }],
      issuedAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:01.000Z',
      lastSeenAt: '2026-05-01T00:00:01.000Z',
    });
    const result = SessionDataSchema.safeParse({
      defaultStack: [PARENT_RUN_ID],
      claims: {
        rdclk_11111111111111111111111111111111: record(
          'rdclk_11111111111111111111111111111111',
          CHILD_RUN_ID,
        ),
        rdclk_22222222222222222222222222222222: record(
          'rdclk_22222222222222222222222222222222',
          OTHER_CHILD_RUN_ID,
        ),
      },
    });
    expect(result.success).toBe(true);
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
        childRunbookRef: { source: 'project', path: 'child.md' },
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
      childRunbookRef: { source: 'project', path: 'child.md' },
      contextSnapshot: {
        vars: { env: 'prod' },
        ancestors: [
          {
            runId: PARENT_RUN_ID,
            runbook: 'parent.md',
            step: '1',
            substep: '2',
            vars: { key: 'value' },
          },
        ],
      },
      childRunId: CHILD_RUN_ID,
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
      expect(ss?.delegation?.childRunId).toBe(CHILD_RUN_ID);
    }
  });
});

describe('RunbookStateSchema round-trip with inline child metadata', () => {
  const validContextSnapshot = {
    vars: { env: 'prod' },
    ancestors: [],
    step: '1',
    substep: '1',
    at: '1.1',
  };

  const validInline = {
    childRunbookPath: 'runbooks/child.runbook.md',
    childRunbookRef: { source: 'project', path: 'runbooks/child.runbook.md' },
    contextSnapshot: validContextSnapshot,
    childRunId: 'rd_11111111111111111111111111111111',
    createdAt: '2026-05-30T00:00:00.000Z',
    startedAt: null,
  };

  it('preserves inline child metadata through parse', () => {
    const result = RunbookStateSchema.safeParse(
      createMinimalRunbookState({
        substepStates: [
          {
            id: '1',
            frameKey: buildFrameKey('2'),
            status: 'running',
            inline: validInline,
          },
        ],
      }),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.substepStates?.[0]?.inline?.childRunId).toBe(validInline.childRunId);
    }
  });

  it('rejects inline child metadata with invalid childRunId', () => {
    const result = RunbookStateSchema.safeParse(
      createMinimalRunbookState({
        substepStates: [
          {
            id: '1',
            frameKey: buildFrameKey('2'),
            status: 'running',
            inline: {
              ...validInline,
              childRunId: null,
            },
          },
        ],
      }),
    );

    expect(result.success).toBe(false);
  });

  it('path-validates JsonArrayStream values nested under inline context vars', () => {
    const projectRoot = '/tmp/rd-inline-project';
    const result = makeRunbookStateSchema(projectRoot).safeParse(
      createMinimalRunbookState({
        substepStates: [
          {
            id: '1',
            frameKey: buildFrameKey('2'),
            status: 'running',
            inline: {
              ...validInline,
              contextSnapshot: {
                ...validContextSnapshot,
                vars: {
                  items: {
                    kind: 'json-array-stream',
                    path: '/tmp/rd-outside/data.jsonl',
                  },
                },
              },
            },
          },
        ],
      }),
    );

    expect(result.success).toBe(false);
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

  const CLAIM_KEY = 'rdclk_11111111111111111111111111111111';

  it('validates a claimed entry with childRunId and claimKey', () => {
    const entry = {
      substep: '1.1',
      runbook: 'child.md',
      state: 'claimed',
      childRunId: 'run_abc123',
      claimKey: CLAIM_KEY,
      tokenHash: TOKEN_HASH,
    };
    expect(() => DelegationStatusEntrySchema.parse(entry)).not.toThrow();
  });

  it('rejects a claimed entry missing claimKey', () => {
    const entry = {
      substep: '1.1',
      runbook: 'child.md',
      state: 'claimed',
      childRunId: 'run_abc123',
      tokenHash: TOKEN_HASH,
    };
    expect(() => DelegationStatusEntrySchema.parse(entry)).toThrow();
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
          claimKey: 'rdclk_22222222222222222222222222222222',
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

  it('accepts delegation parentLinkage with full parent frame identity', () => {
    const status = {
      kind: 'status',
      active: true,
      stashed: false,
      parentLinkage: {
        kind: 'delegation',
        tokenHash: TOKEN_HASH_A,
        parentRunId: PARENT_RUN_ID,
        parentStepId: '1.1',
        parentStep: '1',
        parentFrameKey: '1|',
        parentEntry: 1,
      },
    };

    expect(() => StatusResponseSchema.parse(status)).not.toThrow();
  });

  it('accepts inline parentLinkage with full parent frame identity', () => {
    const status = {
      kind: 'status',
      active: true,
      stashed: false,
      parentLinkage: {
        kind: 'inline',
        parentRunId: PARENT_RUN_ID,
        parentStepId: '1.1',
        parentStep: '1',
        parentFrameKey: '1|',
        parentEntry: 1,
      },
    };

    expect(() => StatusResponseSchema.parse(status)).not.toThrow();
  });

  it.each([
    'parentStep',
    'parentFrameKey',
    'parentEntry',
  ])('rejects delegation parentLinkage missing %s', (field) => {
    const parentLinkage: Record<string, unknown> = {
      kind: 'delegation',
      tokenHash: TOKEN_HASH_A,
      parentRunId: PARENT_RUN_ID,
      parentStepId: '1.1',
      parentStep: '1',
      parentFrameKey: '1|',
      parentEntry: 1,
    };
    delete parentLinkage[field];

    const status = { kind: 'status', active: true, stashed: false, parentLinkage };

    expect(() => StatusResponseSchema.parse(status)).toThrow();
  });

  it.each([
    'parentStep',
    'parentFrameKey',
    'parentEntry',
  ])('rejects inline parentLinkage missing %s', (field) => {
    const parentLinkage: Record<string, unknown> = {
      kind: 'inline',
      parentRunId: PARENT_RUN_ID,
      parentStepId: '1.1',
      parentStep: '1',
      parentFrameKey: '1|',
      parentEntry: 1,
    };
    delete parentLinkage[field];

    const status = { kind: 'status', active: true, stashed: false, parentLinkage };

    expect(() => StatusResponseSchema.parse(status)).toThrow();
  });
});

/** Helper to create a minimal valid RunbookState for schema testing. */
function createMinimalRunbookState(overrides: Record<string, unknown> = {}) {
  return {
    id: PARENT_RUN_ID,
    runbook: { source: 'project', path: 'test.md' },
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
