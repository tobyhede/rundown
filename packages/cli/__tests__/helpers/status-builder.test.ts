import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { mockErrorHelpers } from './mock-error-helpers.js';
import {
  brandDelegationTokenHashForTest,
  brandFrameKeyForTest,
  brandInitialTemplateVarsForTest,
  brandRunIdForTest,
  brandStoredOutputsForTest,
  brandTrustedArtifactArrayForTest,
  brandTrustedArtifactRecordForTest,
} from './brand-helpers.js';
import { mockFn } from './typed-mocks.js';

import type * as CoreModule from '@rundown-org/core';
import type { BaseStep, ResolvedStep } from '@rundown-org/parser';
import type * as ExecutionModule from '../../src/services/execution.js';

const PARENT_RUN_ID = brandRunIdForTest(`rd_${'9'.repeat(32)}`);
const SECOND_PARENT_RUN_ID = brandRunIdForTest(`rd_${'a'.repeat(32)}`);
const DEFAULT_RUN_ID = brandRunIdForTest(`rd_${'b'.repeat(32)}`);
const ARTIFACT_RUN_ID = brandRunIdForTest(`rd_${'c'.repeat(32)}`);

// Mock @rundown-org/core
jest.unstable_mockModule('@rundown-org/core', () => {
  const countNumberedSteps = mockFn<typeof CoreModule.countNumberedSteps>();
  countNumberedSteps.mockReturnValue(5);
  return {
    stepIdToString: jest.fn((id: { step: string; substep?: string }) =>
      id.substep ? `${id.step}.${id.substep}` : id.step,
    ),
    buildStepPosition: jest.fn((current: string, total: number, substep?: string) => ({
      current,
      total,
      ...(substep ? { substep } : {}),
    })),
    deriveExecutionAt: jest.fn(
      (step: string, substep?: string, iteration?: number) =>
        `${step}${iteration != null ? `.${String(iteration)}` : ''}${substep ? `.${substep}` : ''}`,
    ),
    countNumberedSteps,
    isArtifactRecord: jest.fn(
      (value: unknown) =>
        value !== null &&
        typeof value === 'object' &&
        'kind' in value &&
        ((value as { kind?: unknown }).kind === 'artifact-record' ||
          (value as { kind?: unknown }).kind === 'file-artifact-record'),
    ),
    isArtifactValue: jest.fn((value: unknown) => {
      const isRecord = (candidate: unknown): boolean =>
        candidate !== null &&
        typeof candidate === 'object' &&
        'kind' in candidate &&
        ((candidate as { kind?: unknown }).kind === 'artifact-record' ||
          (candidate as { kind?: unknown }).kind === 'file-artifact-record');
      return (
        isRecord(value) ||
        (Array.isArray(value) && value.length > 0 && value.every((item) => isRecord(item)))
      );
    }),
    WORK_DIR: '.rundown/work',
    renderArtifactValue: jest.fn((value: unknown, options?: { cwd: string; workPath: string }) => {
      const renderOne = (record: {
        key: string;
        kind: string;
        contextId?: string;
        runId?: string;
      }) =>
        record.kind === 'file-artifact-record'
          ? '/tmp/project/schemas/review.schema.json'
          : `${options?.cwd ?? '/test'}/${options?.workPath ?? '.rundown/work'}/.rd-${String(
              record.contextId,
            )}/${String(record.runId)}/${record.key}`;
      if (Array.isArray(value)) {
        return JSON.stringify(value.map(renderOne));
      }
      return renderOne(value as { key: string; kind: string });
    }),
    toPublicArtifactVarValue: jest.fn(
      (value: unknown, options: { cwd: string; workPath: string }) => {
        const renderOne = (record: Record<string, unknown>) => ({
          ...record,
          path:
            record.kind === 'file-artifact-record'
              ? '/tmp/project/schemas/review.schema.json'
              : `${options.cwd}/${options.workPath}/.rd-${String(record.contextId)}/${String(
                  record.runId,
                )}/${String(record.key)}`,
        });
        return Array.isArray(value)
          ? value.map(renderOne)
          : renderOne(value as Record<string, unknown>);
      },
    ),
    mergeEffectiveVars: jest.fn(
      (
        state: { templateVars?: Record<string, unknown>; variables?: Record<string, unknown> },
        extraVars?: Record<string, unknown>,
      ) => ({
        ...(state.templateVars ?? {}),
        ...(state.variables ?? {}),
        ...(extraVars ?? {}),
      }),
    ),
    ...mockErrorHelpers,
  };
});

import type { RunbookState } from '@rundown-org/core';

// Mock runbook-loader
jest.unstable_mockModule('../../src/helpers/runbook-loader', () => ({
  getRunbookFromState: mockFn<(state: RunbookState, cwd: string) => readonly ResolvedStep[]>(),
}));

// Mock execution service
jest.unstable_mockModule('../../src/services/execution', () => {
  const getStepRetryMax = mockFn<typeof ExecutionModule.getStepRetryMax>();
  getStepRetryMax.mockReturnValue(0);
  const formatActionForDisplay = mockFn<typeof ExecutionModule.formatActionForDisplay>();
  formatActionForDisplay.mockReturnValue('CONTINUE');
  const extractRetryDisplayCount = mockFn<typeof ExecutionModule.extractRetryDisplayCount>();
  extractRetryDisplayCount.mockImplementation((_, retryCount) => retryCount);
  return {
    getStepRetryMax,
    buildMetadata:
      mockFn<(state: RunbookState) => { file?: string; runbookId?: string; prompted?: boolean }>(),
    formatActionForDisplay,
    extractRetryDisplayCount,
  };
});

// Import after mocking
const core = await import('@rundown-org/core');
const { getRunbookFromState } = await import('../../src/helpers/runbook-loader.js');
const { getStepRetryMax, buildMetadata, formatActionForDisplay } = await import(
  '../../src/services/execution.js'
);
const { buildInactiveStatus, buildStashedStatus, buildActiveStatus } = await import(
  '../../src/helpers/status-builder.js'
);

function makeState(overrides: Partial<RunbookState> = {}): RunbookState {
  const baseState: RunbookState = {
    id: DEFAULT_RUN_ID,
    runbook: { source: 'project', path: 'test.runbook.md' },
    runbookPath: 'test.runbook.md',
    step: '1',
    stepName: 'First Step',
    retryCount: 0,
    variables: brandStoredOutputsForTest(),
    steps: [],
    startedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
  return { ...baseState, ...overrides };
}

function makeStep(overrides: Partial<Omit<BaseStep, 'kind'>> = {}): ResolvedStep {
  const baseStep: BaseStep = {
    kind: 'base',
    name: '1',
    description: 'First Step',
    transitions: {
      pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
      fail: { kind: 'fail', retry: 0, action: { type: 'CONTINUE' } },
    },
  };
  return { ...baseStep, ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('buildInactiveStatus', () => {
  it('returns inactive with no stash', () => {
    const result = buildInactiveStatus();
    expect(result).toEqual({ active: false, stashed: false });
  });
});

describe('buildStashedStatus', () => {
  it('returns stashed status with position', () => {
    const state = makeState({ step: '2', substep: undefined });
    const steps = [makeStep({ name: '1' }), makeStep({ name: '2' })];

    jest.mocked(getRunbookFromState).mockReturnValue(steps);
    jest.mocked(buildMetadata).mockReturnValue({
      file: 'test.runbook.md',
      runbookId: 'test-id',
    });
    jest.mocked(core.countNumberedSteps).mockReturnValue(2);

    const result = buildStashedStatus(state, '/test');

    expect(result.active).toBe(false);
    expect(result.stashed).toBe(true);
    expect(result.file).toBe('test.runbook.md');
    expect(result.position).toEqual({ current: '2', total: 2 });
  });

  it('includes substep in position when present', () => {
    const state = makeState({ step: '2', substep: '1' });
    const steps = [makeStep({ name: '1' }), makeStep({ name: '2' })];

    jest.mocked(getRunbookFromState).mockReturnValue(steps);
    jest.mocked(buildMetadata).mockReturnValue({
      file: 'test.runbook.md',
      runbookId: 'test-id',
    });
    jest.mocked(core.countNumberedSteps).mockReturnValue(2);

    const result = buildStashedStatus(state, '/test');

    expect(result.position).toEqual({ current: '2', total: 2, substep: '1' });
  });

  it('includes prompted when true', () => {
    const state = makeState({ prompted: true });
    const steps = [makeStep()];

    jest.mocked(getRunbookFromState).mockReturnValue(steps);
    jest.mocked(buildMetadata).mockReturnValue({
      file: 'test.runbook.md',
      runbookId: 'test-id',
      prompted: true,
    });
    jest.mocked(core.countNumberedSteps).mockReturnValue(1);

    const result = buildStashedStatus(state, '/test');

    expect(result.prompted).toBe(true);
  });
});

describe('buildActiveStatus', () => {
  it('returns active status with step details', () => {
    const state = makeState({ step: '1' });
    const steps = [makeStep({ name: '1', description: 'First Step' })];

    jest.mocked(getRunbookFromState).mockReturnValue(steps);
    jest.mocked(buildMetadata).mockReturnValue({
      file: 'test.runbook.md',
      runbookId: 'test-id',
    });
    jest.mocked(core.countNumberedSteps).mockReturnValue(1);

    const result = buildActiveStatus(state, '/test');

    expect(result.active).toBe(true);
    expect(result.stashed).toBe(false);
    expect(result.step).toEqual({ name: '1', description: 'First Step' });
    expect(result.position).toEqual({ current: '1', total: 1 });
  });

  it('sets stashed flag when stashedId provided', () => {
    const state = makeState();
    const steps = [makeStep()];

    jest.mocked(getRunbookFromState).mockReturnValue(steps);
    jest.mocked(buildMetadata).mockReturnValue({
      file: 'test.runbook.md',
      runbookId: 'test-id',
    });
    jest.mocked(core.countNumberedSteps).mockReturnValue(1);

    const result = buildActiveStatus(state, '/test', 'stashed-id');

    expect(result.stashed).toBe(true);
  });

  it('includes lastAction when present', () => {
    const state = makeState({
      lastAction: { type: 'RETRY', origin: 'direct' },
      retryCount: 1,
      lastResult: 'fail',
    });
    const steps = [makeStep({ name: '1' })];

    jest.mocked(getRunbookFromState).mockReturnValue(steps);
    jest.mocked(buildMetadata).mockReturnValue({
      file: 'test.runbook.md',
      runbookId: 'test-id',
    });
    jest.mocked(core.countNumberedSteps).mockReturnValue(1);
    jest.mocked(getStepRetryMax).mockReturnValue(3);
    jest.mocked(formatActionForDisplay).mockReturnValue('RETRY (1/3)');

    const result = buildActiveStatus(state, '/test');

    expect(result.lastAction).toEqual({ action: 'RETRY (1/3)', result: 'FAIL' });
    expect(formatActionForDisplay).toHaveBeenCalledWith({ type: 'RETRY', origin: 'direct' }, 1, 3);
  });

  it('maps lastResult pass to result true', () => {
    const state = makeState({
      lastAction: { type: 'CONTINUE', origin: 'direct' },
      retryCount: 0,
      lastResult: 'pass',
    });
    const steps = [makeStep({ name: '1' })];

    jest.mocked(getRunbookFromState).mockReturnValue(steps);
    jest.mocked(buildMetadata).mockReturnValue({
      file: 'test.runbook.md',
      runbookId: 'test-id',
    });
    jest.mocked(core.countNumberedSteps).mockReturnValue(1);
    jest.mocked(getStepRetryMax).mockReturnValue(0);
    jest.mocked(formatActionForDisplay).mockReturnValue('CONTINUE');

    const result = buildActiveStatus(state, '/test');

    expect(result.lastAction).toEqual({ action: 'CONTINUE', result: 'PASS' });
  });

  it('omits step when currentStep not found', () => {
    const state = makeState({ step: 'nonexistent' });
    const steps = [makeStep({ name: '1' })];

    jest.mocked(getRunbookFromState).mockReturnValue(steps);
    jest.mocked(buildMetadata).mockReturnValue({
      file: 'test.runbook.md',
      runbookId: 'test-id',
    });
    jest.mocked(core.countNumberedSteps).mockReturnValue(1);

    const result = buildActiveStatus(state, '/test');

    expect(result.step).toBeUndefined();
  });
});

describe('claimKey join (#531)', () => {
  const CHILD_RUN_ID = brandRunIdForTest(`rd_${'a'.repeat(32)}`);
  const CLAIM_ID = 'rdclm_AAAAAAAAAAAAAAAAAAAAAA';

  beforeEach(() => {
    jest.mocked(getRunbookFromState).mockReturnValue([makeStep({ name: '1' })]);
    jest.mocked(buildMetadata).mockReturnValue({
      file: 'test.runbook.md',
      runbookId: 'test-id',
    });
    jest.mocked(core.countNumberedSteps).mockReturnValue(1);
  });

  function makeStateWithClaimedDelegation(
    overrides: {
      childRunId?: string | null;
      cancelledAt?: string | null;
      token?: string | null;
    } = {},
  ): RunbookState {
    // contextSnapshot.vars is branded (EffectiveVars) — hand-rolled fixture
    // records need the cast; the builder never reads contextSnapshot.
    const delegation = {
      token: overrides.token === null ? undefined : (overrides.token ?? `rdtk_${'A'.repeat(32)}`),
      tokenHash: brandDelegationTokenHashForTest(`sha256:${'a'.repeat(64)}`),
      childRunbookPath: 'child.md',
      childRunbookRef: { source: 'project', path: 'child.md' },
      childRunId: overrides.childRunId != null ? brandRunIdForTest(overrides.childRunId) : null,
      cancelledAt: overrides.cancelledAt ?? null,
      contextSnapshot: { vars: {}, ancestors: [] },
      createdAt: '2026-07-03T00:00:00.000Z',
    } as unknown as CoreModule.StepDelegation;
    const substepStates: CoreModule.SubstepState[] = [
      {
        id: '1',
        frameKey: brandFrameKeyForTest('1|'),
        status: 'running',
        delegation,
      },
      // Non-delegation substep: must never surface as a delegations entry.
      {
        id: '2',
        frameKey: brandFrameKeyForTest('1|'),
        status: 'pending',
      },
    ];
    return makeState({ substepStates });
  }

  it('joins claimKey onto claimed delegations from the session claim map', () => {
    const state = makeStateWithClaimedDelegation({ childRunId: CHILD_RUN_ID });

    const result = buildActiveStatus(state, '/test', undefined, undefined, {
      claimKeyByChildRunId: new Map([[CHILD_RUN_ID, CLAIM_ID]]),
    });

    // Exactly one entry: the non-delegation substep never surfaces.
    expect(result.delegations).toHaveLength(1);
    expect(result.delegations?.[0]).toMatchObject({
      state: 'claimed',
      childRunId: CHILD_RUN_ID,
      claimKey: CLAIM_ID,
    });
    // A claimed delegation never exposes its raw token.
    expect(result.delegations?.[0]).not.toHaveProperty('token');
  });

  it('never attaches claimKey to a pending delegation even with stray map entries', () => {
    const state = makeStateWithClaimedDelegation({ childRunId: null });

    const result = buildActiveStatus(state, '/test', undefined, undefined, {
      claimKeyByChildRunId: new Map([
        [CHILD_RUN_ID, CLAIM_ID],
        [`rd_${'b'.repeat(32)}`, 'rdclm_strayAAAAAAAAAAAAAAAA'],
      ]),
    });

    const entry = result.delegations?.[0];
    // Pending entries surface the raw token (claim recovery) but never a
    // childRunId or claimKey key.
    expect(entry).toMatchObject({ state: 'pending', token: `rdtk_${'A'.repeat(32)}` });
    expect(entry).not.toHaveProperty('childRunId');
    expect(entry).not.toHaveProperty('claimKey');
  });

  it('excludes delegations from other frames when an active frame is set', () => {
    const state = makeStateWithClaimedDelegation({ childRunId: CHILD_RUN_ID });
    const scoped = { ...state, activeFrameKey: brandFrameKeyForTest('9|'), activeEntry: 1 };

    const result = buildActiveStatus(scoped, '/test', undefined, undefined, {
      claimKeyByChildRunId: new Map([[CHILD_RUN_ID, CLAIM_ID]]),
    });

    // The fixture's delegation is scoped to frame '1|'; the active frame '9|'
    // filters it out.
    expect(result.delegations).toBeUndefined();
  });

  it('includes delegations whose frame matches the active frame', () => {
    const state = makeStateWithClaimedDelegation({ childRunId: CHILD_RUN_ID });
    const scoped = { ...state, activeFrameKey: brandFrameKeyForTest('1|'), activeEntry: 1 };

    const result = buildActiveStatus(scoped, '/test', undefined, undefined, {
      claimKeyByChildRunId: new Map([[CHILD_RUN_ID, CLAIM_ID]]),
    });

    expect(result.delegations).toHaveLength(1);
    expect(result.delegations?.[0]).toMatchObject({ state: 'claimed', claimKey: CLAIM_ID });
  });

  it('never resurfaces the token on a cancelled-before-claim delegation', () => {
    const state = makeStateWithClaimedDelegation({
      childRunId: null,
      cancelledAt: '2026-07-03T00:00:00.000Z',
    });

    const result = buildActiveStatus(state, '/test');

    const entry = result.delegations?.[0];
    expect(entry).toMatchObject({ state: 'cancelled' });
    expect(entry).not.toHaveProperty('token');
  });

  it('omits the token key on a pending delegation whose token is gone', () => {
    const state = makeStateWithClaimedDelegation({ childRunId: null, token: null });

    const result = buildActiveStatus(state, '/test');

    const entry = result.delegations?.[0];
    expect(entry).toMatchObject({ state: 'pending' });
    expect(entry).not.toHaveProperty('token');
  });

  it('omits claimKey when the map has no matching entry', () => {
    const state = makeStateWithClaimedDelegation({ childRunId: CHILD_RUN_ID });

    const result = buildActiveStatus(state, '/test', undefined, undefined, {
      claimKeyByChildRunId: new Map(),
    });

    const entry = result.delegations?.[0];
    expect(entry).toMatchObject({ state: 'claimed', childRunId: CHILD_RUN_ID });
    expect(entry).not.toHaveProperty('claimKey');
  });

  it('keeps the current shape when the options argument is omitted', () => {
    const state = makeStateWithClaimedDelegation({ childRunId: CHILD_RUN_ID });

    const result = buildActiveStatus(state, '/test');

    const entry = result.delegations?.[0];
    expect(entry).toMatchObject({ state: 'claimed', childRunId: CHILD_RUN_ID });
    expect(entry).not.toHaveProperty('claimKey');
  });

  it('never attaches claimKey to a cancelled-after-claim delegation', () => {
    // Cancelled-after-claim: childRunId stays set while cancelledAt is stamped
    // (abortDelegation --force), so the computed entry state is 'cancelled'
    // even though the claim map has a matching entry (e.g. a window before
    // child teardown releases the claim record).
    const state = makeStateWithClaimedDelegation({
      childRunId: CHILD_RUN_ID,
      cancelledAt: '2026-07-03T00:00:00.000Z',
    });

    const result = buildActiveStatus(state, '/test', undefined, undefined, {
      claimKeyByChildRunId: new Map([[CHILD_RUN_ID, CLAIM_ID]]),
    });

    const entry = result.delegations?.[0];
    expect(entry).toMatchObject({ state: 'cancelled', childRunId: CHILD_RUN_ID });
    expect(entry).not.toHaveProperty('claimKey');
    // A cancelled delegation never resurfaces its raw token.
    expect(entry).not.toHaveProperty('token');
  });
});

describe('parentLinkage projection', () => {
  beforeEach(() => {
    const steps = [makeStep({ name: '1', description: 'First Step' })];
    jest.mocked(getRunbookFromState).mockReturnValue(steps);
    jest.mocked(buildMetadata).mockReturnValue({
      file: 'test.runbook.md',
      runbookId: 'test-id',
    });
    jest.mocked(core.countNumberedSteps).mockReturnValue(1);
  });

  it('surfaces delegation linkage with tokenHash in active status', () => {
    const state = makeState({
      parentLinkage: {
        kind: 'delegation',
        tokenHash: brandDelegationTokenHashForTest(
          'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        ),
        parentRunId: PARENT_RUN_ID,
        parentStepId: '1.1',
        parentStep: '1',
        parentFrameKey: brandFrameKeyForTest('1'),
        parentEntry: 1,
      },
    });

    const result = buildActiveStatus(state, '/test');

    expect(result.parentLinkage).toEqual({
      kind: 'delegation',
      tokenHash: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      parentRunId: PARENT_RUN_ID,
      parentStepId: '1.1',
      parentStep: '1',
      parentFrameKey: brandFrameKeyForTest('1'),
      parentEntry: 1,
    });
  });

  it('surfaces inline linkage without tokenHash in active status', () => {
    const state = makeState({
      parentLinkage: {
        kind: 'inline',
        parentRunId: PARENT_RUN_ID,
        parentStepId: '1.1',
        parentStep: '1',
        parentFrameKey: brandFrameKeyForTest('1'),
        parentEntry: 1,
      },
    });

    const result = buildActiveStatus(state, '/test');

    expect(result.parentLinkage).toEqual({
      kind: 'inline',
      parentRunId: PARENT_RUN_ID,
      parentStepId: '1.1',
      parentStep: '1',
      parentFrameKey: brandFrameKeyForTest('1'),
      parentEntry: 1,
    });
    expect(result.parentLinkage).not.toHaveProperty('tokenHash');
  });

  it('omits parentLinkage when state has none', () => {
    const state = makeState();

    const result = buildActiveStatus(state, '/test');

    expect(result.parentLinkage).toBeUndefined();
  });

  it('surfaces parentLinkage in stashed status and redacts vars for caller-scoped child', () => {
    const state = makeState({
      parentLinkage: {
        kind: 'delegation',
        tokenHash: brandDelegationTokenHashForTest(
          'sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
        ),
        parentRunId: SECOND_PARENT_RUN_ID,
        parentStepId: '2.1',
        parentStep: '2',
        parentFrameKey: brandFrameKeyForTest('2'),
        parentEntry: 1,
      },
      templateVars: brandInitialTemplateVarsForTest({ secret: 'inherited-from-parent' }),
      variables: brandStoredOutputsForTest({
        output_value: 'child-output',
        PlanPath: brandTrustedArtifactRecordForTest({
          kind: 'artifact-record',
          uri: `rd://artifacts/ctx-a/${ARTIFACT_RUN_ID}/plan.json`,
          runId: ARTIFACT_RUN_ID,
          contextId: 'ctx-a',
          runbook: { source: 'project', path: 'producer.runbook.md' },
          key: 'plan.json',
          timestamp: '2026-05-25T00:00:00.000Z',
        }),
      }),
    });

    const result = buildStashedStatus(state, '/test');

    expect(result.parentLinkage).toEqual({
      kind: 'delegation',
      tokenHash: 'sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
      parentRunId: SECOND_PARENT_RUN_ID,
      parentStepId: '2.1',
      parentStep: '2',
      parentFrameKey: brandFrameKeyForTest('2'),
      parentEntry: 1,
    });
    // Caller-scoped (parentLinkage set) → vars and artifacts must be redacted from stashed status.
    expect(result.vars).toBeUndefined();
    expect(result.artifacts).toBeUndefined();
  });

  it('surfaces vars in stashed status when no parentLinkage is set', () => {
    const state = makeState({
      templateVars: brandInitialTemplateVarsForTest({ visible: 'value' }),
      variables: brandStoredOutputsForTest(),
    });

    const result = buildStashedStatus(state, '/test');

    expect(result.parentLinkage).toBeUndefined();
    expect(result.vars).toEqual(expect.objectContaining({ visible: 'value' }));
  });
});

describe('vars field', () => {
  beforeEach(() => {
    jest.mocked(getRunbookFromState).mockReturnValue([]);
    jest.mocked(core.countNumberedSteps).mockReturnValue(0);
    jest.mocked(buildMetadata).mockReturnValue({
      file: 'test.runbook.md',
      runbookId: 'test-id',
    });
    jest.mocked(getStepRetryMax).mockReturnValue(0);
    jest.mocked(formatActionForDisplay).mockReturnValue('CONTINUE');
  });

  it('merges templateVars (scalars) and state.variables, state.variables wins on collision', () => {
    const state = makeState({
      templateVars: brandInitialTemplateVarsForTest({ environment: 'staging', port: 3000 }),
      variables: brandStoredOutputsForTest({
        environment: 'production',
        PlanPath: '/work/plan.json',
      }),
    });
    const result = buildActiveStatus(state, '/project');
    expect(result.vars).toEqual({
      environment: 'production',
      port: '3000',
      PlanPath: '/work/plan.json',
    });
  });

  it('excludes non-scalar templateVars (arrays, objects)', () => {
    const state = makeState({
      templateVars: brandInitialTemplateVarsForTest({
        // `kind`-shaped sentinel masquerades as a JsonObject; runtime
        // filter drops it from the rendered vars map.
        items: { kind: 'json-array', value: ['a', 'b'] },
        name: 'test',
      }),
      variables: brandStoredOutputsForTest(),
    });
    const result = buildActiveStatus(state, '/project');
    expect(result.vars).toEqual({ name: 'test' });
    expect(result.vars?.items).toBeUndefined();
  });

  it('renders artifact-record variables as paths and exposes structured projections', () => {
    const artifact = brandTrustedArtifactRecordForTest({
      kind: 'artifact-record',
      uri: `rd://artifacts/ctx-a/${ARTIFACT_RUN_ID}/plan.json`,
      runId: ARTIFACT_RUN_ID,
      contextId: 'ctx-a',
      runbook: { source: 'project', path: 'producer.runbook.md' },
      key: 'plan.json',
      timestamp: '2026-05-25T00:00:00.000Z',
    });
    const state = makeState({
      variables: brandStoredOutputsForTest({ PlanPath: artifact }),
    });

    const result = buildActiveStatus(state, '/project');

    expect(result.vars).toEqual({
      PlanPath: `/project/.rundown/work/.rd-ctx-a/${ARTIFACT_RUN_ID}/plan.json`,
    });
    expect(result.artifacts).toEqual({
      PlanPath: expect.objectContaining({
        kind: 'artifact-record',
        uri: `rd://artifacts/ctx-a/${ARTIFACT_RUN_ID}/plan.json`,
        path: `/project/.rundown/work/.rd-ctx-a/${ARTIFACT_RUN_ID}/plan.json`,
      }),
    });
  });

  it('renders artifact path using record contextId and runId, not hardcoded values', () => {
    const otherRunId = brandRunIdForTest(`rd_${'d'.repeat(32)}`);
    const artifact = brandTrustedArtifactRecordForTest({
      kind: 'artifact-record',
      uri: `rd://artifacts/ctx-b/${otherRunId}/output.json`,
      runId: otherRunId,
      contextId: 'ctx-b',
      runbook: { source: 'project', path: 'other.runbook.md' },
      key: 'output.json',
      timestamp: '2026-05-25T00:00:00.000Z',
    });
    const state = makeState({
      variables: brandStoredOutputsForTest({ OutputPath: artifact }),
    });

    const result = buildActiveStatus(state, '/project');

    expect(result.vars?.OutputPath).toBe(
      `/project/.rundown/work/.rd-ctx-b/${otherRunId}/output.json`,
    );
    expect(result.vars?.OutputPath).not.toContain('ctx-a');
    expect(result.vars?.OutputPath).not.toContain(String(ARTIFACT_RUN_ID));
  });

  it('renders artifact paths for two records from different contexts independently', () => {
    const runIdA = brandRunIdForTest(`rd_${'e'.repeat(32)}`);
    const runIdB = brandRunIdForTest(`rd_${'f'.repeat(32)}`);
    const artifactA = brandTrustedArtifactRecordForTest({
      kind: 'artifact-record',
      uri: `rd://artifacts/ctx-x/${runIdA}/a.json`,
      runId: runIdA,
      contextId: 'ctx-x',
      runbook: { source: 'project', path: 'a.runbook.md' },
      key: 'a.json',
      timestamp: '2026-05-25T00:00:00.000Z',
    });
    const artifactB = brandTrustedArtifactRecordForTest({
      kind: 'artifact-record',
      uri: `rd://artifacts/ctx-y/${runIdB}/b.json`,
      runId: runIdB,
      contextId: 'ctx-y',
      runbook: { source: 'project', path: 'b.runbook.md' },
      key: 'b.json',
      timestamp: '2026-05-25T00:00:00.000Z',
    });
    const state = makeState({
      variables: brandStoredOutputsForTest({ ArtA: artifactA, ArtB: artifactB }),
    });

    const result = buildActiveStatus(state, '/project');

    expect(result.vars?.ArtA).toContain('ctx-x');
    expect(result.vars?.ArtA).toContain(runIdA);
    expect(result.vars?.ArtB).toContain('ctx-y');
    expect(result.vars?.ArtB).toContain(runIdB);
    // Ensure cross-contamination does not occur
    expect(result.vars?.ArtA).not.toContain('ctx-y');
    expect(result.vars?.ArtB).not.toContain('ctx-x');
  });

  it('renders artifact-record arrays as JSON path arrays and exposes structured projections', () => {
    const first = brandTrustedArtifactRecordForTest({
      kind: 'artifact-record',
      uri: `rd://artifacts/ctx-a/${ARTIFACT_RUN_ID}/plan-a.json`,
      runId: ARTIFACT_RUN_ID,
      contextId: 'ctx-a',
      runbook: { source: 'project', path: 'producer.runbook.md' },
      key: 'plan-a.json',
      timestamp: '2026-05-25T00:00:00.000Z',
    });
    const second = brandTrustedArtifactRecordForTest({
      kind: 'artifact-record',
      uri: `rd://artifacts/ctx-a/${ARTIFACT_RUN_ID}/plan-b.json`,
      runId: ARTIFACT_RUN_ID,
      contextId: 'ctx-a',
      runbook: { source: 'project', path: 'producer.runbook.md' },
      key: 'plan-b.json',
      timestamp: '2026-05-25T00:00:00.000Z',
    });
    const state = makeState({
      variables: brandStoredOutputsForTest({
        Plans: brandTrustedArtifactArrayForTest([first, second]),
      }),
    });

    const result = buildActiveStatus(state, '/project');

    expect(result.vars).toEqual({
      Plans: JSON.stringify([
        `/project/.rundown/work/.rd-ctx-a/${ARTIFACT_RUN_ID}/plan-a.json`,
        `/project/.rundown/work/.rd-ctx-a/${ARTIFACT_RUN_ID}/plan-b.json`,
      ]),
    });
    expect(result.artifacts?.Plans).toEqual([
      expect.objectContaining({
        uri: `rd://artifacts/ctx-a/${ARTIFACT_RUN_ID}/plan-a.json`,
        path: `/project/.rundown/work/.rd-ctx-a/${ARTIFACT_RUN_ID}/plan-a.json`,
      }),
      expect.objectContaining({
        uri: `rd://artifacts/ctx-a/${ARTIFACT_RUN_ID}/plan-b.json`,
        path: `/project/.rundown/work/.rd-ctx-a/${ARTIFACT_RUN_ID}/plan-b.json`,
      }),
    ]);
  });

  it('uses state WorkPath when rendering artifact status paths', () => {
    const artifact = brandTrustedArtifactRecordForTest({
      kind: 'artifact-record',
      uri: `rd://artifacts/ctx-a/${ARTIFACT_RUN_ID}/plan.json`,
      runId: ARTIFACT_RUN_ID,
      contextId: 'ctx-a',
      runbook: { source: 'project', path: 'producer.runbook.md' },
      key: 'plan.json',
      timestamp: '2026-05-25T00:00:00.000Z',
    });
    const state = makeState({
      templateVars: brandInitialTemplateVarsForTest({ WorkPath: '.custom/work' }),
      variables: brandStoredOutputsForTest({ PlanPath: artifact }),
    });

    jest.mocked(getRunbookFromState).mockReturnValue([makeStep()]);
    jest.mocked(buildMetadata).mockReturnValue({
      file: 'test.runbook.md',
      runbookId: 'test-id',
    });

    const result = buildActiveStatus(state, '/project');

    expect(result.vars?.PlanPath).toBe(
      `/project/.custom/work/.rd-ctx-a/${ARTIFACT_RUN_ID}/plan.json`,
    );
    expect(result.artifacts?.PlanPath).toEqual(
      expect.objectContaining({
        path: `/project/.custom/work/.rd-ctx-a/${ARTIFACT_RUN_ID}/plan.json`,
      }),
    );
  });

  it('redacts artifacts in stashed status for a caller-scoped child', () => {
    const artifact = brandTrustedArtifactRecordForTest({
      kind: 'artifact-record',
      uri: `rd://artifacts/ctx-a/${ARTIFACT_RUN_ID}/plan.json`,
      runId: ARTIFACT_RUN_ID,
      contextId: 'ctx-a',
      runbook: { source: 'project', path: 'producer.runbook.md' },
      key: 'plan.json',
      timestamp: '2026-05-25T00:00:00.000Z',
    });
    const state = makeState({
      parentLinkage: {
        kind: 'delegation',
        tokenHash: brandDelegationTokenHashForTest(
          'sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
        ),
        parentRunId: SECOND_PARENT_RUN_ID,
        parentStepId: '2.1',
        parentStep: '2',
        parentFrameKey: brandFrameKeyForTest('2'),
        parentEntry: 1,
      },
      variables: brandStoredOutputsForTest({ PlanPath: artifact }),
    });

    const result = buildStashedStatus(state, '/project');

    // Caller-scoped (parentLinkage set) → artifacts redacted alongside vars.
    expect(result.artifacts).toBeUndefined();
    expect(result.vars).toBeUndefined();
  });

  it('surfaces artifacts in stashed status when no parentLinkage is set', () => {
    const artifact = brandTrustedArtifactRecordForTest({
      kind: 'artifact-record',
      uri: `rd://artifacts/ctx-a/${ARTIFACT_RUN_ID}/plan.json`,
      runId: ARTIFACT_RUN_ID,
      contextId: 'ctx-a',
      runbook: { source: 'project', path: 'producer.runbook.md' },
      key: 'plan.json',
      timestamp: '2026-05-25T00:00:00.000Z',
    });
    const state = makeState({
      variables: brandStoredOutputsForTest({ PlanPath: artifact }),
    });

    const result = buildStashedStatus(state, '/project');

    expect(result.parentLinkage).toBeUndefined();
    expect(result.artifacts?.PlanPath).toEqual(
      expect.objectContaining({
        kind: 'artifact-record',
        path: `/project/.rundown/work/.rd-ctx-a/${ARTIFACT_RUN_ID}/plan.json`,
      }),
    );
  });

  it('renders a file-artifact-record path in the artifacts projection', () => {
    const artifact = brandTrustedArtifactRecordForTest({
      kind: 'file-artifact-record',
      uri: 'file:///tmp/project/schemas/review.schema.json',
      runId: ARTIFACT_RUN_ID,
      contextId: 'ctx-a',
      runbook: { source: 'project', path: 'producer.runbook.md' },
      key: 'schemas/review.schema.json',
      timestamp: '2026-05-25T00:00:00.000Z',
    });
    const state = makeState({
      variables: brandStoredOutputsForTest({ SchemaPath: artifact }),
    });

    const result = buildActiveStatus(state, '/project');

    expect(result.artifacts?.SchemaPath).toEqual(
      expect.objectContaining({
        kind: 'file-artifact-record',
        path: '/tmp/project/schemas/review.schema.json',
      }),
    );
  });

  it('returns undefined vars when both templateVars and variables are empty', () => {
    const state = makeState({
      templateVars: brandInitialTemplateVarsForTest(),
      variables: brandStoredOutputsForTest(),
    });
    const result = buildActiveStatus(state, '/project');
    expect(result.vars).toBeUndefined();
  });

  it('buildStashedStatus also includes vars field', () => {
    const state = makeState({
      templateVars: brandInitialTemplateVarsForTest({ environment: 'staging' }),
      variables: brandStoredOutputsForTest({ PlanPath: '/work/plan.json' }),
    });
    const result = buildStashedStatus(state, '/project');
    expect(result.vars).toEqual({
      environment: 'staging',
      PlanPath: '/work/plan.json',
    });
  });
});

describe('mergeEffectiveVars mock contract', () => {
  // Direct gate against mock drift: the mock must match production's
  // (state, extraVars?) signature with precedence templateVars < variables < extraVars.
  // See packages/core/src/runbook/effective-vars.ts:mergeEffectiveVars.
  it('applies precedence extraVars > variables > templateVars', () => {
    const state = {
      templateVars: { key: 'from-templateVars', tOnly: 't' },
      variables: { key: 'from-variables', vOnly: 'v' },
    };
    const extraVars = { key: 'from-extraVars', eOnly: 'e' };
    const merged = (
      core.mergeEffectiveVars as unknown as (
        s: typeof state,
        e?: typeof extraVars,
      ) => Record<string, unknown>
    )(state, extraVars);
    expect(merged).toEqual({
      key: 'from-extraVars',
      tOnly: 't',
      vOnly: 'v',
      eOnly: 'e',
    });
  });
});
